// ระบบถอนดอกเบี้ย (สเปกข้อ 33-40)
// คงเหลือ = รับรู้สะสม − ถอนสะสม · ดอกลอยแยกแหล่ง · กันถอนเกิน · ยกเลิกได้ไม่ลบถาวร
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, all, closeDb, WITHDRAW_INTEREST_CATEGORY } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO } from '../src/lib/time.js';
import { financeSummary } from '../src/domain/reports.js';

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

async function login(username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
}

async function overview() {
  const r = await api('owner', 'GET', '/api/withdraw');
  assert.equal(r.status, 200);
  return r.body;
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
  await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
             VALUES ('collector', :h, 'พนักงาน', 'collector', 1, :now, :now)`,
    { h: hashPassword('Collect#Pass1'), now });
  // สองโซน: A = พี่อ้อย (emp 1), B = ออย (emp 2)
  await run(`INSERT INTO employees (code, full_name, area, is_active, created_at, updated_at)
             VALUES ('A', 'พี่อ้อย', 'Zone A', 1, :now, :now)`, { now });
  await run(`INSERT INTO employees (code, full_name, area, is_active, created_at, updated_at)
             VALUES ('B', 'ออย', 'Zone B', 1, :now, :now)`, { now });
  await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
             VALUES ('A.1', 'ลูกหนี้โซน A', 1, 'normal', :now, :now)`, { now });
  await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
             VALUES ('B.1', 'ลูกหนี้โซน B', 2, 'normal', :now, :now)`, { now });
  sess.owner = await login('owner', 'Owner#Pass1');
  sess.collector = await login('collector', 'Collect#Pass1');

  // สร้างดอกรับรู้: โซน A = 300 (หักดอกก่อน 3,000@10%), โซน B = 200 (หักดอกก่อน 2,000@10%)
  // ทั้งคู่รับรู้ทันทีวันเปิดสัญญา (สเปกข้อ 15) — เป็นฐานของตัวอย่างข้อ 36
  const a = await api('owner', 'POST', '/api/contracts', {
    debtor_id: 1, type: 'daily24', principal_amount: 300000, num_installments: 20,
    interest_mode: 'deduct_upfront', interest_rate_bp: 1000, doc_fee: 0,
    start_date: '2033-01-05',
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await api('owner', 'POST', '/api/contracts', {
    debtor_id: 2, employee_id: 2, type: 'daily24', principal_amount: 200000, num_installments: 20,
    interest_mode: 'deduct_upfront', interest_rate_bp: 1000, doc_fee: 0,
    start_date: '2033-01-05',
  });
  assert.equal(b.status, 201, JSON.stringify(b.body));

  // รายได้ดอกลอยโซน A = 150 (จ่ายดอกหนึ่งรอบ)
  const f = await api('owner', 'POST', '/api/contracts', {
    debtor_id: 1, type: 'floating', principal_amount: 1000000,
    installment_amount: 15000, interest_per_inst: 15000, num_installments: 12,
    doc_fee: 0, deduct_first: false, start_date: '2033-01-06',
  });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  const pay = await api('owner', 'POST', '/api/payments', {
    contract_id: f.body.contract.id, amount_paid: 15000, paid_date: '2033-01-06',
  });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe('ถอนดอกเบี้ย — บัญชีรับรู้/คงเหลือ (ข้อ 34, 37, 39)', () => {
  test('รับรู้สะสมถูกต้อง และดอกลอยแยกจากดอกตามสัญญา', async () => {
    const d = await overview();
    assert.equal(d.total.contract_interest.recognized, 50000, 'ดอกตามสัญญา A 300 + B 200');
    assert.equal(d.total.floating_interest.recognized, 15000, 'ดอกลอย 150 แยกแหล่ง');
    assert.equal(d.total.contract_interest.remaining, 50000);

    const zoneA = d.zones.find((z) => z.employee.code === 'A');
    const zoneB = d.zones.find((z) => z.employee.code === 'B');
    assert.equal(zoneA.balance.contract_interest.remaining, 30000, 'Zone A คงเหลือ 300');
    assert.equal(zoneB.balance.contract_interest.remaining, 20000, 'Zone B คงเหลือ 200');
    assert.equal(zoneA.balance.floating_interest.remaining, 15000);
  });

  test('ข้อ 37: ดอกสัญญาเหมารวมที่ยังไม่ปิด/ไม่รียอด ไม่อยู่ในยอดที่ถอนได้', async () => {
    // เปิด flat 2,000@20% แล้วจ่าย 5 งวด — ดอกยังไม่รับรู้ (รับรู้ตอนปิด/รียอดเท่านั้น)
    const c = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 24,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0, deduct_first: false,
      start_date: '2033-02-01',
    });
    assert.equal(c.status, 201);
    const inst = await all(
      `SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`,
      { c: c.body.contract.id },
    );
    for (const i of inst) {
      await api('owner', 'POST', '/api/payments', {
        contract_id: c.body.contract.id, amount_paid: i.due_amount, paid_date: i.due_date,
      });
    }
    const d = await overview();
    assert.equal(d.total.contract_interest.recognized, 50000,
      'จ่าย 5 งวดของสัญญาเหมารวมต้องไม่เพิ่มยอดรับรู้แม้แต่สตางค์เดียว (ข้อ 37)');
  });
});

describe('ถอนดอกเบี้ย — ถอน/กันเกิน/ยกเลิก (ข้อ 35, 36, 38, 40)', () => {
  test('ตัวอย่างข้อ 36: A เหลือ 300, B เหลือ 200 → ถอนจาก A 100 → A 200, B 200, รวม 400', async () => {
    const r = await api('owner', 'POST', '/api/withdraw', {
      source: 'contract_interest', amount: 10000, employee_id: 1,
      method: 'cash', note: 'ถอนตามตัวอย่างสเปก', withdraw_date: '2033-03-01',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.entry.category, WITHDRAW_INTEREST_CATEGORY);
    assert.match(r.body.entry.description, /เงินสด/);

    const d = await overview();
    const zoneA = d.zones.find((z) => z.employee.code === 'A');
    const zoneB = d.zones.find((z) => z.employee.code === 'B');
    assert.equal(zoneA.balance.contract_interest.remaining, 20000, 'Zone A เหลือ 200');
    assert.equal(zoneB.balance.contract_interest.remaining, 20000, 'Zone B เหลือ 200');
    assert.equal(d.total.contract_interest.remaining, 40000, 'รวมเหลือ 400');
  });

  test('การถอนไม่กระทบกำไร/ค่าใช้จ่ายดำเนินงาน แต่เป็นเงินสดออกจริง (ข้อ 33)', async () => {
    const D = '2033-03-01';
    const s = await financeSummary({ from: D, to: D });
    assert.equal(s.interest_withdrawn, 10000, 'ยอดถอนของวัน');
    assert.equal(s.operating_expense, 0, 'ไม่ปนค่าใช้จ่ายดำเนินงาน');
    assert.equal(s.net_profit, 0, 'กำไรไม่กระทบ');
    assert.equal(s.total_out, 10000, 'แต่เงินสดออกจริง');
  });

  test('ข้อ 38: ถอนเกินคงเหลือถูกกัน — เจ้าของ override ได้เมื่อมีเหตุผล', async () => {
    const over = await api('owner', 'POST', '/api/withdraw', {
      source: 'contract_interest', amount: 999999, method: 'cash',
    });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /มากกว่า.*คงเหลือ/);

    // override โดยไม่มีเหตุผล → ยังไม่ได้
    const noReason = await api('owner', 'POST', '/api/withdraw', {
      source: 'contract_interest', amount: 999999, method: 'cash', owner_override: true,
    });
    assert.equal(noReason.status, 400);

    // override พร้อมเหตุผล → บันทึกได้ (รายการปรับปรุงพิเศษ)
    const ok = await api('owner', 'POST', '/api/withdraw', {
      source: 'contract_interest', amount: 45000, method: 'transfer',
      owner_override: true, reason: 'ปรับปรุงยอดตามการตรวจนับจริง', withdraw_date: '2033-03-02',
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.match(ok.body.entry.description, /ปรับปรุงพิเศษ/);
    // ยกเลิกทิ้งเพื่อไม่ให้กระทบเทสต์ถัดไป
    const undo = await api('owner', 'POST', `/api/cashbook/expenses/${ok.body.entry.id}/void`, {
      reason: 'ล้างรายการทดสอบ',
    });
    assert.equal(undo.status, 200);
  });

  test('ข้อ 39: ถอนดอกลอยเช็คกับยอดดอกลอย ไม่ปนกับดอกตามสัญญา', async () => {
    // ดอกลอยเหลือ 150 — ถอน 200 ต้องโดนกัน แม้ดอกตามสัญญายังเหลือ 400
    const over = await api('owner', 'POST', '/api/withdraw', {
      source: 'floating_interest', amount: 20000, method: 'cash',
    });
    assert.equal(over.status, 400, 'ดอกลอยมีแค่ 150 ถอน 200 ไม่ได้');

    const ok = await api('owner', 'POST', '/api/withdraw', {
      source: 'floating_interest', amount: 15000, method: 'cash', withdraw_date: '2033-03-03',
    });
    assert.equal(ok.status, 201);
    const d = await overview();
    assert.equal(d.total.floating_interest.remaining, 0);
    assert.equal(d.total.contract_interest.remaining, 40000, 'ดอกตามสัญญาไม่ถูกแตะ');
  });

  test('ข้อ 40: ยกเลิกรายการถอน → ยอดคืนอัตโนมัติ ไม่ลบถาวร', async () => {
    const entry = await get(
      `SELECT id FROM expenses WHERE category = :c AND is_void = 0 ORDER BY id LIMIT 1`,
      { c: WITHDRAW_INTEREST_CATEGORY },
    );
    const before = (await overview()).total.contract_interest.remaining;
    const r = await api('owner', 'POST', `/api/cashbook/expenses/${entry.id}/void`, {
      reason: 'บันทึกผิดจำนวน',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await overview();
    assert.equal(after.total.contract_interest.remaining, before + 10000, 'ยอดคืนเข้าคงเหลือ');
    const row = await get(`SELECT * FROM expenses WHERE id = :id`, { id: entry.id });
    assert.equal(row.is_void, 1, 'รายการยังอยู่ ไม่ถูกลบ');
    assert.ok(row.void_reason, 'เก็บเหตุผลการยกเลิก');
  });

  test('กรอกมือหมวดถอนจากสมุดเงินสดไม่ได้ (ต้องผ่านด่านกันถอนเกิน)', async () => {
    const r = await api('owner', 'POST', '/api/cashbook/expenses', {
      category: WITHDRAW_INTEREST_CATEGORY, amount: 999900,
    });
    assert.equal(r.status, 400);
  });

  test('พนักงานเก็บเงินเข้าเมนูถอนเงินไม่ได้ (ข้อ 45)', async () => {
    const g = await api('collector', 'GET', '/api/withdraw');
    assert.equal(g.status, 403);
    const p = await api('collector', 'POST', '/api/withdraw', {
      source: 'contract_interest', amount: 100, method: 'cash',
    });
    assert.equal(p.status, 403);
  });
});
