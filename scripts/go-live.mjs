// เตรียมฐานข้อมูลจริงก่อนเปิดใช้งาน — ล้างข้อมูลทดสอบ แล้วสร้างผู้ใช้จริง
//
// เรียกผ่าน scripts/go-live.sh (อย่ารันไฟล์นี้ตรง ๆ)
//
// หลักการที่ยึดไว้:
// 1) สำรองข้อมูลลงไฟล์ในเครื่องก่อนเสมอ ถ้าสำรองไม่สำเร็จจะไม่ลบอะไรเลย
// 2) แสดงให้เห็นก่อนว่าจะลบอะไรบ้าง แล้วต้องพิมพ์ยืนยันเป็นคำเต็ม
// 3) รหัสผ่านทุกตัวพิมพ์ในเครื่องนี้ ไม่ขึ้นบนจอ ไม่ลงไฟล์ ไม่ลงรายงาน
// 4) ลบทั้งหมดใน transaction เดียว ถ้าพลาดกลางคันจะย้อนกลับทั้งก้อน

import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import bcrypt from 'bcryptjs';
import pg from 'pg';

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

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

/** ถามรหัสผ่านโดยไม่ให้ขึ้นบนจอ */
function askHidden(q) {
  return new Promise((resolve) => {
    const onData = (ch) => {
      // กด Ctrl+C ระหว่างพิมพ์รหัสผ่าน ต้องคืนสถานะจอให้ปกติก่อนออก
      if (ch[0] === 0x03) { stdout.write('\n'); process.exit(130); }
    };
    stdin.on('data', onData);
    const wasMuted = rl.output.muted;
    rl.output.muted = false;
    stdout.write(q);
    rl.output.muted = true;
    rl.question('', (a) => {
      rl.output.muted = wasMuted;
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(a.trim());
    });
  });
}
// ทำให้ readline เคารพ flag muted ข้างบน
const origWrite = rl.output.write.bind(rl.output);
rl.output.write = (chunk, ...rest) => (rl.output.muted ? true : origWrite(chunk, ...rest));

const nowISO = () => new Date().toISOString();

// ลำดับการลบต้องไล่จากตารางลูกไปหาตารางแม่ ไม่งั้นติด foreign key
const CLEAR_ORDER = [
  'payments', 'installments', 'contract_links', 'contracts',
  'debtor_documents', 'debtors', 'approvals', 'daily_closings',
  'income_entries', 'expenses', 'audit_logs', 'sessions', 'login_attempts',
];
const ALL_TABLES = [...new Set([...CLEAR_ORDER, 'employees', 'users', 'settings', 'counters'])];

const ROLES = {
  1: { role: 'owner', label: 'เจ้าของ — เห็นและทำได้ทุกอย่าง' },
  2: { role: 'manager', label: 'ผู้จัดการ — ทำได้เกือบทุกอย่าง บางรายการต้องรออนุมัติ' },
  3: { role: 'collector', label: 'พนักงานเก็บเงิน — เห็นเฉพาะลูกหนี้ที่ตนดูแล' },
  4: { role: 'accountant', label: 'บัญชี — ดูข้อมูลการเงิน ไม่ยุ่งกับสัญญา' },
};

