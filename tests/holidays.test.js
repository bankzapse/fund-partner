// เฟส 6: วันหยุดส่ง (ข้อ 23) + ดอกลอยรายวัน (ข้อ 17-18, 20)
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, all, closeDb } from '../src/db/index.js';
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
             VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)`,
    { h: hashPassword('Owner#Pass1'), now });
  await run(`INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
             VALUES ('A', 'พี่อ้อย', 1, :now, :now)`, { now });
  await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
             VALUES ('A.1', 'ลูกหนี้', 1, 'normal', :now, :now)`, { now });
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

describe('เฟส 6 — วันหยุดส่ง (ข้อ 23)', () => {
  test('ประกาศวันหยุดทั้งระบบ → งวดค้างของสัญญาที่เปิดอยู่ถูกเลื่อน +1 วัน', async () => {
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 100000, num_installments: 10,
      interest_mode: 'flat_total', interest_rate_bp: 1000, doc_fee: 0, deduct_first: false,
      start_date: '2035-01-01',
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const before = await all(`SELECT seq, due_date FROM installments WHERE contract_id = :c ORDER BY seq`,
      { c: c.body.contract.id });
    // งวด seq 3 ครบ 2035-01-03 — ประกาศวันนั้นเป็นวันหยุด
    assert.equal(before[2].due_date, '2035-01-03');

    const h = await api('owner', 'POST', '/api/admin/holidays', {
      holiday_date: '2035-01-03', name: 'วันหยุดทดสอบ', scope: 'all',
    });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.ok(h.body.shifted_daily >= 8, 'งวด 3-10 ต้องถูกเลื่อน');

    const after = await all(`SELECT seq, due_date FROM installments WHERE contract_id = :c ORDER BY seq`,
      { c: c.body.contract.id });
    assert.equal(after[0].due_date, '2035-01-01', 'งวดที่จ่าย/ผ่านไปแล้วก่อนวันหยุดไม่ขยับ');
    assert.equal(after[1].due_date, '2035-01-02', 'งวดก่อนวันหยุดไม่ขยับ');
    assert.equal(after[2].due_date, '2035-01-04', 'งวดที่ตรงวันหยุดเลื่อนไปวันถัดไป');
    assert.equal(after[9].due_date, '2035-01-11', 'ทุกงวดถัดไปเลื่อนตาม (ไม่มีงวดตรงวันหยุด)');
    // ไม่มีงวดไหนครบกำหนดตรงวันหยุด → ไม่ขึ้นค้างในวันนั้น
    const onHoliday = after.find((r) => r.due_date === '2035-01-03');
    assert.equal(onHoliday, undefined);
  });

  test('สัญญาใหม่ที่เปิดหลังประกาศวันหยุด → ตารางข้ามวันหยุดเอง', async () => {
    // 2035-01-03 เป็นวันหยุดแล้ว เปิดสัญญาเริ่ม 2035-01-01
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 100000, num_installments: 5,
      interest_mode: 'flat_total', interest_rate_bp: 1000, doc_fee: 0, deduct_first: false,
      start_date: '2035-01-01',
    });
    assert.equal(c.status, 201);
    const inst = await all(`SELECT due_date FROM installments WHERE contract_id = :c ORDER BY seq`,
      { c: c.body.contract.id });
    const dates = inst.map((r) => r.due_date);
    assert.ok(!dates.includes('2035-01-03'), 'ตารางต้องข้ามวันหยุด');
    assert.deepEqual(dates, ['2035-01-01', '2035-01-02', '2035-01-04', '2035-01-05', '2035-01-06']);
  });

  test('วันหยุดเฉพาะโซนไม่กระทบสัญญาโซนอื่น + กันประกาศซ้ำ', async () => {
    const dup = await api('owner', 'POST', '/api/admin/holidays', {
      holiday_date: '2035-01-03', name: 'ซ้ำ', scope: 'all',
    });
    assert.equal(dup.status, 400, 'ประกาศซ้ำขอบเขตเดิมไม่ได้');

    const empScope = await api('owner', 'POST', '/api/admin/holidays', {
      holiday_date: '2035-02-01', name: 'หยุดเฉพาะโซน A', scope: 'employee', employee_id: 1,
    });
    assert.equal(empScope.status, 201, JSON.stringify(empScope.body));
  });

  test('ลบประกาศวันหยุดได้ (ตารางที่เลื่อนแล้วคงเดิม)', async () => {
    const list = await api('owner', 'GET', '/api/admin/holidays');
    const target = list.body.items.find((h) => h.name === 'หยุดเฉพาะโซน A');
    const before = await all(`SELECT due_date FROM installments WHERE contract_id = 1 ORDER BY seq`);
    const r = await api('owner', 'POST', `/api/admin/holidays/${target.id}/delete`);
    assert.equal(r.status, 200);
    const after = await all(`SELECT due_date FROM installments WHERE contract_id = 1 ORDER BY seq`);
    assert.deepEqual(after, before, 'ลบประกาศไม่ดึงตารางกลับ');
  });

  test('พนักงานเก็บเงินประกาศวันหยุดไม่ได้', async () => {
    await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
               VALUES ('col', :h, 'พนง', 'collector', 1, :now, :now)`,
      { h: hashPassword('Passw0rd#1'), now: nowISO() });
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'col', password: 'Passw0rd#1' }),
    });
    sess.col = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
    const r = await api('col', 'POST', '/api/admin/holidays', {
      holiday_date: '2035-03-01', name: 'x', scope: 'all',
    });
    assert.equal(r.status, 403);
  });
});

describe('เฟส 6 — ดอกลอยรายวัน (ข้อ 17-18, 20)', () => {
  test('ดอกลอยเป็นบาท/วัน หน่วยรายวัน + ปฏิทินเก็บดอกล่วงหน้า', async () => {
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'floating', principal_amount: 1000000,
      installment_amount: 15000, interest_per_inst: 15000, num_installments: 30,
      doc_fee: 0, deduct_first: false, start_date: '2035-06-01',
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.contract.period_unit, 'day', 'ดอกลอยเป็นรายวันแล้ว');
    const inst = await all(`SELECT seq, due_date, interest_due, principal_due FROM installments
                            WHERE contract_id = :c ORDER BY seq LIMIT 3`, { c: c.body.contract.id });
    // งวดห่างกันวันละ 1 (ไม่ใช่เดือนละ 1)
    assert.equal(inst[0].due_date, '2035-06-01');
    assert.equal(inst[1].due_date, '2035-06-02');
    assert.equal(inst[0].interest_due, 15000, 'ดอก 150/วัน');
    assert.equal(inst[0].principal_due, 0, 'เงินต้นไม่ตัดในงวด');
  });

  test('ข้อ 20: ตัดต้นจนหมด → ปิดสัญญาแม้ปฏิทินดอกยังเหลือ', async () => {
    const c = await get(`SELECT id, principal_remaining FROM contracts WHERE type = 'floating' ORDER BY id DESC LIMIT 1`);
    // จ่าย 1,150 = ดอก 150 + ตัดต้น 1,000 → ต้นเหลือ 9,000
    const p1 = await api('owner', 'POST', '/api/payments', {
      contract_id: c.id, amount_paid: 115000, extra_to_principal: true, paid_date: '2035-06-01',
    });
    assert.equal(p1.status, 201, JSON.stringify(p1.body));
    // จ่ายต้นที่เหลือทั้งหมด 9,000 (+ดอกวันนั้น 150)
    const p2 = await api('owner', 'POST', '/api/payments', {
      contract_id: c.id, amount_paid: 915000, extra_to_principal: true, paid_date: '2035-06-02',
    });
    assert.equal(p2.status, 201, JSON.stringify(p2.body));
    const after = await get(`SELECT status, principal_remaining FROM contracts WHERE id = :c`, { c: c.id });
    assert.equal(after.principal_remaining, 0);
    assert.equal(after.status, 'completed', 'ต้นหมดต้องปิดสัญญา แม้ปฏิทินดอกยังมีอีกหลายงวด');
  });
});
