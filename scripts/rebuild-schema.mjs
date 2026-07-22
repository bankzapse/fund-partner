// ลบตารางของระบบทิ้งแล้วให้สร้างใหม่จากโครงสร้างล่าสุด
//
// เรียกผ่าน scripts/rebuild-schema.sh
//
// ใช้เมื่อ scripts/inspect-db.sh บอกว่าโครงสร้างไม่ตรงกับโปรแกรม
// ซึ่งมักเกิดจากตารางถูกสร้างไว้ตั้งแต่โปรแกรมเวอร์ชันเก่า
// เพราะคำสั่ง CREATE TABLE IF NOT EXISTS จะไม่แก้ตารางที่มีอยู่แล้ว
//
// กันพลาดไว้ 3 ชั้น:
// 1) สำรองข้อมูลลงเครื่องก่อนเสมอ ถ้าสำรองไม่สำเร็จจะไม่ลบอะไรเลย
// 2) ถ้ามีข้อมูลลูกหนี้หรือสัญญาอยู่ ต้องพิมพ์ยืนยันยาวกว่าปกติ
// 3) ลบเฉพาะตารางของระบบนี้ ไม่แตะตารางอื่นในฐานข้อมูลเดียวกัน

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
function getRl() {
  if (rl) return rl;
  rl = createInterface({ input: stdin, output: stdout });
  const origWrite = rl.output.write.bind(rl.output);
  rl.output.write = (chunk, ...rest) => (rl.output.muted ? true : origWrite(chunk, ...rest));
  return rl;
}
const ask = (q) => new Promise((r) => getRl().question(q, (a) => r(a.trim())));
function askHidden(q) {
  return new Promise((resolve) => {
    const r = getRl();
    const onData = (ch) => { if (ch[0] === 0x03) { stdout.write('\n'); process.exit(130); } };
    stdin.on('data', onData);
    stdout.write(q);
    r.output.muted = true;
    r.question('', (a) => {
      r.output.muted = false;
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(a.trim());
    });
  });
}

/** ชื่อตารางทั้งหมดที่ระบบนี้เป็นเจ้าของ อ่านจากไฟล์โครงสร้างจริง */
function ownTables() {
  const sql = readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8');
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
}

