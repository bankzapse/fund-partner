// ส่องดูว่าในฐานข้อมูลมีอะไรอยู่ และโครงสร้างตรงกับที่โปรแกรมต้องการไหม
//
// เรียกผ่าน scripts/inspect-db.sh
//
// อ่านอย่างเดียว 100% ไม่สร้าง ไม่แก้ ไม่ลบอะไรทั้งสิ้น
// ใช้ตอนไม่แน่ใจว่าต่อไปโปรเจกต์ไหน หรือทำไมโปรแกรมฟ้องว่าไม่มีคอลัมน์

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  head: (s) => `\x1b[1;34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const say = (s = '') => stdout.write(s + '\n');
const ok = (s) => say('  ' + C.ok('✓') + ' ' + s);
const bad = (s) => say('  ' + C.bad('✗') + ' ' + s);
const info = (s) => say('  ' + C.warn('·') + ' ' + s);

let rl = null;
function askHidden(q) {
  return new Promise((resolve) => {
    rl = createInterface({ input: stdin, output: stdout });
    const origWrite = rl.output.write.bind(rl.output);
    rl.output.write = (chunk, ...rest) => (rl.output.muted ? true : origWrite(chunk, ...rest));
    const onData = (ch) => { if (ch[0] === 0x03) { stdout.write('\n'); process.exit(130); } };
    stdin.on('data', onData);
    stdout.write(q);
    rl.output.muted = true;
    rl.question('', (a) => {
      rl.output.muted = false;
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(a.trim());
    });
  });
}

/** ดึงรายชื่อตารางและคอลัมน์ที่โปรแกรมคาดหวัง จากไฟล์ schema.sql */
function expectedSchema() {
  const sql = readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8');
  const tables = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const [, name, body] = m;
    tables[name] = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--') && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l))
      .map((l) => l.split(/\s+/)[0])
      .filter((c) => /^[a-z_]+$/.test(c));
  }
  return tables;
}

async function main() {
  say();
  say(C.head('▸ ส่องดูฐานข้อมูล (อ่านอย่างเดียว ไม่แก้อะไร)'));
  say();

  const DB_URL = process.env.DATABASE_URL
    || await askHidden('  วาง connection string (จะไม่ขึ้นบนจอ): ');
  if (!DB_URL) { bad('ไม่ได้ใส่อะไรมา'); process.exit(1); }

  let host = '(อ่านไม่ออก)';
  let projectRef = '(ไม่ทราบ)';
  try {
    const u = new URL(DB_URL);
    host = u.hostname;
    // รหัสโปรเจกต์อยู่ในชื่อผู้ใช้ (postgres.xxxx) หรือในโฮสต์ (db.xxxx.supabase.co)
    projectRef = decodeURIComponent(u.username).split('.')[1]
      || (host.match(/^db\.([a-z0-9]+)\./)?.[1] ?? '(ไม่ทราบ)');
  } catch { /* ปล่อยผ่าน */ }

  const pool = new pg.Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });

  const lines = [];
  const record = (s) => { lines.push(s.replace(/\x1b\[[0-9;]*m/g, '')); };

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    bad('ต่อไม่ได้: ' + err.message);
    await pool.end(); rl?.close(); process.exit(1);
  }

  ok(`ต่อได้ — โฮสต์ ${host}`);
  say(`     รหัสโปรเจกต์ ${C.head(projectRef)}  ${C.dim('← ตรวจว่าตรงกับโปรเจกต์ที่มีข้อมูลจริง')}`);
  record(`โฮสต์: ${host}`);
  record(`รหัสโปรเจกต์: ${projectRef}`);

  // ---- ตารางที่มีอยู่จริง -----------------------------------------------
  const actual = {};
  const rows = (await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`,
  )).rows;
  for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);

  const expected = expectedSchema();
  const expectedNames = Object.keys(expected);

  say();
  say(C.head('  ตารางที่โปรแกรมต้องการ'));
  say();
  record('');
  record('ตาราง:');

  let missingTables = 0;
  let mismatched = 0;

  for (const t of expectedNames) {
    if (!actual[t]) {
      bad(`${t.padEnd(20)} ไม่มีตารางนี้`);
      record(`  ${t}: ไม่มี`);
      missingTables++;
      continue;
    }
    const missingCols = expected[t].filter((c) => !actual[t].includes(c));
    let count = '?';
    try {
      count = (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
    } catch { /* อ่านไม่ได้ */ }

    if (missingCols.length) {
      bad(`${t.padEnd(20)} ${String(count).padStart(6)} แถว  ${C.bad('ขาดคอลัมน์: ' + missingCols.join(', '))}`);
      record(`  ${t}: ${count} แถว — ขาดคอลัมน์ ${missingCols.join(', ')}`);
      mismatched++;
    } else {
      ok(`${t.padEnd(20)} ${String(count).padStart(6)} แถว`);
      record(`  ${t}: ${count} แถว`);
    }
  }

  // ตารางแปลกปลอมที่โปรแกรมไม่รู้จัก
  const extra = Object.keys(actual).filter((t) => !expectedNames.includes(t));
  if (extra.length) {
    say();
    info(`ตารางอื่นที่ไม่ใช่ของระบบนี้: ${extra.join(', ')}`);
    record(`ตารางอื่น: ${extra.join(', ')}`);
  }

  // ---- สรุป --------------------------------------------------------------
  say();
  say(C.head('  สรุป'));
  say();

  const hasData = expectedNames.some((t) => actual[t] && ['debtors', 'contracts', 'payments'].includes(t));
  let debtorCount = 0;
  if (actual.debtors) {
    try { debtorCount = (await pool.query('SELECT count(*)::int n FROM debtors')).rows[0].n; } catch { /* ข้าม */ }
  }

  if (missingTables === expectedNames.length) {
    info('ฐานข้อมูลว่างเปล่า ยังไม่เคยสร้างตาราง');
    info('ระบบจะสร้างให้เองเมื่อเปิดเว็บครั้งแรก — ไม่ต้องทำอะไร');
    record('สถานะ: ว่างเปล่า');
  } else if (mismatched || missingTables) {
    bad(`โครงสร้างไม่ตรงกับโปรแกรม (ขาดตาราง ${missingTables} · คอลัมน์ไม่ครบ ${mismatched} ตาราง)`);
    say();
    say('     ' + C.warn('สาเหตุที่พบบ่อย: ตารางถูกสร้างไว้ตั้งแต่โปรแกรมเวอร์ชันเก่า'));
    say('     ' + C.warn('คำสั่งสร้างตารางจะไม่แก้ตารางที่มีอยู่แล้ว จึงขาดคอลัมน์ใหม่'));
    say();
    if (debtorCount > 0) {
      say('     ' + C.bad(`⚠ มีข้อมูลลูกหนี้ ${debtorCount} ราย — อย่าเพิ่งลบตาราง`));
      say('       ส่งรายงานนี้ให้ผู้ดูแลระบบดูก่อนตัดสินใจ');
    } else {
      say('     ไม่มีข้อมูลลูกหนี้ในฐานข้อมูลนี้ ถ้าแน่ใจว่าไม่ใช่ของจริง');
      say('     ล้างแล้วให้ระบบสร้างใหม่ได้ด้วย scripts/rebuild-schema.sh');
    }
    record(`สถานะ: โครงสร้างไม่ตรง (ขาดตาราง ${missingTables} · คอลัมน์ไม่ครบ ${mismatched})`);
  } else {
    ok('โครงสร้างครบถ้วน ตรงกับโปรแกรมทุกตาราง');
    record('สถานะ: โครงสร้างครบถ้วน');
  }

  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  const path = join(ROOT, 'reports/db-inspect.txt');
  writeFileSync(path, ['รายงานการส่องฐานข้อมูล', ...lines,
    '', '(ไม่มีรหัสผ่านและไม่มี connection string ในไฟล์นี้)'].join('\n'));
  say();
  ok(`เขียนรายงานแล้ว → reports/db-inspect.txt`);
  info('ไฟล์นี้ไม่มีรหัสผ่าน ส่งให้ผู้ดูแลระบบดูได้');

  await pool.end();
  rl?.close();
}

main().catch((err) => {
  bad('เกิดข้อผิดพลาด: ' + err.message);
  rl?.close();
  process.exit(1);
});
