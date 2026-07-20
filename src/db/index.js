import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../lib/time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/**
 * อ่านค่าตอนเรียกใช้ ไม่ใช่ตอน import
 * เพื่อให้ชุดทดสอบตั้ง FP_DB_PATH=':memory:' ได้ทัน (ESM hoist การ import ขึ้นก่อนเสมอ)
 */
export function dbPath() {
  return process.env.FP_DB_PATH || join(ROOT, 'data', 'fund-partner.sqlite');
}

let _db = null;

export function db() {
  if (_db) return _db;
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  _db = new DatabaseSync(path);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec('PRAGMA busy_timeout = 5000;');
  _db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  return _db;
}

/** ปิดการเชื่อมต่อ (ใช้ในเทสต์) */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * คัดเฉพาะพารามิเตอร์ที่ปรากฏใน SQL จริง
 * เพราะหลาย query ประกอบเงื่อนไขแบบมีเงื่อนไข (เช่น กรองตามพนักงานเฉพาะบางกรณี)
 * และ node:sqlite จะโยน error ถ้าส่งพารามิเตอร์ที่ไม่ถูกใช้
 */
function bindable(sql, params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (new RegExp(`[:@$]${key}\\b`).test(sql)) out[key] = value === undefined ? null : value;
  }
  return out;
}

export function all(sql, params = {}) {
  return db().prepare(sql).all(bindable(sql, params));
}

export function get(sql, params = {}) {
  return db().prepare(sql).get(bindable(sql, params)) ?? null;
}

export function run(sql, params = {}) {
  return db().prepare(sql).run(bindable(sql, params));
}

/**
 * ครอบการทำงานด้วย Transaction — บังคับใช้กับการรับชำระและรียอด
 * เพื่อป้องกันยอดค้างผิดเมื่อทำงานพร้อมกันหลายคน (SRS ข้อ 19)
 */
export function tx(fn) {
  const conn = db();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * ออกเลขเอกสารแบบต่อเนื่อง กันเลขซ้ำแม้ใช้งานพร้อมกัน (SRS ข้อ 14)
 * ต้องเรียกภายใน transaction
 */
export function nextCounter(name) {
  run(
    `INSERT INTO counters (name, value) VALUES (:name, 0)
     ON CONFLICT(name) DO NOTHING`,
    { name },
  );
  run(`UPDATE counters SET value = value + 1 WHERE name = :name`, { name });
  return get(`SELECT value FROM counters WHERE name = :name`, { name }).value;
}

// ---- settings ---------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  doc_fee: '10000', // ค่าทำเอกสาร 100.00 บาท (สตางค์) — แก้ไขได้จากหน้าตั้งค่า (ข้อ 7.2)
  deduct_first_installment: '1', // หักงวดแรก ณ วันทำสัญญา
  reyod_cash_basis: 'new_money', // new_money | full  (ข้อ 9 ข้อกำหนดสำคัญ)
  session_timeout_minutes: '120', // ข้อ 15
  daily24_default_installment: '5000', // ค่างวด 50.00 บาท
  daily24_default_interest: '2000', // ดอกเบี้ย 20.00 บาท
  daily24_default_periods: '24',
  overdue_days_threshold: '3', // ค้างชำระเกินกี่วันจึงเปลี่ยนสถานะลูกหนี้
  company_name: 'พันธมิตรเงินทุน',
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

export function getSetting(key) {
  const row = get(`SELECT value FROM settings WHERE key = :key`, { key });
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? null);
}

export function getSettingInt(key) {
  const v = getSetting(key);
  return v === null ? 0 : parseInt(v, 10);
}

export function getAllSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of all(`SELECT key, value FROM settings`)) out[row.key] = row.value;
  return out;
}

export function setSetting(key, value, userId) {
  run(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES (:key, :value, :uid, :now)
     ON CONFLICT(key) DO UPDATE SET value = :value, updated_by = :uid, updated_at = :now`,
    { key, value: String(value), uid: userId ?? null, now: nowISO() },
  );
}
