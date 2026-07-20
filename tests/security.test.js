// ทดสอบความปลอดภัยแบบลองโจมตีจริง ไม่ใช่แค่อ่านโค้ด
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { db, get, all, run, insert, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO, today } from '../src/lib/time.js';
import { createContract } from '../src/domain/contracts.js';

let server, base;
const sess = {};                 // เก็บคุกกี้ของแต่ละบทบาท
let debtorA, debtorB, contractA; // debtorA = ของพนักงาน A, debtorB = ของพนักงาน B

/** เรียก API พร้อมคุกกี้ของบทบาทที่ระบุ */
async function api(role, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(sess[role] ? { Cookie: `fp_session=${sess[role]}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
  return { status: res.status, body: json, text };
}

async function login(role, username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  sess[role] = cookie.match(/fp_session=([^;]*)/)?.[1] ?? null;
  return res.status;
}

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const now = nowISO();
  const users = [
    ['owner', 'owner', 'Owner#Pass1'],
    ['manager', 'manager', 'Manager#Pass1'],
    ['collector', 'collector', 'Collect#Pass1'],
    ['collector2', 'collector', 'Collect#Pass2'],
    ['account', 'accountant', 'Account#Pass1'],
  ];
  for (const [username, role, pw] of users) {
    await run(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (:u, :h, :u, :r, 1, :now, :now)`,
      { u: username, h: hashPassword(pw), r: role, now },
    );
  }
  const c1 = await get(`SELECT id FROM users WHERE username='collector'`);
  const c2 = await get(`SELECT id FROM users WHERE username='collector2'`);
  await run(`INSERT INTO employees (user_id, code, full_name, is_active, created_at, updated_at)
             VALUES (:u, 'E001', 'พนักงาน ก', 1, :now, :now)`, { u: c1.id, now });
  await run(`INSERT INTO employees (user_id, code, full_name, is_active, created_at, updated_at)
             VALUES (:u, 'E002', 'พนักงาน ข', 1, :now, :now)`, { u: c2.id, now });
  const empA = (await get(`SELECT id FROM employees WHERE code='E001'`)).id;
  const empB = (await get(`SELECT id FROM employees WHERE code='E002'`)).id;

  debtorA = await insert(
    `INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
     VALUES ('DA', 'ลูกหนี้ของ ก', :e, 'normal', :now, :now)`, { e: empA, now });
  debtorB = await insert(
    `INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
     VALUES ('DB', 'ลูกหนี้ของ ข', :e, 'normal', :now, :now)`, { e: empB, now });

  const owner = await get(`SELECT * FROM users WHERE username='owner'`);
  const r = await createContract({
    debtorId: debtorB, employeeId: empB, type: 'daily24',
    principalAmount: 100000, installmentAmount: 5000, interestPerInst: 2000,
    numInstallments: 24, startDate: today(),
  }, { user: owner, ip: 'test' });
  contractA = r.contract.id;

  for (const [role, , pw] of users) await login(role, role, pw);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

// =============================================================================
describe('ความปลอดภัย: การเข้าถึงโดยไม่ได้รับอนุญาต', () => {
  test('ไม่มีคุกกี้ เข้า API ไหนไม่ได้เลย', async () => {
    const paths = ['/api/dashboard', '/api/debtors', '/api/contracts', '/api/payments',
                   '/api/cashbook/day', '/api/reports/summary', '/api/admin/users',
                   '/api/admin/settings', '/api/admin/backup', '/api/import/fields'];
    for (const p of paths) {
      const r = await api('none', 'GET', p);
      assert.equal(r.status, 401, `${p} ควรเป็น 401 แต่ได้ ${r.status}`);
    }
  });

  test('คุกกี้ปลอมใช้ไม่ได้', async () => {
    sess.fake = 'a'.repeat(64);
    const r = await api('fake', 'GET', '/api/dashboard');
    assert.equal(r.status, 401);
  });

  test('คุกกี้ของผู้ใช้ที่ถูกปิดใช้งานต้องใช้ไม่ได้ทันที', async () => {
    const u = await get(`SELECT id FROM users WHERE username='account'`);
    await run(`UPDATE users SET is_active = 0 WHERE id = :id`, { id: u.id });
    const r = await api('account', 'GET', '/api/reports/profit-loss');
    assert.equal(r.status, 401, 'ปิดบัญชีแล้วต้องเข้าไม่ได้ทันที');
    await run(`UPDATE users SET is_active = 1 WHERE id = :id`, { id: u.id });
  });
});

describe('ความปลอดภัย: การยกระดับสิทธิ์', () => {
  test('พนักงานเก็บเงินสร้างสัญญาไม่ได้', async () => {
    const r = await api('collector', 'POST', '/api/contracts', {
      debtor_id: debtorA, type: 'daily24', principal_amount: 100000,
      installment_amount: 5000, interest_per_inst: 2000, num_installments: 24,
    });
    assert.equal(r.status, 403);
  });

  test('พนักงานเก็บเงินรียอดไม่ได้', async () => {
    const r = await api('collector', 'POST', '/api/contracts/reyod',
      { from_contract_id: contractA, new_money: 100000 });
    assert.equal(r.status, 403);
  });

  test('พนักงานเก็บเงินยกเลิกรายการรับเงินไม่ได้', async () => {
    const p = await get(`SELECT id FROM payments LIMIT 1`);
    const r = await api('collector', 'POST', `/api/payments/${p.id}/void`, { reason: 'ลอง' });
    assert.equal(r.status, 403);
  });

  test('พนักงานเก็บเงินแก้ตั้งค่าระบบไม่ได้', async () => {
    const r = await api('collector', 'PUT', '/api/admin/settings',
      { settings: { doc_fee: '0' } });
    assert.equal(r.status, 403);
    const fee = await get(`SELECT value FROM settings WHERE key='doc_fee'`);
    assert.notEqual(fee?.value, '0', 'ค่าทำเอกสารต้องไม่ถูกแก้');
  });

  test('พนักงานเก็บเงินสร้างผู้ใช้ใหม่ไม่ได้ (กันสร้างบัญชีเจ้าของเอง)', async () => {
    const r = await api('collector', 'POST', '/api/admin/users',
      { username: 'hacker', password: 'hacker123', role: 'owner' });
    assert.equal(r.status, 403);
    assert.equal(await get(`SELECT id FROM users WHERE username='hacker'`), null);
  });

  test('ผู้จัดการยกเลิกรายการรับเงินได้แต่ต้องรออนุมัติ ไม่ใช่ทำเลย', async () => {
    const p = await get(`SELECT id, is_void FROM payments LIMIT 1`);
    const r = await api('manager', 'POST', `/api/payments/${p.id}/void`, { reason: 'ทดสอบ' });
    assert.equal(r.status, 202, 'ต้องเป็นคำขออนุมัติ');
    const after = await get(`SELECT is_void FROM payments WHERE id = :id`, { id: p.id });
    assert.equal(after.is_void, 0, 'ยอดต้องยังไม่ถูกยกเลิกจนกว่าเจ้าของจะอนุมัติ');
  });

  test('ผู้จัดการอนุมัติคำขอของตัวเองไม่ได้', async () => {
    const a = await get(`SELECT id FROM approvals WHERE status='pending' LIMIT 1`);
    const r = await api('manager', 'POST', `/api/admin/approvals/${a.id}/decide`, { approve: true });
    assert.equal(r.status, 403);
  });

  test('ฝ่ายบัญชีรับชำระเงินไม่ได้', async () => {
    const r = await api('account', 'POST', '/api/payments',
      { contract_id: contractA, amount_paid: 5000 });
    assert.equal(r.status, 403);
  });
});

describe('ความปลอดภัย: เห็นข้อมูลข้ามเขต (IDOR)', () => {
  test('พนักงานเก็บเงินเห็นเฉพาะลูกหนี้ของตน', async () => {
    const r = await api('collector', 'GET', '/api/debtors');
    const codes = r.body.items.map((d) => d.code);
    assert.deepEqual(codes, ['DA'], `เห็น ${JSON.stringify(codes)} ควรเห็นแค่ DA`);
  });

  test('เดา id ลูกหนี้ของคนอื่นตรง ๆ ต้องถูกปฏิเสธ', async () => {
    const r = await api('collector', 'GET', `/api/debtors/${debtorB}`);
    assert.equal(r.status, 403, 'ต้องกันการเข้าถึงลูกหนี้ของพนักงานอื่น');
  });

  test('เดา id สัญญาของคนอื่นตรง ๆ ต้องถูกปฏิเสธ', async () => {
    const r = await api('collector', 'GET', `/api/contracts/${contractA}`);
    assert.equal(r.status, 403);
  });

  test('รับชำระให้สัญญาของพนักงานอื่นไม่ได้', async () => {
    const r = await api('collector', 'POST', '/api/payments',
      { contract_id: contractA, amount_paid: 5000 });
    assert.equal(r.status, 403);
  });

  test('พนักงานอีกคนเห็นเฉพาะของตัวเองเช่นกัน', async () => {
    const r = await api('collector2', 'GET', '/api/debtors');
    assert.deepEqual(r.body.items.map((d) => d.code), ['DB']);
  });
});

describe('ความปลอดภัย: SQL Injection', () => {
  const PAYLOADS = [
    "' OR '1'='1",
    "'; DROP TABLE payments; --",
    "' UNION SELECT username, password_hash, 1,1,1,1,1,1,1,1 FROM users --",
    "%' --",
    "\\'; DELETE FROM debtors WHERE '1'='1",
  ];

  test('ช่องค้นหาลูกหนี้ฉีด SQL ไม่เข้า', async () => {
    for (const p of PAYLOADS) {
      const r = await api('owner', 'GET', `/api/debtors?q=${encodeURIComponent(p)}`);
      assert.equal(r.status, 200, `payload ทำให้ระบบพัง: ${p}`);
      assert.ok(Array.isArray(r.body.items));
      // ต้องไม่คืนข้อมูลเกินจริง และต้องไม่มี hash รหัสผ่านหลุดมา
      assert.ok(!r.text.includes('$2a$') && !r.text.includes('$2b$'), 'รหัสผ่านหลุด!');
    }
    const still = await get(`SELECT COUNT(*)::int n FROM debtors`);
    assert.equal(still.n, 2, 'ตารางลูกหนี้ต้องยังอยู่ครบ');
  });

  test('ช่องค้นหาสัญญาฉีด SQL ไม่เข้า', async () => {
    for (const p of PAYLOADS) {
      const r = await api('owner', 'GET', `/api/contracts?q=${encodeURIComponent(p)}`);
      assert.equal(r.status, 200);
    }
    assert.ok(await get(`SELECT id FROM payments LIMIT 1`), 'ตาราง payments ต้องยังอยู่');
  });

  test('ฉีดผ่านพารามิเตอร์ตัวเลขไม่ได้', async () => {
    const r = await api('owner', 'GET', '/api/contracts/1%20OR%201=1');
    assert.ok([400, 404].includes(r.status), `ได้ ${r.status}`);
  });

  test('ฉีดผ่านชื่อลูกหนี้ตอนบันทึกไม่ทำให้ข้อมูลเสียหาย', async () => {
    const evil = "Robert'); DROP TABLE contracts; --";
    const r = await api('owner', 'POST', '/api/debtors', { full_name: evil });
    assert.equal(r.status, 201);
    assert.equal(r.body.debtor.full_name, evil, 'ต้องเก็บข้อความตามจริง ไม่ตีความเป็นคำสั่ง');
    assert.ok(await get(`SELECT id FROM contracts LIMIT 1`), 'ตาราง contracts ต้องยังอยู่');
  });
});

describe('ความปลอดภัย: การแก้ไขข้อมูลที่ไม่ควรทำได้', () => {
  test('กำหนดบทบาทตัวเองเป็นเจ้าของผ่าน API แก้ลูกหนี้ไม่ได้', async () => {
    const r = await api('owner', 'PUT', `/api/debtors/${debtorA}`,
      { full_name: 'x', role: 'owner', id: 999 });
    assert.equal(r.status, 200);
    const d = await get(`SELECT * FROM debtors WHERE id = :id`, { id: debtorA });
    assert.equal(d.id, debtorA, 'id ต้องไม่ถูกเปลี่ยน');
    assert.equal(d.role, undefined, 'ต้องไม่มีคอลัมน์แปลกปลอมถูกเพิ่ม');
  });

  test('ยอดเงินติดลบถูกปฏิเสธทุกช่องทาง', async () => {
    const paths = [
      ['POST', '/api/payments', { contract_id: contractA, amount_paid: -100000 }],
      ['POST', '/api/cashbook/expenses', { category: 'ค่าน้ำมัน', amount: -5000 }],
      ['POST', '/api/cashbook/income', { category: 'รายรับอื่น', amount: -5000 }],
    ];
    for (const [m, p, b] of paths) {
      const r = await api('owner', m, p, b);
      assert.ok(r.status >= 400, `${p} ต้องปฏิเสธยอดติดลบ แต่ได้ ${r.status}`);
    }
  });

  test('ยกเลิกรายการโดยไม่ระบุเหตุผลไม่ได้ (ข้อ 15)', async () => {
    const p = await get(`SELECT id FROM payments WHERE is_void = 0 LIMIT 1`);
    const r = await api('owner', 'POST', `/api/payments/${p.id}/void`, {});
    assert.equal(r.status, 400);
  });

  test('ยกเลิกรายการเดิมซ้ำสองครั้งไม่ได้ (กันยอดเด้งกลับสองรอบ)', async () => {
    const p = await get(`SELECT id FROM payments WHERE is_void = 0 LIMIT 1`);
    const first = await api('owner', 'POST', `/api/payments/${p.id}/void`, { reason: 'ครั้งที่ 1' });
    assert.equal(first.status, 200);
    const second = await api('owner', 'POST', `/api/payments/${p.id}/void`, { reason: 'ครั้งที่ 2' });
    assert.equal(second.status, 400, 'ยกเลิกซ้ำต้องถูกปฏิเสธ');
  });
});

describe('ความปลอดภัย: ข้อมูลรั่วไหล', () => {
  test('API ไม่ส่ง hash รหัสผ่านออกไปเลย', async () => {
    const paths = ['/api/me', '/api/auth/session', '/api/admin/users', '/api/admin/employees'];
    for (const p of paths) {
      const r = await api('owner', 'GET', p);
      assert.ok(!r.text.includes('password_hash'), `${p} ส่ง password_hash ออกมา!`);
      assert.ok(!/\$2[aby]\$/.test(r.text), `${p} ส่งค่า hash ออกมา!`);
    }
  });

  test('ไฟล์สำรองข้อมูลไม่มีรหัสผ่านติดไปด้วย', async () => {
    const r = await api('owner', 'GET', '/api/admin/backup');
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('password_hash'), 'ไฟล์สำรองมีรหัสผ่านติดไปด้วย!');
    assert.ok(r.body.tables.users.length > 0, 'ต้องมีข้อมูลผู้ใช้ (แต่ไม่มีรหัสผ่าน)');
  });

  test('ข้อความ error ไม่เปิดเผยโครงสร้างภายใน', async () => {
    const r = await api('owner', 'GET', '/api/contracts/999999');
    assert.equal(r.status, 404);
    assert.ok(!r.text.includes('SELECT'), 'ไม่ควรเปิดเผย SQL');
    assert.ok(!r.text.includes('/Users/'), 'ไม่ควรเปิดเผย path ในเครื่อง');
  });

  test('เข้าสู่ระบบผิดไม่บอกว่าชื่อผู้ใช้มีจริงหรือไม่', async () => {
    const a = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'ผิด' }) });
    const b = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ไม่มีคนนี้', password: 'ผิด' }) });
    assert.equal(a.status, b.status, 'สถานะต้องเหมือนกัน');
    assert.equal(await a.text(), await b.text(), 'ข้อความต้องเหมือนกัน ไม่บอกใบ้');
  });
});

