// ค่าทำสัญญาเป็นรายได้ของพนักงานผู้เปิดสัญญา (สเปกข้อ 21, 29)
// กิจการถือเงินแทน: เข้ากระแสเงินสดแต่ไม่เข้ากำไร จ่ายให้พนักงานแล้วก็ไม่ใช่ค่าใช้จ่าย
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, closeDb, DOC_FEE_PAYOUT_CATEGORY } from '../src/db/index.js';
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

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const now = nowISO();
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)`,
    { h: hashPassword('Owner#Pass1'), now },
  );
  // พนักงานสองคน: ก (id 1) ดูแลลูกหนี้, ข (id 2) เป็นผู้เปิดสัญญาในบางเคส
  await run(`INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
             VALUES ('E001', 'พนักงาน ก', 1, :now, :now)`, { now });
  await run(`INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
             VALUES ('E002', 'พนักงาน ข', 1, :now, :now)`, { now });
  await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
             VALUES ('D001', 'ลูกหนี้ทดสอบ', 1, 'normal', :now, :now)`, { now });
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'Owner#Pass1' }),
  });
  sess.owner = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

async function balances() {
  const r = await api('owner', 'GET', '/api/admin/doc-fees');
  assert.equal(r.status, 200);
  return r.body.items;
}

describe('ค่าทำสัญญา — ไม่ใช่รายได้กิจการ (ข้อ 21)', () => {
  test('เปิดสัญญามีค่าทำสัญญา: เข้าเงินสด แต่ไม่เข้ากำไร', async () => {
    const D = '2032-01-05';
    const r = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 10000,
      deduct_first: false, start_date: D,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const s = await financeSummary({ from: D, to: D });
    assert.equal(s.doc_fee_collected, 10000, 'รับแทนพนักงาน 100 บาท');
    assert.equal(s.net_profit, 0, 'ค่าทำสัญญาต้องไม่โผล่ในกำไรกิจการ');
    // เงินสด: ปล่อยเต็ม 2,000 (ออก) − ค่าทำสัญญา 100 (เข้า) = ออกสุทธิ 1,900
    assert.equal(s.total_out - s.total_in, 190000, 'เงินสดออกสุทธิ = เงินที่ลูกค้าได้จริง');
  });

  test('เจ้าของค่าทำสัญญา = พนักงานผู้เปิดสัญญา ไม่ใช่ผู้ดูแลลูกหนี้ (ข้อ 29)', async () => {
    // ลูกหนี้อยู่กับพนักงาน ก แต่พนักงาน ข เป็นผู้เปิดสัญญา
    const r = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 5000,
      deduct_first: false, start_date: '2032-01-06',
      opened_by_employee_id: 2,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.contract.opened_by_employee_id, 2);

    const items = await balances();
    const b = items.find((x) => x.employee_id === 2);
    assert.equal(b.collected, 5000, 'ค่าทำสัญญาเข้าบัญชีพนักงาน ข ผู้เปิด');
  });

  test('สัญญาเก่าที่ไม่มีผู้เปิด (NULL) ตกเป็นของพนักงานผู้ดูแล', async () => {
    const items = await balances();
    const a = items.find((x) => x.employee_id === 1);
    // สัญญาแรก (100 บาท) ไม่ได้ระบุผู้เปิด → default = ผู้ดูแล (ก)
    assert.equal(a.collected, 10000);
  });

  test('ดอกลอยไม่มีค่าทำสัญญา (ข้อ 18) — ส่งมาก็ถูกบังคับเป็น 0', async () => {
    const r = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'floating', principal_amount: 1000000,
      installment_amount: 15000, interest_per_inst: 15000, num_installments: 12,
      doc_fee: 10000, start_date: '2032-01-07',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.preview.doc_fee, 0, 'ดอกลอยห้ามมีค่าทำสัญญา');
    assert.equal(r.body.contract.doc_fee, 0);
  });
});