async function main() {
  say();
  say(C.head('▸ สร้างโครงสร้างตารางใหม่'));
  say();
  say(C.dim('  ใช้เมื่อโครงสร้างในฐานข้อมูลไม่ตรงกับโปรแกรม'));
  say(C.dim('  สำรองข้อมูลให้ก่อนเสมอ และลบเฉพาะตารางของระบบนี้'));
  say();

  const DB_URL = process.env.DATABASE_URL
    || await askHidden('  วาง connection string (จะไม่ขึ้นบนจอ): ');
  if (!DB_URL) { bad('ไม่ได้ใส่อะไรมา'); process.exit(1); }

  const pool = new pg.Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });

  try {
    await pool.query('SELECT 1');
    ok('ต่อได้');
  } catch (err) {
    bad('ต่อไม่ได้: ' + err.message);
    await pool.end(); rl?.close(); process.exit(1);
  }

  const tables = ownTables();
  const existing = (await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables],
  )).rows.map((r) => r.table_name);

  // ---- นับข้อมูลสำคัญก่อนตัดสินใจ ----------------------------------------
  const counts = {};
  for (const t of existing) {
    try { counts[t] = (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n; }
    catch { counts[t] = 0; }
  }
  const withRows = existing.filter((t) => counts[t] > 0);
  const precious = ['debtors', 'contracts', 'payments'].reduce((s, t) => s + (counts[t] ?? 0), 0);

  say();
  if (!existing.length) {
    info('ยังไม่มีตารางของระบบนี้เลย ไม่ต้องลบอะไร');
    info('เปิดเว็บครั้งแรกแล้วระบบจะสร้างตารางให้เอง');
    await pool.end(); rl?.close(); return;
  }

  say(C.head('  ตารางที่จะถูกลบแล้วสร้างใหม่'));
  say();
  for (const t of existing) {
    const n = counts[t];
    say(`     ${t.padEnd(20)} ${String(n).padStart(6)} แถว${n > 0 ? C.warn('  ← มีข้อมูล') : ''}`);
  }

  // ---- สำรองก่อนเสมอ -----------------------------------------------------
  say();
  let backupPath = null;
  if (withRows.length) {
    const dump = { exported_at: new Date().toISOString(), tables: {} };
    for (const t of existing) {
      try { dump.tables[t] = (await pool.query(`SELECT * FROM ${t}`)).rows; }
      catch (err) { bad(`สำรอง ${t} ไม่ได้: ${err.message}`); await pool.end(); rl?.close(); process.exit(1); }
    }
    mkdirSync(join(ROOT, 'backups'), { recursive: true });
    backupPath = join(ROOT, `backups/ก่อนสร้างใหม่-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(backupPath, JSON.stringify(dump, null, 2));
    ok(`สำรองแล้ว → ${backupPath.replace(ROOT + '/', '')}`);
  } else {
    info('ทุกตารางว่างเปล่า ไม่มีอะไรต้องสำรอง');
  }

  // ---- ยืนยัน ------------------------------------------------------------
  say();
  if (precious > 0) {
    say('  ' + C.bad(`⚠ มีข้อมูลลูกหนี้/สัญญา/การชำระ รวม ${precious} รายการ`));
    say('  ' + C.bad('  การลบนี้กู้คืนจากในระบบไม่ได้ มีแต่ไฟล์สำรองที่เพิ่งสร้าง'));
    say();
    const phrase = 'ยืนยันลบข้อมูลจริงทั้งหมด';
    const a = await ask(`  พิมพ์ "${phrase}" เพื่อยืนยัน (อย่างอื่น = ยกเลิก): `);
    if (a !== phrase) { info('ยกเลิกแล้ว ไม่มีอะไรเปลี่ยน'); await pool.end(); rl?.close(); return; }
  } else {
    const a = await ask('  พิมพ์ "สร้างใหม่" เพื่อยืนยัน (อย่างอื่น = ยกเลิก): ');
    if (a !== 'สร้างใหม่') { info('ยกเลิกแล้ว ไม่มีอะไรเปลี่ยน'); await pool.end(); rl?.close(); return; }
  }

  // ---- ลบแล้วสร้างใหม่ ---------------------------------------------------
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // CASCADE เพื่อให้ลบได้แม้มี foreign key โยงกันอยู่
    // ใส่ชื่อตารางในเครื่องหมายคำพูดกันชื่อชนคำสงวน
    await client.query(`DROP TABLE IF EXISTS ${existing.map((t) => `"${t}"`).join(', ')} CASCADE`);
    await client.query(readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8'));
    await client.query('COMMIT');
    ok('สร้างโครงสร้างใหม่เรียบร้อย');
  } catch (err) {
    await client.query('ROLLBACK');
    bad('ไม่สำเร็จ ย้อนกลับทั้งหมดแล้ว ไม่มีอะไรเปลี่ยน: ' + err.message);
    client.release(); await pool.end(); rl?.close(); process.exit(1);
  } finally {
    client.release();
  }

  // ---- ตรวจผล ------------------------------------------------------------
  const after = (await pool.query(
    `SELECT count(*)::int n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables],
  )).rows[0].n;
  const rls = (await pool.query(
    `SELECT count(*)::int n FROM pg_tables
     WHERE schemaname = 'public' AND rowsecurity = true AND tablename = ANY($1)`,
    [tables],
  )).rows[0].n;

  say();
  ok(`ตาราง ${after}/${tables.length} · เปิด Row Level Security ${rls}/${tables.length}`);
  say();
  info('ขั้นต่อไป: รัน bash scripts/go-live.sh เพื่อสร้างผู้ใช้จริง');
  if (backupPath) info('ข้อมูลเดิมอยู่ในไฟล์สำรอง เก็บไว้ให้ดี อย่าอัปขึ้น GitHub');

  await pool.end();
  rl?.close();
}

main().catch((err) => {
  bad('เกิดข้อผิดพลาด: ' + err.message);
  rl?.close();
  process.exit(1);
});