async function main() {
  say();
  say(C.head('▸ เตรียมฐานข้อมูลจริงก่อนเปิดใช้งาน'));
  say();
  say(C.dim('  สคริปต์นี้ทำงานในเครื่องคุณเท่านั้น รหัสผ่านที่พิมพ์ไม่ถูกส่งไปไหน'));
  say();

  const DB_URL = await askHidden('  วาง connection string ของ Supabase (จะไม่ขึ้นบนจอ): ');
  if (!DB_URL) { bad('ไม่ได้ใส่อะไรมา'); rl.close(); process.exit(1); }

  const pool = new pg.Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });

  try {
    const who = await pool.query('SELECT current_database() db, now() t');
    ok(`ต่อได้ — ฐานข้อมูล ${who.rows[0].db}`);
  } catch (err) {
    bad('ต่อไม่ได้: ' + err.message);
    info('ลองรัน bash scripts/check-connection.sh เพื่อดูว่าติดตรงไหน');
    await pool.end(); rl.close(); process.exit(1);
  }

  // ---- 1. ดูว่าตอนนี้มีอะไรอยู่บ้าง ----------------------------------------
  say();
  say(C.head('  1) ข้อมูลที่อยู่ในฐานข้อมูลตอนนี้'));
  say();
  const counts = {};
  for (const t of ALL_TABLES) {
    const r = await pool.query(`SELECT count(*)::int n FROM ${t}`);
    counts[t] = r.rows[0].n;
  }
  const nonEmpty = ALL_TABLES.filter((t) => counts[t] > 0);
  if (!nonEmpty.length) {
    info('ฐานข้อมูลว่างอยู่แล้ว ไม่มีอะไรต้องล้าง');
  } else {
    for (const t of nonEmpty) say(`     ${t.padEnd(18)} ${String(counts[t]).padStart(5)} แถว`);
  }

  // แสดงตัวอย่างข้อมูลจริง เพื่อให้ตาเห็นเองว่าเป็นข้อมูลทดสอบหรือของจริง
  if (counts.debtors > 0) {
    say();
    info('ตัวอย่างลูกหนี้ที่มีอยู่ (ดูให้แน่ใจว่าเป็นข้อมูลทดสอบจริง ๆ):');
    const d = await pool.query('SELECT code, full_name FROM debtors ORDER BY id LIMIT 10');
    for (const r of d.rows) say(`     ${r.code}  ${r.full_name}`);
    if (counts.debtors > 10) say(C.dim(`     ... และอีก ${counts.debtors - 10} ราย`));
  }

  const users = (await pool.query('SELECT id, username, full_name, role, is_active FROM users ORDER BY id')).rows;
  if (users.length) {
    say();
    info('ผู้ใช้ที่มีอยู่:');
    for (const u of users) say(`     #${u.id} ${u.username.padEnd(14)} ${u.role.padEnd(11)} ${u.full_name}${u.is_active ? '' : C.dim(' (ปิดใช้งาน)')}`);
  }

  // ---- 2. สำรองข้อมูลก่อน ---------------------------------------------------
  say();
  say(C.head('  2) สำรองข้อมูลลงเครื่องก่อน'));
  say();
  let backupPath = null;
  if (nonEmpty.length) {
    const dump = { exported_at: nowISO(), tables: {} };
    for (const t of ALL_TABLES) {
      dump.tables[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
    }
    mkdirSync('backups', { recursive: true });
    backupPath = `backups/ก่อนล้าง-${nowISO().replace(/[:.]/g, '-')}.json`;
    writeFileSync(backupPath, JSON.stringify(dump, null, 2));
    ok(`สำรองแล้ว → ${backupPath}`);
    info('ไฟล์นี้มีรหัสผ่านที่เข้ารหัสไว้ด้วย เก็บให้ดี อย่าอัปขึ้น GitHub');
  } else {
    info('ไม่มีอะไรให้สำรอง ข้ามไป');
  }

  // ---- 3. ล้างข้อมูลทดสอบ ---------------------------------------------------
  say();
  say(C.head('  3) ล้างข้อมูลทดสอบ'));
  say();

  const toClear = CLEAR_ORDER.filter((t) => counts[t] > 0);
  if (!toClear.length) {
    info('ไม่มีข้อมูลธุรกรรมให้ล้าง');
  } else {
    say('     จะลบถาวร:');
    for (const t of toClear) say(`       ${t.padEnd(18)} ${counts[t]} แถว`);
    say(`       ${'counters'.padEnd(18)} รีเซ็ตเลขที่เอกสารกลับไปเริ่มที่ 1`);
    say();
    say('     ' + C.warn('จะเก็บไว้: ผู้ใช้ พนักงาน และการตั้งค่าระบบ'));
    say();
    const phrase = 'ลบข้อมูลทดสอบ';
    const answer = await ask(`  พิมพ์ "${phrase}" เพื่อยืนยัน (อย่างอื่น = ข้ามขั้นนี้): `);
    if (answer !== phrase) {
      info('ข้ามการล้างข้อมูล');
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of CLEAR_ORDER) await client.query(`DELETE FROM ${t}`);
        await client.query('DELETE FROM counters');
        await client.query('COMMIT');
        ok('ล้างเรียบร้อย');
      } catch (err) {
        await client.query('ROLLBACK');
        bad('ล้างไม่สำเร็จ ย้อนกลับทั้งหมดแล้ว ไม่มีอะไรเปลี่ยน: ' + err.message);
        client.release(); await pool.end(); rl.close(); process.exit(1);
      } finally {
        client.release();
      }
    }
  }

  // ---- 4. จัดการบัญชีผู้ใช้ทดสอบ --------------------------------------------
  say();
  say(C.head('  4) บัญชีผู้ใช้'));
  say();
  const stillUsers = (await pool.query('SELECT id, username, full_name, role FROM users ORDER BY id')).rows;
  if (stillUsers.length) {
    for (const u of stillUsers) say(`     #${u.id} ${u.username.padEnd(14)} ${u.role.padEnd(11)} ${u.full_name}`);
    say();
    const del = await ask('  พิมพ์ชื่อผู้ใช้ที่ต้องการลบ คั่นด้วยเว้นวรรค (Enter = ไม่ลบ): ');
    for (const name of del.split(/\s+/).filter(Boolean)) {
      try {
        // ปลดการผูกกับพนักงานก่อน ไม่งั้นติด foreign key
        await pool.query('UPDATE employees SET user_id = NULL WHERE user_id = (SELECT id FROM users WHERE username = $1)', [name]);
        const r = await pool.query('DELETE FROM users WHERE username = $1', [name]);
        r.rowCount ? ok(`ลบ ${name} แล้ว`) : bad(`ไม่พบผู้ใช้ ${name}`);
      } catch (err) {
        bad(`ลบ ${name} ไม่ได้: ${err.message}`);
      }
    }
  }

  // ---- 4ข. ข้อมูลพนักงานที่ค้างอยู่ ------------------------------------------
  //
  // ลบบัญชีผู้ใช้ทิ้งอย่างเดียวไม่พอ เพราะข้อมูล "พนักงาน" เป็นคนละตารางกัน
  // ถ้าปล่อยไว้ พนักงานทดสอบจะยังโผล่ในช่องเลือกผู้ดูแลลูกหนี้
  const emps = (await pool.query(
    `SELECT e.id, e.code, e.full_name, u.username
     FROM employees e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id`,
  )).rows;
  if (emps.length) {
    say();
    say(C.head('  4ข) ข้อมูลพนักงาน'));
    say();
    for (const e of emps) {
      const link = e.username ? `ผูกกับ ${e.username}` : C.warn('ยังไม่ได้ผูกกับผู้ใช้คนไหน');
      say(`     ${e.code.padEnd(8)} ${e.full_name.padEnd(24)} ${link}`);
    }
    const orphans = emps.filter((e) => !e.username);
    if (orphans.length) {
      say();
      info(`มี ${orphans.length} คนที่ไม่ได้ผูกกับผู้ใช้ — มักเป็นข้อมูลทดสอบที่ค้างอยู่`);
    }
    say();
    const delEmp = await ask('  พิมพ์รหัสพนักงานที่ต้องการลบ คั่นด้วยเว้นวรรค (Enter = ไม่ลบ): ');
    for (const code of delEmp.split(/\s+/).filter(Boolean)) {
      try {
        const r = await pool.query('DELETE FROM employees WHERE code = $1', [code.toUpperCase()]);
        r.rowCount ? ok(`ลบ ${code.toUpperCase()} แล้ว`) : bad(`ไม่พบรหัสพนักงาน ${code}`);
      } catch (err) {
        // ลบไม่ได้เพราะยังมีลูกหนี้หรือสัญญาอ้างถึงอยู่ — บอกให้ชัดว่าทำไม
        bad(`ลบ ${code} ไม่ได้ เพราะยังมีข้อมูลอ้างถึงอยู่ (ปิดใช้งานแทนได้ที่หน้าพนักงาน)`);
      }
    }
  }

  // ---- 5. สร้างผู้ใช้จริง ---------------------------------------------------
  say();
  say(C.head('  5) สร้างผู้ใช้จริง'));
  say();
  info('พนักงานเก็บเงินจะถูกสร้างข้อมูลพนักงานและผูกให้อัตโนมัติ');
  info('เพราะถ้าไม่ผูก ระบบจะไม่รู้ว่าใครดูแลลูกหนี้คนไหน');
  say();

  const created = [];
  for (;;) {
    const more = await ask(`  เพิ่มผู้ใช้${created.length ? 'อีก' : ''}คนหนึ่งไหม (y = เพิ่ม / Enter = พอแล้ว): `);
    if (more.toLowerCase() !== 'y') break;
    say();

    const full_name = await ask('    ชื่อ-นามสกุล: ');
    if (!full_name) { bad('ต้องมีชื่อ'); continue; }

    const username = (await ask('    ชื่อผู้ใช้สำหรับเข้าระบบ (ภาษาอังกฤษ ไม่มีเว้นวรรค): ')).toLowerCase();
    if (!/^[a-z0-9._-]{3,}$/.test(username)) { bad('ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - และยาว 3 ตัวขึ้นไป'); continue; }
    const dup = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (dup.rowCount) { bad(`มีชื่อผู้ใช้ ${username} อยู่แล้ว`); continue; }

    say();
    for (const k of Object.keys(ROLES)) say(`      ${k}) ${ROLES[k].label}`);
    const pick = await ask('    เลือกตำแหน่ง (1-4): ');
    if (!ROLES[pick]) { bad('เลือกไม่ถูกต้อง'); continue; }
    const { role } = ROLES[pick];

    let password;
    for (;;) {
      const p1 = await askHidden('    รหัสผ่าน (อย่างน้อย 8 ตัว จะไม่ขึ้นบนจอ): ');
      if (p1.length < 8) { bad('สั้นเกินไป ระบบการเงินควรใช้อย่างน้อย 8 ตัว'); continue; }
      const p2 = await askHidden('    พิมพ์รหัสผ่านอีกครั้ง: ');
      if (p1 !== p2) { bad('สองครั้งไม่ตรงกัน ลองใหม่'); continue; }
      password = p1; break;
    }

    let phone = null, area = null;
    if (role === 'collector') {
      phone = (await ask('    เบอร์โทร (Enter = ข้าม): ')) || null;
      area = (await ask('    พื้นที่ / เส้นทางที่ดูแล (Enter = ข้าม): ')) || null;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = nowISO();
      const u = await client.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,1,$5,$5) RETURNING id`,
        [username, bcrypt.hashSync(password, 10), full_name, role, now],
      );
      let empCode = null;
      if (role === 'collector') {
        // หารหัสพนักงานถัดไปจากที่มีอยู่จริง กันรหัสชนกับข้อมูลที่นำเข้ามาภายหลัง
        const max = await client.query(
          `SELECT coalesce(max(substring(code from 2)::int), 0) n FROM employees WHERE code ~ '^E[0-9]+$'`,
        );
        empCode = 'E' + String(max.rows[0].n + 1).padStart(4, '0');
        await client.query(
          `INSERT INTO employees (user_id, code, full_name, phone, area, is_active, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,
          [u.rows[0].id, empCode, full_name, phone, area, now],
        );
      }
      await client.query('COMMIT');
      ok(`สร้าง ${username} (${role}) แล้ว${empCode ? ` · รหัสพนักงาน ${empCode}` : ''}`);
      created.push({ username, full_name, role, empCode });
    } catch (err) {
      await client.query('ROLLBACK');
      bad('สร้างไม่สำเร็จ: ' + err.message);
    } finally {
      client.release();
    }
    say();
  }

  // ---- 6. ตรวจผลและเขียนรายงาน ----------------------------------------------
  say();
  say(C.head('  6) สรุป'));
  say();
  const after = {};
  for (const t of ALL_TABLES) {
    after[t] = (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
  }
  const finalUsers = (await pool.query('SELECT username, full_name, role FROM users WHERE is_active = 1 ORDER BY id')).rows;
  const owners = finalUsers.filter((u) => u.role === 'owner').length;

  const lines = [];
  const push = (s) => { lines.push(s); say('  ' + s); };

  push('ข้อมูลธุรกรรมที่เหลืออยู่:');
  for (const t of CLEAR_ORDER) push(`  ${t.padEnd(18)} ${after[t]}`);
  push('');
  push(`ผู้ใช้ที่เปิดใช้งาน ${finalUsers.length} คน:`);
  for (const u of finalUsers) push(`  ${u.username.padEnd(14)} ${u.role.padEnd(11)} ${u.full_name}`);
  push('');
  push(`พนักงาน ${after.employees} คน · การตั้งค่า ${after.settings} รายการ`);

  say();
  const txCount = CLEAR_ORDER.reduce((s, t) => s + after[t], 0);
  if (txCount === 0) ok('ไม่มีข้อมูลธุรกรรมค้างอยู่ พร้อมเริ่มใช้งานจริง');
  else info(`ยังมีข้อมูลธุรกรรมเหลือ ${txCount} แถว (ถ้าตั้งใจเก็บไว้ก็ไม่เป็นไร)`);

  if (owners === 0) bad('ไม่มีบัญชีเจ้าของที่เปิดใช้งานเลย — จะเข้าไปจัดการระบบไม่ได้ ต้องสร้างก่อน');
  else if (owners === 1) ok('มีบัญชีเจ้าของ 1 บัญชี');
  else info(`มีบัญชีเจ้าของ ${owners} บัญชี ตรวจดูว่าตั้งใจให้เป็นแบบนี้`);

  if (!finalUsers.some((u) => u.role === 'collector')) {
    info('ยังไม่มีพนักงานเก็บเงิน — ถ้ามีพนักงานจริงควรสร้างบัญชีแยกให้ทุกคน ห้ามใช้ร่วมกัน');
  }

  mkdirSync('reports', { recursive: true });
  const reportPath = 'reports/go-live-report.txt';
  writeFileSync(reportPath, [
    'รายงานการเตรียมฐานข้อมูลจริง',
    'เวลา: ' + nowISO(),
    backupPath ? 'ไฟล์สำรอง: ' + backupPath : 'ไม่ได้สำรอง (ฐานข้อมูลว่าง)',
    '',
    ...lines,
    '',
    '(รายงานนี้ไม่มีรหัสผ่านและไม่มี connection string ส่งให้คนอื่นดูได้)',
  ].join('\n'));
  say();
  ok(`เขียนรายงานแล้ว → ${reportPath}`);
  info('ไฟล์นี้ไม่มีรหัสผ่าน ส่งให้ผมดูได้');

  await pool.end();
  rl.close();
}

main().catch((err) => {
  bad('เกิดข้อผิดพลาด: ' + err.message);
  rl.close();
  process.exit(1);
});