describe('ค่าทำสัญญา — จ่ายให้พนักงาน (รับแล้ว/จ่ายแล้ว/ค้างจ่าย)', () => {
  test('จ่ายบางส่วน → ค้างจ่ายลด และไม่กระทบกำไร/ค่าใช้จ่ายดำเนินงาน', async () => {
    const D = '2032-02-01';
    const before = await financeSummary({ from: D, to: D });
    const r = await api('owner', 'POST', '/api/admin/doc-fees/payout', {
      employee_id: 1, amount: 6000, payout_date: D,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.entry.category, DOC_FEE_PAYOUT_CATEGORY);

    const items = await balances();
    const a = items.find((x) => x.employee_id === 1);
    assert.equal(a.paid_out, 6000);
    assert.equal(a.owed, 4000, 'รับแทน 100 − จ่าย 60 = ค้าง 40');

    const s = await financeSummary({ from: D, to: D });
    assert.equal(s.doc_fee_paid_out, 6000);
    assert.equal(s.operating_expense, before.operating_expense, 'ไม่ใช่ค่าใช้จ่ายดำเนินงาน');
    assert.equal(s.net_profit, before.net_profit, 'กำไรกิจการไม่กระทบ');
    assert.equal(s.total_out - before.total_out, 6000, 'แต่เป็นเงินสดออกจริง');
  });

  test('ห้ามจ่ายเกินยอดค้าง', async () => {
    const r = await api('owner', 'POST', '/api/admin/doc-fees/payout', {
      employee_id: 1, amount: 999999,
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /มากกว่าค่าทำสัญญาค้างจ่าย/);
  });

  test('ยกเลิกรายการจ่าย → ยอดค้างกลับมา (ไม่ลบถาวร)', async () => {
    const entry = await get(
      `SELECT id FROM expenses WHERE category = :c AND is_void = 0 ORDER BY id DESC LIMIT 1`,
      { c: DOC_FEE_PAYOUT_CATEGORY },
    );
    const r = await api('owner', 'POST', `/api/cashbook/expenses/${entry.id}/void`, {
      reason: 'บันทึกผิด',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const items = await balances();
    const a = items.find((x) => x.employee_id === 1);
    assert.equal(a.owed, 10000, 'ยกเลิกแล้วยอดค้างกลับมาเต็ม');
  });

  test('กรอกหมวดสงวนของระบบด้วยมือไม่ได้ (กันปลอมกำไร/ข้ามด่านยอดค้าง)', async () => {
    const inc = await api('owner', 'POST', '/api/cashbook/income', {
      category: 'ดอกเบี้ยรับรู้ตอนปิดสัญญา', amount: 999900,
    });
    assert.equal(inc.status, 400, 'กรอกรายรับดอกรับรู้เองไม่ได้');
    const exp = await api('owner', 'POST', '/api/cashbook/expenses', {
      category: DOC_FEE_PAYOUT_CATEGORY, amount: 999900,
    });
    assert.equal(exp.status, 400, 'กรอกรายจ่ายค่าทำสัญญาเองไม่ได้ (ข้ามด่านยอดค้าง)');
  });

  test('รียอด: ค่าทำสัญญาของสัญญาใหม่เข้าบัญชีพนักงานผู้ทำรายการ', async () => {
    // จ่ายสัญญาแรกไป 5 งวดแล้วรียอด ระบุผู้เปิดใหม่เป็นพนักงาน ข
    const { all } = await import('../src/db/index.js');
    const c = await get(`SELECT * FROM contracts WHERE doc_fee = 10000 ORDER BY id LIMIT 1`);
    const inst = await all(
      `SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`, { c: c.id },
    );
    for (const i of inst) {
      const p = await api('owner', 'POST', '/api/payments', {
        contract_id: c.id, amount_paid: i.due_amount, paid_date: i.due_date,
      });
      assert.equal(p.status, 201);
    }
    const beforeB = (await balances()).find((x) => x.employee_id === 2);
    const rey = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 50000, doc_fee: 3000,
      opened_by_employee_id: 2,
    });
    assert.equal(rey.status, 201, JSON.stringify(rey.body));
    assert.equal(rey.body.new_contract.opened_by_employee_id, 2);
    const afterB = (await balances()).find((x) => x.employee_id === 2);
    assert.equal(afterB.collected - beforeB.collected, 3000, 'ค่าทำสัญญารียอดเข้าบัญชี ข');
  });
});
