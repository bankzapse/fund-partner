// backlog ข้อ 10: ยกเลิกสัญญาที่เปิดผิด → void รายการอัตโนมัติคู่สัญญาทั้งหมด
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

async function login(username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
}

const START = '2035-09-01';

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
             VALUES ('mgr', :h, 'ผจก', 'manager', 1, :now, :now)`,
    { h: hashPassword('Mgr#Pass1'), now });
  await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
             VALUES ('col', :h, 'พนง', 'collector', 1, :now, :now)`,
    { h: hashPassword('Col#Pass1'), now });
  await run(`INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
             VALUES ('A', 'พี่อ้อย', 1, :now, :now)`, { now });
  for (const code of ['A.1', 'A.2', 'A.3']) {
    await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
               VALUES (:c, :c, 1, 'normal', :now, :now)`, { c: code, now });
  }
  sess.owner = await login('owner', 'Owner#Pass1');
  sess.mgr = await login('mgr', 'Mgr#Pass1');
  sess.col = await login('col', 'Col#Pass1');
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

async function openContract(debtorId, extra = {}) {
  const c = await api('owner', 'POST', '/api/contracts', {
    debtor_id: debtorId, type: 'daily24', principal_amount: 200000, num_installments: 20,
    interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 5000, deduct_first: true,
    start_date: START, ...extra,
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  return c.body.contract;
}

async function breakdown() {
  const r = await api('owner', 'GET',
    '/api/reports/money-breakdown?period=custom&from=1900-01-01&to=2999-12-31');
  return r.body;
}

describe('backlog ข้อ 10 — ยกเลิกสัญญาที่เปิดผิด', () => {
  test('ยกเลิกแล้ว void ทุกรายการคู่สัญญา + สถานะ cancelled + เงินต้น 0', async () => {
    const c = await openContract(1);
    // ก่อนยกเลิก: มีเงินปล่อย(รายจ่าย) + ค่าเอกสาร(รายรับ) + งวดแรก(รับเงิน) จริง
    const before = await breakdown();
    assert.ok(before.doc_fee.collected >= 5000, 'ก่อนยกเลิกมีค่าทำสัญญา');
    const paysBefore = await all(`SELECT COUNT(*)::int AS n FROM payments WHERE contract_id = :c AND is_void = 0`, { c: c.id });
    assert.ok(Number(paysBefore[0].n) >= 1, 'มีรายการรับเงินงวดแรก');
    const expBefore = await all(`SELECT COUNT(*)::int AS n FROM expenses WHERE contract_id = :c AND is_void = 0`, { c: c.id });
    assert.ok(Number(expBefore[0].n) >= 1, 'มีรายจ่ายเงินปล่อย');

    const r = await api('owner', 'POST', `/api/contracts/${c.id}/cancel`, { reason: 'เปิดผิดคน' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.contract.status, 'cancelled');
    assert.equal(r.body.contract.principal_remaining, 0);

    // ทุกรายการคู่สัญญาถูก void หมด
    const pays = await all(`SELECT COUNT(*)::int AS n FROM payments WHERE contract_id = :c AND is_void = 0`, { c: c.id });
    assert.equal(Number(pays[0].n), 0, 'รับเงินถูกยกเลิกหมด');
    const inc = await all(`SELECT COUNT(*)::int AS n FROM income_entries WHERE contract_id = :c AND is_void = 0`, { c: c.id });
    assert.equal(Number(inc[0].n), 0, 'รายรับถูกยกเลิกหมด');
    const exp = await all(`SELECT COUNT(*)::int AS n FROM expenses WHERE contract_id = :c AND is_void = 0`, { c: c.id });
    assert.equal(Number(exp[0].n), 0, 'รายจ่ายถูกยกเลิกหมด');
    const inst = await all(`SELECT COUNT(*)::int AS n FROM installments
                            WHERE contract_id = :c AND (interest_paid > 0 OR principal_paid > 0)`, { c: c.id });
    assert.equal(Number(inst[0].n), 0, 'งวดถูกล้างยอดชำระกลับ');

    // รายงานเงินแยกประเภทกลับมาเป็น 0 (เหมือนไม่เคยเปิดสัญญานี้)
    const afterB = await breakdown();
    assert.equal(afterB.doc_fee.collected, before.doc_fee.collected - 5000, 'ค่าทำสัญญาถูกหักกลับ');
  });

  test('ยกเลิกแล้วสัญญาหลุดจากยอดเงินต้นคงเหลือ + รายการเก็บวันนี้', async () => {
    const c = await openContract(2, { start_date: '2035-09-02' });
    const dashBefore = await api('owner', 'GET', '/api/dashboard?date=2035-09-02');
    assert.ok(dashBefore.body.capital.principal_outstanding > 0, 'ก่อนยกเลิกมีเงินต้นคงเหลือ');

    const r = await api('owner', 'POST', `/api/contracts/${c.id}/cancel`, { reason: 'ลูกค้ายกเลิก' });
    assert.equal(r.status, 200);

    const dashAfter = await api('owner', 'GET', '/api/dashboard?date=2035-09-02');
    assert.equal(dashAfter.body.capital.principal_outstanding, 0, 'เงินต้นคงเหลือกลับเป็น 0');
    const inDue = dashAfter.body.due_today.some((x) => x.contract_id === c.id);
    assert.equal(inDue, false, 'สัญญาที่ยกเลิกไม่ขึ้นในรายการเก็บวันนี้');
  });

  test('ต้องระบุเหตุผล + ยกเลิกซ้ำไม่ได้', async () => {
    const c = await openContract(3, { start_date: '2035-09-03' });
    const noReason = await api('owner', 'POST', `/api/contracts/${c.id}/cancel`, {});
    assert.equal(noReason.status, 400, 'ไม่ระบุเหตุผล → 400');

    const ok = await api('owner', 'POST', `/api/contracts/${c.id}/cancel`, { reason: 'ทดสอบ' });
    assert.equal(ok.status, 200);
    const again = await api('owner', 'POST', `/api/contracts/${c.id}/cancel`, { reason: 'อีกรอบ' });
    assert.equal(again.status, 400, 'ยกเลิกซ้ำไม่ได้');
    assert.match(again.body.error, /ยกเลิกไปแล้ว/);
  });

  test('สัญญาที่รียอดแล้ว/เกิดจากรียอด ยกเลิกไม่ได้', async () => {
    const old = await openContract(1, { start_date: '2035-09-10' });
    const rey = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: old.id, new_money: 100000, type: 'daily24', num_installments: 20,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0, start_date: '2035-09-11',
    });
    assert.equal(rey.status, 201, JSON.stringify(rey.body));
    const newId = rey.body.new_contract.id;

    const cancelOld = await api('owner', 'POST', `/api/contracts/${old.id}/cancel`, { reason: 'x' });
    assert.equal(cancelOld.status, 400, 'สัญญาที่ถูกรียอดไปแล้ว ยกเลิกไม่ได้');
    const cancelNew = await api('owner', 'POST', `/api/contracts/${newId}/cancel`, { reason: 'x' });
    assert.equal(cancelNew.status, 400, 'สัญญาที่เกิดจากรียอด ยกเลิกไม่ได้ (ผูกยอดกับสัญญาเดิม)');
    assert.match(cancelNew.body.error, /รียอด/);
  });

  test('สิทธิ์: พนักงานเก็บเงินยกเลิกไม่ได้ (403) · ผู้จัดการต้องขออนุมัติ (202) แล้วเจ้าของอนุมัติ', async () => {
    const c = await openContract(2, { start_date: '2035-09-20' });

    const col = await api('col', 'POST', `/api/contracts/${c.id}/cancel`, { reason: 'x' });
    assert.equal(col.status, 403, 'พนักงานเก็บเงินไม่มีสิทธิ์');

    const mgr = await api('mgr', 'POST', `/api/contracts/${c.id}/cancel`, { reason: 'ผจก.ขอยกเลิก' });
    assert.equal(mgr.status, 202, 'ผู้จัดการ → เข้าคิวอนุมัติ');
    assert.ok(mgr.body.pending_approval?.id);
    // ยังไม่ยกเลิกจนกว่าจะอนุมัติ
    const mid = await get(`SELECT status FROM contracts WHERE id = :c`, { c: c.id });
    assert.equal(mid.status, 'active', 'ระหว่างรออนุมัติ สัญญายังไม่ถูกยกเลิก');

    const decide = await api('owner', 'POST', `/api/admin/approvals/${mgr.body.pending_approval.id}/decide`,
      { approve: true });
    assert.equal(decide.status, 200, JSON.stringify(decide.body));
    const done = await get(`SELECT status FROM contracts WHERE id = :c`, { c: c.id });
    assert.equal(done.status, 'cancelled', 'เจ้าของอนุมัติแล้วสัญญาถูกยกเลิกจริง');
  });
});
