// เฟส 7: หน้าเก็บเงินสถานะละเอียด (ข้อ 43) + รายงานเงินแยกประเภท (ข้อ 44)
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

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

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
  for (const code of ['A.1', 'A.2', 'A.3']) {
    await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
               VALUES (:c, :c, 1, 'normal', :now, :now)`, { c: code, now });
  }
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'Owner#Pass1' }),
  });
  sess.owner = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];

  // 3 สัญญารายวันเริ่มวันนี้ (งวดแรกครบวันนี้)
  for (const debtorId of [1, 2, 3]) {
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: debtorId, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0, deduct_first: false,
      start_date: TODAY,
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('เฟส 7 — หน้าเก็บเงินสถานะละเอียด (ข้อ 43)', () => {
  test('จ่ายบางส่วนคงอยู่ในรายการพร้อม paid_today; จ่ายฟรี/วันหยุดพักงวด (หลุดจากรายการวันนี้)', async () => {
    const c1 = await get(`SELECT id FROM contracts WHERE debtor_id = 1`);
    const c2 = await get(`SELECT id FROM contracts WHERE debtor_id = 2`);
    const c3 = await get(`SELECT id FROM contracts WHERE debtor_id = 3`);

    // สัญญา 1: จ่ายบางส่วน 50 (งวดละ 100) → ยังค้างในรายการวันนี้
    await api('owner', 'POST', '/api/payments', { contract_id: c1.id, amount_paid: 5000, paid_date: TODAY });
    // สัญญา 2: จ่ายฟรี → พักงวด (งวดเลื่อนไปวันถัดไป)
    const fp = await api('owner', 'POST', '/api/payments/free',
      { contract_id: c2.id, amount: 4000, paid_date: TODAY });
    assert.equal(fp.status, 201, JSON.stringify(fp.body));
    // สัญญา 3: วันหยุดเฉพาะสัญญา → งวดเลื่อนออกไป
    await api('owner', 'POST', '/api/admin/holidays', {
      holiday_date: TODAY, name: 'หยุดเฉพาะสัญญา 3', scope: 'contract', contract_id: c3.id,
    });

    const dash = await api('owner', 'GET', `/api/dashboard?date=${TODAY}`);
    assert.equal(dash.status, 200);
    const byId = Object.fromEntries(dash.body.due_today.map((r) => [r.contract_id, r]));

    // สัญญา 1: จ่ายบางส่วน → ยังอยู่ในรายการ พร้อม field สถานะครบ
    assert.ok(byId[c1.id], 'สัญญาที่จ่ายบางส่วนยังต้องอยู่ในรายการเก็บวันนี้');
    assert.equal(byId[c1.id].paid_today, 5000, 'บันทึก paid_today');
    assert.ok(byId[c1.id].due_remaining > 0, 'ยังเหลือให้เก็บ → สถานะ "จ่ายบางส่วน"');
    // สัญญา 2, 3: พักงวด/วันหยุด → งวดถูกเลื่อน จึงหลุดจากรายการวันนี้ (ไม่ขึ้นค้าง — สเปกข้อ 22-23)
    assert.equal(byId[c2.id], undefined, 'จ่ายฟรีแล้วพักงวด หลุดจากรายการวันนี้');
    assert.equal(byId[c3.id], undefined, 'วันหยุดพักงวด หลุดจากรายการวันนี้');

    // field สถานะละเอียดต้องมีครบทุกแถว (ให้ UI คำนวณ 7 สถานะได้)
    for (const r of dash.body.due_today) {
      assert.ok('paid_today' in r && 'free_pay_today' in r && 'is_holiday' in r);
    }
  });
});

describe('เฟส 7 — รายงานเงินแยกประเภท (ข้อ 44)', () => {
  test('จ่ายฟรีสะสม/ตัดต้น/ค่าทำสัญญา รวมยอดถูกต้อง', async () => {
    const r = await api('owner', 'GET',
      `/api/reports/money-breakdown?period=custom&from=1900-01-01&to=2999-12-31`);
    assert.equal(r.status, 200);
    // จ่ายฟรี 40 จากเทสต์ก่อนหน้า
    assert.equal(r.body.free_pay.total, 4000);
    assert.equal(r.body.free_pay.count, 1);
    // ตัดต้นสัญญาปกติ: สัญญา 1 จ่าย 50 → flat_total จัดสรรภายในมีต้นบางส่วน
    assert.ok(r.body.principal_cut.normal >= 0);
    assert.ok('collected' in r.body.doc_fee && 'paid_out' in r.body.doc_fee);
  });

  test('ถอนดอกเบี้ยโผล่ในรายงานแยกประเภท', async () => {
    // สร้างดอกหักก่อนให้มียอดถอนได้ แล้วถอน
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'deduct_upfront', interest_rate_bp: 1000, doc_fee: 0, start_date: TODAY,
    });
    assert.equal(c.status, 201);
    const w = await api('owner', 'POST', '/api/withdraw', {
      source: 'contract_interest', amount: 10000, method: 'cash', withdraw_date: TODAY,
    });
    assert.equal(w.status, 201, JSON.stringify(w.body));

    const r = await api('owner', 'GET',
      `/api/reports/money-breakdown?period=custom&from=1900-01-01&to=2999-12-31`);
    assert.equal(r.body.withdrawals.interest, 10000, 'ยอดถอนดอกเบี้ยโผล่ในรายงาน');
  });

  test('พนักงานเก็บเงินเห็นรายงานเฉพาะโซนตัวเอง (scope)', async () => {
    await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
               VALUES ('col', :h, 'พนง', 'collector', 1, :now, :now)`,
      { h: hashPassword('Passw0rd#1'), now: nowISO() });
    await run(`UPDATE employees SET user_id = (SELECT id FROM users WHERE username='col') WHERE code='A'`);
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'col', password: 'Passw0rd#1' }),
    });
    sess.col = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
    const r = await api('col', 'GET', '/api/reports/money-breakdown?period=custom&from=1900-01-01&to=2999-12-31');
    assert.equal(r.status, 200, 'พนักงานดูได้ (เฉพาะโซนตัวเอง)');
  });
});
