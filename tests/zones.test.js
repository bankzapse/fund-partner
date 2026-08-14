// เฟส 5: รหัสลูกหนี้ตามโซน (ข้อ 2-3) + ปิดยอดพนักงาน (ข้อ 32) + dashboard เลือกโซน (ข้อ 41)
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, closeDb } from '../src/db/index.js';
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

async function login(u, p) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
}

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const now = nowISO();
  await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
             VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)`,
    { h: hashPassword('Owner#Pass1'), now });
  sess.owner = await login('owner', 'Owner#Pass1');
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('เฟส 5 — รหัสลูกหนี้ตามโซน (ข้อ 2-3)', () => {
  test('สร้างพนักงานพร้อมอัตราค่าแรง/น้ำมัน (ข้อ 28, 30-31)', async () => {
    const a = await api('owner', 'POST', '/api/admin/employees', {
      code: 'A', full_name: 'พี่อ้อย', area: 'Zone A',
      wage_amount: 30000, wage_period: 'daily', fuel_amount: 10000, fuel_period: 'daily',
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.employee.wage_amount, 30000);
    assert.equal(a.body.employee.fuel_period, 'daily');
    const b = await api('owner', 'POST', '/api/admin/employees', {
      code: 'B', full_name: 'ออย', area: 'Zone B',
    });
    assert.equal(b.status, 201);
  });

  test('รหัสลูกหนี้รันแยกโซน: A.1, A.2 / B.1 และลูกหนี้ไม่มีโซนใช้รหัสกลาง', async () => {
    const a1 = await api('owner', 'POST', '/api/debtors', { full_name: 'ลูกหนี้หนึ่ง', employee_id: 1 });
    assert.equal(a1.status, 201);
    assert.equal(a1.body.debtor.code, 'A.1', 'ลูกหนี้แรกของโซน A = A.1');
    const a2 = await api('owner', 'POST', '/api/debtors', { full_name: 'ลูกหนี้สอง', employee_id: 1 });
    assert.equal(a2.body.debtor.code, 'A.2');
    const b1 = await api('owner', 'POST', '/api/debtors', { full_name: 'ลูกหนี้สาม', employee_id: 2 });
    assert.equal(b1.body.debtor.code, 'B.1', 'โซน B นับของตัวเอง');
    const free = await api('owner', 'POST', '/api/debtors', { full_name: 'ไม่มีโซน' });
    assert.match(free.body.debtor.code, /^D\d{5}$/, 'ไม่มีโซนใช้รหัสกลางแบบเดิม');
  });

  test('รหัสห้ามซ้ำ และกรอกเองได้', async () => {
    const dup = await api('owner', 'POST', '/api/debtors', { full_name: 'ซ้ำ', code: 'A.1' });
    assert.equal(dup.status, 400, 'รหัสซ้ำต้องถูกปฏิเสธ');
    const manual = await api('owner', 'POST', '/api/debtors', { full_name: 'กรอกเอง', code: 'A.99', employee_id: 1 });
    assert.equal(manual.status, 201);
    // ตัวรันอัตโนมัติข้ามเลขที่ถูกใช้แล้ว
    const a3 = await api('owner', 'POST', '/api/debtors', { full_name: 'ลูกหนี้สี่', employee_id: 1 });
    assert.equal(a3.body.debtor.code, 'A.3');
  });
});

describe('เฟส 5 — dashboard เลือกโซน (ข้อ 41)', () => {
  test('เจ้าของกรองรายโซนได้ และค่า zone สะท้อนในผลลัพธ์', async () => {
    // เปิดสัญญาหักดอกก่อนโซน A (ดอก 100 รับรู้ทันที) เพื่อให้มีตัวเลขต่างกันระหว่างโซน
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 100000, num_installments: 10,
      interest_mode: 'deduct_upfront', interest_rate_bp: 1000, doc_fee: 0,
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));

    const all = await api('owner', 'GET', '/api/dashboard');
    assert.equal(all.body.zone, null, 'ไม่กรอง = รวมทุกโซน');

    const zoneA = await api('owner', 'GET', '/api/dashboard?employee_id=1');
    assert.equal(zoneA.body.zone, 1);
    assert.equal(zoneA.body.today.upfront_interest_income, 10000, 'โซน A มีดอกหักก่อน 100');

    const zoneB = await api('owner', 'GET', '/api/dashboard?employee_id=2');
    assert.equal(zoneB.body.today.upfront_interest_income, 0, 'โซน B ไม่มี');
  });
});

describe('เฟส 5 — ปิดยอดพนักงานประจำวัน (ข้อ 32)', () => {
  test('แยกรายโซน + แถวรวม: เงินเก็บ/ค่าแรง/น้ำมัน/ค่าทำสัญญา/ยอดสุทธิ', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // รับชำระงวดแรกของสัญญาโซน A (งวดละ 100)
    const inst = await get(
      `SELECT * FROM installments WHERE contract_id = 1 ORDER BY seq LIMIT 1`);
    const pay = await api('owner', 'POST', '/api/payments', {
      contract_id: 1, amount_paid: inst.due_amount, paid_date: today,
    });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));

    const r = await api('owner', 'GET', `/api/reports/employee-closing?date=${today}`);
    assert.equal(r.status, 200);
    const rowA = r.body.rows.find((x) => x.employee.code === 'A');
    assert.equal(rowA.cash_collected, inst.due_amount, 'เงินเก็บโซน A');
    assert.equal(rowA.wage_due, 30000, 'ค่าแรงตามอัตรารายวัน 300');
    assert.equal(rowA.fuel_due, 10000, 'ค่าน้ำมันตามอัตรา 100');
    assert.equal(rowA.hand_in, inst.due_amount, 'นำส่ง = เงินเก็บ (ไม่มีจ่ายฟรี)');
    assert.equal(rowA.owed_to_employee, 40000, 'กิจการต้องจ่าย = ค่าแรง+น้ำมัน (ค่าทำสัญญาวันนี้ 0)');
    assert.equal(rowA.net, inst.due_amount - 40000, 'ยอดสุทธิ');

    // แถวรวมทุกโซน = ผลรวมรายแถว
    const sumNet = r.body.rows.reduce((s, x) => s + x.net, 0);
    assert.equal(r.body.total.net, sumNet, 'แถวรวมต้องเท่าผลรวมรายโซน');
  });
});
