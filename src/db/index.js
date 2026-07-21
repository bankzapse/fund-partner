import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../lib/time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/**
 * ระบบใช้ PostgreSQL เพียง dialect เดียวทั้งหมด
 *   - production : Supabase (ผ่าน `pg`) เมื่อกำหนด DATABASE_URL
 *   - dev / test : PGlite (PostgreSQL จริงคอมไพล์เป็น WASM) ไม่ต้องติดตั้งอะไรเพิ่ม
 * SQL ที่เขียนครั้งเดียวจึงใช้ได้ทั้งสองที่ และทดสอบได้ตรงกับของจริง
 */
export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

export function isServerless() {
  return Boolean(process.env.VERCEL);
}

/**
 * ตัดสินใจว่าต้องใช้ SSL หรือไม่
 * ฐานข้อมูลบนคลาวด์ต้องใช้เสมอ ส่วนเครื่องตัวเองหรือที่สั่ง sslmode=disable ไว้ไม่ต้อง
 */
export function useSsl(url) {
  try {
    const u = new URL(url);
    const mode = u.searchParams.get('sslmode');
    if (mode === 'disable') return false;
    if (mode) return true;
    return !['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch {
    return true; // อ่าน URL ไม่ออก ให้ปลอดภัยไว้ก่อน
  }
}

/** ที่เก็บข้อมูลของ PGlite เมื่อรันในเครื่อง (':memory:' สำหรับเทสต์) */
export function pgliteDir() {
  return process.env.FP_DB_PATH || join(ROOT, 'data', 'pgdata');
}

let _ready = null;

async function createDriver() {
  const url = databaseUrl();

  // บน Serverless ระบบไฟล์เป็นแบบชั่วคราวและหายทุก request
  // ถ้าปล่อยให้ใช้ PGlite ต่อ ข้อมูลการเงินจะหายโดยไม่มีสัญญาณเตือน จึงต้องหยุดทันที
  if (!url && isServerless()) {
    throw new Error(
      'ยังไม่ได้ตั้งค่า DATABASE_URL — ระบบต้องเชื่อมต่อฐานข้อมูล PostgreSQL (Supabase) ก่อนใช้งานบน Vercel ' +
        'ตั้งค่าได้ที่ Vercel > Project > Settings > Environment Variables',
    );
  }

  if (url) {
    const { default: pg } = await import('pg');
    // Supabase ต้องเชื่อมต่อผ่าน SSL — ปิดเฉพาะเมื่อต่อเครื่องตัวเองหรือสั่งปิดชัดเจน
    const pool = new pg.Pool({
      connectionString: url,
      ssl: useSsl(url) ? { rejectUnauthorized: false } : false,
      max: isServerless() ? 1 : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    return {
      kind: 'pg',
      pool,
      query: (text, values) => pool.query(text, values),
      // simple query protocol รองรับหลายคำสั่งได้เมื่อไม่มีพารามิเตอร์
      execScript: (text) => pool.query(text),
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const dir = pgliteDir();
  if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
  const lite = dir === ':memory:' ? new PGlite() : new PGlite(dir);
  await lite.waitReady;
  return {
    kind: 'pglite',
    pool: null,
    query: (text, values) => lite.query(text, values ?? []),
    // PGlite ต้องใช้ exec() สำหรับสคริปต์ที่มีหลายคำสั่ง
    execScript: (text) => lite.exec(text),
    close: () => lite.close(),
  };
}

/** เตรียมการเชื่อมต่อและสร้างตาราง (เรียกซ้ำได้ ทำงานจริงครั้งเดียว) */
export function db() {
  if (!_ready) {
    _ready = (async () => {
      const driver = await createDriver();
      await driver.execScript(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
      return driver;
    })().catch((err) => {
      _ready = null; // ให้ลองใหม่ได้ถ้าเชื่อมต่อไม่ติด
      throw err;
    });
  }
  return _ready;
}

export async function closeDb() {
  if (_ready) {
    const driver = await _ready.catch(() => null);
    if (driver) await driver.close();
  }
  _ready = null;
}

export async function driverKind() {
  return (await db()).kind;
}

/**
 * แปลง SQL ที่เขียนด้วยพารามิเตอร์แบบชื่อ (:name) เป็นแบบลำดับของ PostgreSQL ($1, $2, ...)
 * ทำให้ SQL อ่านง่ายและไม่ต้องนับลำดับเอง
 * พารามิเตอร์ที่ไม่ได้ถูกใช้ใน SQL จะถูกตัดทิ้ง เพราะหลาย query ประกอบเงื่อนไขแบบมีเงื่อนไข
 */
export function toPositional(sql, params = {}) {
  const values = [];
  const seen = new Map();
  // ข้ามข้อความใน single quote และ cast แบบ ::type เพื่อไม่ให้จับผิดเป็นชื่อพารามิเตอร์
  const text = sql.replace(/'[^']*'|::[A-Za-z_]+|:([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
    if (!name) return match;
    if (!seen.has(name)) {
      const value = params[name];
      values.push(value === undefined ? null : value);
      seen.set(name, values.length);
    }
    return `$${seen.get(name)}`;
  });
  return { text, values };
}

async function exec(sql, params) {
  const driver = await db();
  const { text, values } = toPositional(sql, params);
  return driver.query(text, values);
}

export async function all(sql, params = {}) {
  const res = await exec(sql, params);
  return normalizeRows(res.rows, res.fields);
}

export async function get(sql, params = {}) {
  const res = await exec(sql, params);
  const rows = normalizeRows(res.rows, res.fields);
  return rows.length ? rows[0] : null;
}

export async function run(sql, params = {}) {
  const res = await exec(sql, params);
  return { rowCount: res.rowCount ?? 0 };
}

/** INSERT ที่คืนค่า id ของแถวใหม่ (แทน lastInsertRowid ของ SQLite) */
export async function insert(sql, params = {}) {
  const res = await exec(`${sql.trimEnd().replace(/;$/, '')} RETURNING id`, params);
  return Number(res.rows[0].id);
}

/**
 * ชนิดคอลัมน์ของ PostgreSQL ที่ไดรเวอร์ส่งกลับมาเป็น string
 *   20   = int8 (BIGINT)  — คอลัมน์เงินทั้งหมดและผลลัพธ์ COUNT()
 *   1700 = numeric        — ผลลัพธ์ SUM() ของ BIGINT
 * แปลงตาม "ชนิดจริงที่ฐานข้อมูลบอกมา" ไม่ใช่เดาจากชื่อคอลัมน์
 * เพราะการเดาจากชื่อจะพลาดทันทีที่มี alias ใหม่ แล้วตัวเลขเงินจะกลายเป็น
 * สตริงเงียบ ๆ ทำให้การบวกกลายเป็นการต่อข้อความ
 */
const STRING_NUMERIC_TYPES = new Set([20, 1700]);

/**
 * แปลงค่าที่เป็นตัวเลขให้เป็น number ตามชนิดคอลัมน์จริง
 * ถ้าจำนวนใหญ่เกินกว่าที่ JavaScript เก็บได้แม่นยำ จะโยน error ทันที
 * เพราะการปัดเศษเงียบ ๆ ในระบบการเงินอันตรายกว่าการหยุดทำงาน
 */
function normalizeRows(rows, fields) {
  if (!rows.length) return rows;

  const numericCols = [];
  for (const f of fields ?? []) {
    if (STRING_NUMERIC_TYPES.has(f.dataTypeID)) numericCols.push(f.name);
  }
  if (!numericCols.length) return rows.map((r) => ({ ...r }));

  return rows.map((row) => {
    const out = { ...row };
    for (const col of numericCols) {
      const v = out[col];
      if (v === null || v === undefined) continue;
      if (typeof v === 'number') continue;
      if (typeof v === 'bigint') {
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new Error(`ค่า ${col} ใหญ่เกินกว่าที่ระบบจะคำนวณได้แม่นยำ: ${v}`);
        }
        out[col] = Number(v);
        continue;
      }
      if (typeof v === 'string') {
        if (!/^-?\d+$/.test(v)) continue; // เช่น numeric ที่มีทศนิยม ปล่อยไว้ตามเดิม
        const n = Number(v);
        if (!Number.isSafeInteger(n)) {
          throw new Error(`ค่า ${col} ใหญ่เกินกว่าที่ระบบจะคำนวณได้แม่นยำ: ${v}`);
        }
        out[col] = n;
      }
    }
    return out;
  });
}

/**
 * ครอบการทำงานด้วย Transaction — บังคับใช้กับการรับชำระและรียอด
 * เพื่อป้องกันยอดค้างผิดเมื่อทำงานพร้อมกันหลายคน (SRS ข้อ 19)
 *
 * ฝั่ง pg ต้องจอง client เดียวไว้ตลอด ไม่งั้น BEGIN กับ COMMIT อาจไปคนละ connection
 */
export async function tx(fn) {
  const driver = await db();

  if (!driver.pool) {
    // PGlite เป็น connection เดียวอยู่แล้ว
    await driver.query('BEGIN');
    try {
      const result = await fn();
      await driver.query('COMMIT');
      return result;
    } catch (err) {
      await driver.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  const client = await driver.pool.connect();
  const previous = driver.query;
  driver.query = (text, values) => client.query(text, values);
  try {
    await client.query('BEGIN');
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    driver.query = previous;
    client.release();
  }
}

/**
 * ออกเลขเอกสารแบบต่อเนื่อง กันเลขซ้ำแม้ใช้งานพร้อมกัน (SRS ข้อ 14)
 * UPDATE ... RETURNING จะล็อกแถวให้อัตโนมัติใน PostgreSQL
 */
export async function nextCounter(name) {
  await run(
    `INSERT INTO counters (name, value) VALUES (:name, 0)
     ON CONFLICT (name) DO NOTHING`,
    { name },
  );
  const row = await get(
    `UPDATE counters SET value = value + 1 WHERE name = :name RETURNING value`,
    { name },
  );
  return Number(row.value);
}

// ---- settings ---------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  doc_fee: '10000', // ค่าทำเอกสาร 100.00 บาท (สตางค์) — แก้ไขได้จากหน้าตั้งค่า (ข้อ 7.2)
  deduct_first_installment: '1',
  reyod_cash_basis: 'new_money', // new_money | full  (ข้อ 9 ข้อกำหนดสำคัญ)
  session_timeout_minutes: '120',
  daily24_default_installment: '5000',
  daily24_default_interest: '2000',
  daily24_default_periods: '24',
  overdue_days_threshold: '3',
  company_name: 'พันธมิตรเงินทุน',
  // แพ็กเกจราคาที่แสดงบนหน้าแนะนำระบบ (SEO) — แก้ได้จากหน้าตั้งค่า ไม่ต้องแก้โค้ด
  // ราคาชุดนี้เป็นเพียงค่าตั้งต้น ต้องเปลี่ยนเป็นราคาจริงก่อนโปรโมต
  pricing_heading: 'แพ็กเกจการใช้งาน',
  pricing_subheading: 'จ่ายต่อกิจการ เปิดใช้ได้หลายเครื่องและหลายมือถือ ไม่คิดรายเครื่อง',
  pricing_note: '',
  pricing_plans: JSON.stringify([
      {
          "name": "ทดลองใช้",
          "price": "฿0",
          "per": "/ 14 วัน",
          "features": [
              "ใช้ได้ครบทุกฟีเจอร์",
              "ไม่ต้องผูกบัตร",
              "เริ่มคีย์สัญญาแรกได้ทันที"
          ],
          "cta": "เริ่มทดลองฟรี",
          "best": false
      },
      {
          "name": "เริ่มต้น",
          "price": "฿390",
          "per": "/ เดือน",
          "features": [
              "ผู้ใช้ 7 คน",
              "ลูกหนี้ไม่จำกัด",
              "สัญญา 50 ฉบับ"
          ],
          "cta": "เลือกแพ็กเกจนี้",
          "best": false
      },
      {
          "name": "มาตรฐาน",
          "price": "฿790",
          "per": "/ เดือน",
          "features": [
              "ผู้ใช้ 10 คน",
              "ลูกหนี้ไม่จำกัด",
              "สัญญา 200 ฉบับ"
          ],
          "cta": "เลือกแพ็กเกจนี้",
          "best": true
      },
      {
          "name": "ไม่จำกัด",
          "price": "฿1,990",
          "per": "/ เดือน",
          "features": [
              "ผู้ใช้ไม่จำกัด",
              "ลูกหนี้ไม่จำกัด",
              "สัญญาไม่จำกัด"
          ],
          "cta": "เลือกแพ็กเกจนี้",
          "best": false
      }
  ]),
  expense_categories: JSON.stringify([
    'เงินปล่อยใหม่/เงินสดจ่ายให้ลูกค้า',
    'ถอนเงินทุน/เงินปันผลเจ้าของ',
    'เงินเดือน/ค่าแรง',
    'คอมมิชชั่นพนักงาน',
    'ค่าน้ำมัน',
    'ค่าทางด่วน',
    'ค่าจอดรถ',
    'อุปกรณ์สำนักงาน',
    'ค่าเช่า',
    'ค่าน้ำ-ค่าไฟ',
    'อินเทอร์เน็ต/โทรศัพท์',
    'ค่าใช้จ่ายอื่น',
  ]),
  income_categories: JSON.stringify(['ค่าธรรมเนียมอื่น', 'รายรับอื่น']),
};

/** หมวดรายจ่ายที่ระบบใช้บันทึกเงินสดจ่ายให้ลูกค้าโดยอัตโนมัติ (ข้อ 14) */
export const DISBURSE_CATEGORY = 'เงินปล่อยใหม่/เงินสดจ่ายให้ลูกค้า';

/**
 * หมวดที่เป็น "การเคลื่อนไหวของเงินทุน" ไม่ใช่รายได้หรือค่าใช้จ่ายดำเนินงาน
 * จึงไม่ถูกนำไปคำนวณกำไรสุทธิ (สอดคล้องกับเกณฑ์ข้อ 18)
 */
export const CAPITAL_OUT_CATEGORY = 'ถอนเงินทุน/เงินปันผลเจ้าของ';
export const CAPITAL_IN_CATEGORY = 'capital';

export async function getSetting(key) {
  const row = await get(`SELECT value FROM settings WHERE key = :key`, { key });
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? null);
}

export async function getSettingInt(key) {
  const v = await getSetting(key);
  return v === null ? 0 : parseInt(v, 10);
}

export async function getAllSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of await all(`SELECT key, value FROM settings`)) out[row.key] = row.value;
  return out;
}

export async function setSetting(key, value, userId) {
  await run(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (:key, :value, :uid, :now)
     ON CONFLICT (key) DO UPDATE SET value = :value, updated_by = :uid, updated_at = :now`,
    { key, value: String(value), uid: userId ?? null, now: nowISO() },
  );
}
