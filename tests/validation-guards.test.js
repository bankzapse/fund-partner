// ด่านตรวจ input ที่พบจากการทดสอบเคส error/กรอกไม่ครบ:
//   จ่ายเงิน 0 บาท · ค่าแรง/น้ำมันติดลบ · วิธีคิดดอกเบี้ยสะกดผิด
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO } from '../src/lib/time.js';

let server, base;
const sess = {};

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

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const now = nowISO();
  await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
             VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :n, :n)`, { h: hashPassword('Owner#Pass1'), n: now });
  await run(`INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
             VALUES ('A', 'พี่อ้อย', 1, :n, :n)`, { n: now });
  await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
             VALUES ('A.1', 'ลูกหนี้', 1, 'normal', :n, :n)`, { n: now });
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'Owner#Pass1' }),
  });
  sess.owner = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('ด่านตรวจ input (เคส error / กรอกไม่ครบ)', () => {
  test('รับชำระ 0 บาทไม่ได้ (สอดคล้องกับจ่ายฟรี)', async () => {
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0, start_date: '2035-01-01',
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const zero = await api('owner', 'POST', '/api/payments',
      { contract_id: c.body.contract.id, amount_paid: 0, paid_date: '2035-01-01' });
    assert.equal(zero.status, 400, 'ยอดรับ 0 ต้องถูกปฏิเสธ');
    assert.match(zero.body.error, /มากกว่า 0/);
  });

  test('ค่าแรง/น้ำมันติดลบไม่ได้ (ตอนสร้างและแก้ไขพนักงาน)', async () => {
    const create = await api('owner', 'POST', '/api/admin/employees',
      { code: 'Z', full_name: 'ทดสอบ', wage_amount: -100, wage_period: 'daily' });
    assert.equal(create.status, 400, 'ค่าแรงติดลบตอนสร้างต้องถูกปฏิเสธ');

    const update = await api('owner', 'PUT', '/api/admin/employees/1',
      { fuel_amount: -50 });
    assert.equal(update.status, 400, 'ค่าน้ำมันติดลบตอนแก้ไขต้องถูกปฏิเสธ');
  });

  test('วิธีคิดดอกเบี้ยสะกดผิด → บอกชัด ไม่ตกไปโหมดอื่นเงียบ ๆ', async () => {
    const bad = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'typo_mode', interest_rate_bp: 2000, doc_fee: 0, start_date: '2035-01-01',
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /วิธีคิดดอกเบี้ยไม่ถูกต้อง/);
  });
});