describe('ความปลอดภัย: ไฟล์แนบ', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('ไฟล์ชนิดอันตรายถูกปฏิเสธ', async () => {
    const bad = [
      'data:application/x-msdownload;base64,TVo=',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
      'data:application/javascript;base64,YWxlcnQoMSk=',
    ];
    for (const d of bad) {
      const r = await api('owner', 'POST', `/api/debtors/${debtorA}/documents`, { data_url: d });
      assert.equal(r.status, 400, `ควรปฏิเสธ: ${d.slice(0, 40)}`);
    }
  });

  test('ไฟล์รูปปกติผ่านได้ และชื่อไฟล์ถูกสุ่มใหม่ (กันเดา path)', async () => {
    const r = await api('owner', 'POST', `/api/debtors/${debtorA}/documents`,
      { data_url: PNG, file_name: '../../../etc/passwd.png' });
    assert.equal(r.status, 201);
    const path = r.body.document.file_path;
    assert.ok(!path.includes('..'), 'ต้องไม่มี path traversal');
    assert.ok(!path.includes('passwd'), 'ต้องไม่ใช้ชื่อไฟล์ที่ผู้ใช้ส่งมาเป็นชื่อจริง');
    assert.match(path, /^\/uploads\/debtor-\d+-\d+-[a-f0-9]+\.png$/);
  });
});
