// จำลองการเดินธุรกิจจริง 90 วัน แล้วพิสูจน์ว่าตัวเลขทุกด้านลงตัว
//
// เทสต์ชุดนี้ไม่ได้ตรวจ "ฟังก์ชันทำงานไหม" (ชุดอื่นตรวจแล้ว) แต่ตรวจ
// "เมื่อใช้งานยาว ๆ แบบคนจริง ตัวเลขยังกระทบยอดกันได้หรือไม่"
process.env.FP_DB_PATH = ':memory:';

import { before, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { db, get, all, run, insert, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO, addDays, addMonths } from '../src/lib/time.js';
import { createContract, reyod, contractSummary } from '../src/domain/contracts.js';
import { recordPayment, voidPayment } from '../src/domain/payments.js';
import { financeSummary, closeDay, debtorStatusCounts, dueToday } from '../src/domain/reports.js';

const START = '2026-01-05';            // วันเริ่มจำลอง
const DAYS = 90;                       // ระยะเวลาจำลอง
const day = (n) => addDays(START, n);

let owner, collector, ctx, collectorCtx, empA, empB;
const contracts = [];                  // สัญญาทั้งหมดที่สร้างระหว่างจำลอง
let seed = 20260105;                   // ตัวสุ่มแบบกำหนดผลได้ ให้ผลเหมือนเดิมทุกครั้ง

/** ตัวสุ่มแบบ deterministic เพื่อให้เทสต์ได้ผลเดิมทุกครั้งที่รัน */
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const FIRST = ['สมชาย', 'สมหญิง', 'ประยุทธ์', 'วิภา', 'มานะ', 'ปรีชา', 'สุดา', 'อนงค์',
               'ธนา', 'กมล', 'ศิริพร', 'วิชัย', 'นภา', 'อรุณ', 'พิมพ์ใจ'];
const LAST  = ['ใจดี', 'ขยันงาน', 'มั่งมี', 'รักเรียน', 'ตั้งใจ', 'ศรีสุข', 'ทองดี', 'เจริญพร'];

before(async () => {
  await db();
  const now = nowISO();
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('owner', :h, 'เจ้าของกิจการ', 'owner', 1, :now, :now)`,
    { h: hashPassword('sim-owner-pass'), now },
  );
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('collector', :h, 'พนักงานเก็บเงิน', 'collector', 1, :now, :now)`,
    { h: hashPassword('sim-collect-pass'), now },
  );
  owner = await get(`SELECT * FROM users WHERE username = 'owner'`);
  collector = await get(`SELECT * FROM users WHERE username = 'collector'`);
  ctx = { user: owner, ip: 'sim' };
  collectorCtx = { user: collector, ip: 'sim' };

  await run(
    `INSERT INTO employees (user_id, code, full_name, area, is_active, created_at, updated_at)
     VALUES (:uid, 'E001', 'สมชาย เก็บเงิน', 'สายเหนือ', 1, :now, :now)`,
    { uid: collector.id, now },
  );
  await run(
    `INSERT INTO employees (code, full_name, area, is_active, created_at, updated_at)
     VALUES ('E002', 'สมหญิง เก็บเงิน', 'สายใต้', 1, :now, :now)`,
    { now },
  );
  empA = (await get(`SELECT id FROM employees WHERE code='E001'`)).id;
  empB = (await get(`SELECT id FROM employees WHERE code='E002'`)).id;

  // เงินทุนตั้งต้นของกิจการ 500,000 บาท
  await run(
    `INSERT INTO income_entries (entry_date, category, amount, description, created_by, created_at)
     VALUES (:d, 'capital', 50000000, 'เงินทุนตั้งต้น', :uid, :now)`,
    { d: START, uid: owner.id, now },
  );

  await runSimulation();
});

/** สร้างลูกหนี้ 1 ราย พร้อมสัญญา 1 ฉบับ ตามแบบที่ธุรกิจจริงใช้ */
async function openContract(dayIndex, type) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const emp = rnd() < 0.5 ? empA : empB;
  const debtorId = await insert(
    `INSERT INTO debtors (code, full_name, phone, employee_id, status, created_at, updated_at)
     VALUES (:code, :name, :phone, :emp, 'normal', :now, :now)`,
    {
      code: `D${String(contracts.length + 1).padStart(5, '0')}`,
      name,
      phone: `08${Math.floor(rnd() * 90000000 + 10000000)}`,
      emp,
      now: nowISO(),
    },
  );

  // เงื่อนไขที่ธุรกิจเงินทุนรายย่อยใช้จริง
  const spec = {
    daily24:  { principal: pick([100000, 200000, 300000, 500000]), inst: null, interest: null, n: 24 },
    monthly:  { principal: pick([1000000, 2000000, 3000000]),      inst: null, interest: null, n: 10 },
    floating: { principal: pick([500000, 1000000, 2000000]),       inst: 0,    interest: null, n: 12 },
  }[type];

  if (type === 'daily24') {
    spec.interest = Math.round(spec.principal * 0.02 / 100) * 100;   // ~2% ต่องวด
    spec.inst = spec.interest + Math.round(spec.principal / spec.n / 100) * 100;
  } else if (type === 'monthly') {
    spec.interest = Math.round(spec.principal * 0.02 / 100) * 100;
    spec.inst = spec.interest + Math.round(spec.principal / spec.n / 100) * 100;
  } else {
    spec.interest = Math.round(spec.principal * 0.05 / 100) * 100;   // ดอกลอย 5% ต่อรอบ
    spec.inst = spec.interest;
  }

  const { contract } = await createContract(
    {
      debtorId,
      employeeId: emp,
      type,
      principalAmount: spec.principal,
      installmentAmount: spec.inst,
      interestPerInst: spec.interest,
      numInstallments: spec.n,
      startDate: day(dayIndex),
    },
    ctx,
  );
  contracts.push(contract);
  return contract;
}

/** เดินเวลา 90 วัน: ปล่อยสัญญาใหม่ เก็บเงิน ลงค่าใช้จ่าย ปิดยอด และรียอด */
async function runSimulation() {
  for (let d = 0; d < DAYS; d++) {
    const today = day(d);

    // ปล่อยสัญญาใหม่เป็นระยะ
    if (d % 7 === 0) await openContract(d, 'daily24');
    if (d % 13 === 0) await openContract(d, 'daily24');
    if (d % 30 === 0) await openContract(d, 'monthly');
    if (d % 21 === 0) await openContract(d, 'floating');

    // เก็บเงินจากลูกหนี้ที่ครบกำหนดวันนี้
    const due = await dueToday({ date: today, limit: 500 });
    for (const row of due) {
      const r = rnd();
      let amount;
      if (r < 0.62) amount = row.due_remaining;                       // จ่ายเต็ม 62%
      else if (r < 0.78) amount = Math.min(row.due_remaining, await interestOf(row.contract_id)); // เฉพาะดอก 16%
      else if (r < 0.90) amount = Math.floor(row.due_remaining / 2 / 100) * 100;  // บางส่วน 12%
      else amount = 0;                                                // ไม่จ่าย 10%
      if (amount < 0) amount = 0;
      await recordPayment(
        { contractId: row.contract_id, amountPaid: amount, paidDate: today },
        collectorCtx,
      );
    }

    // ค่าใช้จ่ายประจำวันและรายเดือน
    if (d % 2 === 0) {
      await run(
        `INSERT INTO expenses (entry_date, category, amount, description, employee_id, created_by, created_at)
         VALUES (:d, 'ค่าน้ำมัน', :amt, 'ออกสายเก็บเงิน', :emp, :uid, :now)`,
        { d: today, amt: 20000 + Math.floor(rnd() * 20000), emp: empA, uid: owner.id, now: nowISO() },
      );
    }
    if (today.endsWith('-28')) {
      await run(
        `INSERT INTO expenses (entry_date, category, amount, description, created_by, created_at)
         VALUES (:d, 'เงินเดือน/ค่าแรง', 3000000, 'เงินเดือนพนักงาน', :uid, :now)`,
        { d: today, uid: owner.id, now: nowISO() },
      );
    }

    // ปิดยอดประจำวันทุกวัน (ตรงกับที่ SRS ข้อ 10.3 ต้องการ)
    const s = await financeSummary({ from: today, to: today });
    await closeDay({ date: today, actualCash: s.net_cash, note: 'ปิดยอดอัตโนมัติ (จำลอง)' }, ctx);
  }
}

async function interestOf(contractId) {
  const c = await get(`SELECT interest_per_inst FROM contracts WHERE id = :id`, { id: contractId });
  return c.interest_per_inst;
}

// =============================================================================
describe('จำลองธุรกิจจริง 90 วัน', () => {
  test('มีข้อมูลมากพอที่จะเชื่อผลได้', async () => {
    const d = await get(`SELECT COUNT(*)::int n FROM debtors`);
    const c = await get(`SELECT COUNT(*)::int n FROM contracts`);
    const p = await get(`SELECT COUNT(*)::int n FROM payments WHERE is_void = 0`);
    console.log(`      ลูกหนี้ ${d.n} ราย · สัญญา ${c.n} ฉบับ · รายการรับชำระ ${p.n} รายการ`);
    assert.ok(d.n >= 20, `ลูกหนี้น้อยไป (${d.n})`);
    assert.ok(p.n >= 300, `รายการรับชำระน้อยไป (${p.n})`);
  });

  test('เงินทุกสตางค์ลงตัว: ดอก + ต้น = ยอดรับจริง ทุกรายการ', async () => {
    const bad = await all(
      `SELECT id FROM payments WHERE interest_amount + principal_amount <> amount_paid`,
    );
    assert.equal(bad.length, 0, `พบ ${bad.length} รายการที่แบ่งต้น/ดอกไม่ตรงยอดรับ`);
  });

  test('เงินต้นคงเหลือของทุกสัญญาตรงกับเงินต้นที่รับคืนจริง', async () => {
    const rows = await all(`
      SELECT c.id, c.contract_no, c.principal_amount, c.principal_remaining, c.status,
             COALESCE((SELECT SUM(p.principal_amount) FROM payments p
                        WHERE p.contract_id = c.id AND p.is_void = 0), 0) AS paid_principal,
             COALESCE((SELECT l.carried_principal FROM contract_links l
                        WHERE l.from_contract_id = c.id), 0) AS carried_out
      FROM contracts c`);
    for (const r of rows) {
      // เงินต้นตามสัญญา = ที่รับคืนแล้ว + ที่ยกไปสัญญาใหม่ (ถ้ารียอด) + ที่ยังค้าง
      const expected = r.principal_amount - r.paid_principal - r.carried_out;
      const actual = r.principal_remaining;
      assert.equal(
        actual, expected,
        `${r.contract_no}: คงเหลือ ${actual} แต่ควรเป็น ${expected} ` +
        `(ต้น ${r.principal_amount} - รับคืน ${r.paid_principal} - ยกไป ${r.carried_out})`,
      );
    }
  });

  test('ไม่มีสัญญาใดมีเงินต้นคงเหลือติดลบ หรือเกินเงินต้นตามสัญญา (ข้อ 14)', async () => {
    const bad = await all(
      `SELECT contract_no, principal_remaining, principal_amount FROM contracts
       WHERE principal_remaining < 0 OR principal_remaining > principal_amount`,
    );
    assert.equal(bad.length, 0, JSON.stringify(bad));
  });

  test('ทุกงวดมียอดชำระไม่เกินยอดที่ต้องจ่าย', async () => {
    const bad = await all(
      `SELECT id, contract_id, seq FROM installments
       WHERE interest_paid > interest_due OR principal_paid > principal_due`,
    );
    assert.equal(bad.length, 0, `พบ ${bad.length} งวดที่ชำระเกินยอด`);
  });

  test('จ่ายเฉพาะดอกต้องไม่ทำให้เงินต้นลด (ข้อ 14)', async () => {
    const bad = await all(
      `SELECT id, receipt_no FROM payments
       WHERE is_void = 0 AND status = 'interest_only' AND principal_amount <> 0`,
    );
    assert.equal(bad.length, 0, `พบ ${bad.length} รายการเฉพาะดอกที่ไปตัดเงินต้น`);
  });

  test('กระแสเงินสดทั้งช่วงกระทบยอดได้', async () => {
    const from = START, to = day(DAYS);
    const f = await financeSummary({ from, to });

    const paid = await get(
      `SELECT COALESCE(SUM(amount_paid),0) v FROM payments WHERE is_void = 0 AND paid_date BETWEEN :from AND :to`,
      { from, to });
    const income = await get(
      `SELECT COALESCE(SUM(amount),0) v FROM income_entries WHERE is_void = 0 AND entry_date BETWEEN :from AND :to`,
      { from, to });
    const exp = await get(
      `SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE is_void = 0 AND entry_date BETWEEN :from AND :to`,
      { from, to });

    assert.equal(f.total_in, Number(paid.v) + Number(income.v), 'เงินเข้าไม่ตรงกับผลรวมรายการจริง');
    assert.equal(f.total_out, Number(exp.v), 'เงินออกไม่ตรงกับผลรวมรายจ่ายจริง');
    assert.equal(f.net_cash, f.total_in - f.total_out, 'เงินสดสุทธิคำนวณผิด');
  });

  test('กำไรสุทธิไม่ปนเงินต้นรับคืนและเงินทุน (เกณฑ์ข้อ 18)', async () => {
    const from = START, to = day(DAYS);
    const f = await financeSummary({ from, to });

    const interest = await get(
      `SELECT COALESCE(SUM(interest_amount),0) v FROM payments WHERE is_void = 0 AND paid_date BETWEEN :from AND :to`,
      { from, to });
    const docFee = await get(
      `SELECT COALESCE(SUM(amount),0) v FROM income_entries
       WHERE is_void = 0 AND category = 'doc_fee' AND entry_date BETWEEN :from AND :to`, { from, to });

    assert.equal(f.interest_income, Number(interest.v));
    assert.equal(f.doc_fee_income, Number(docFee.v));
    assert.equal(f.real_income, f.interest_income + f.doc_fee_income + f.other_income,
      'รายได้จริงต้องมีแค่ ดอก + ค่าเอกสาร + อื่น ๆ');
    assert.equal(f.net_profit, f.real_income - f.operating_expense);

    // เงินทุนตั้งต้น 500,000 ต้องไม่โผล่ในรายได้
    assert.equal(f.capital_in, 50000000, 'ต้องเห็นเงินทุนแยกไว้');
    assert.ok(f.other_income < 50000000, 'เงินทุนไม่ควรถูกนับเป็นรายได้อื่น');

    // เงินต้นรับคืนต้องมีจริงและต้องไม่อยู่ในรายได้
    assert.ok(f.principal_back > 0, 'ควรมีเงินต้นรับคืนบ้าง');
    assert.ok(f.real_income < f.cash_from_debtors,
      'รายได้จริงต้องน้อยกว่าเงินที่เก็บได้ เพราะส่วนหนึ่งเป็นเงินต้น');

    console.log(
      `      รายได้จริง ${(f.real_income/100).toLocaleString()} · ` +
      `ค่าใช้จ่าย ${(f.operating_expense/100).toLocaleString()} · ` +
      `กำไรสุทธิ ${(f.net_profit/100).toLocaleString()} บาท`);
    console.log(
      `      เงินต้นปล่อย ${(f.principal_issued/100).toLocaleString()} · ` +
      `รับคืน ${(f.principal_back/100).toLocaleString()} · ` +
      `คงเหลือในลูกหนี้ ${(f.principal_outstanding/100).toLocaleString()} บาท`);
  });

  test('ยอดรวมรายวันตลอด 90 วัน เท่ากับยอดรวมทั้งช่วง', async () => {
    let sumIn = 0, sumOut = 0, sumProfit = 0;
    for (let d = 0; d <= DAYS; d++) {
      const s = await financeSummary({ from: day(d), to: day(d) });
      sumIn += s.total_in; sumOut += s.total_out; sumProfit += s.net_profit;
    }
    const whole = await financeSummary({ from: START, to: day(DAYS) });
    assert.equal(sumIn, whole.total_in, 'ผลรวมเงินเข้ารายวันไม่ตรงกับทั้งช่วง');
    assert.equal(sumOut, whole.total_out, 'ผลรวมเงินออกรายวันไม่ตรงกับทั้งช่วง');
    assert.equal(sumProfit, whole.net_profit, 'ผลรวมกำไรรายวันไม่ตรงกับทั้งช่วง');
  });

  test('ยอดปิดวันที่บันทึกไว้ตรงกับที่คำนวณใหม่ภายหลัง', async () => {
    const closings = await all(`SELECT * FROM daily_closings ORDER BY closing_date`);
    assert.ok(closings.length >= DAYS, `ปิดยอดไม่ครบ (${closings.length}/${DAYS})`);
    for (const c of closings) {
      const s = await financeSummary({ from: c.closing_date, to: c.closing_date });
      assert.equal(c.system_cash, s.net_cash, `ยอดปิดวัน ${c.closing_date} ไม่ตรงกับที่คำนวณใหม่`);
      assert.equal(c.difference, c.actual_cash - c.system_cash, 'ส่วนต่างคำนวณผิด');
    }
  });

  test('รียอดกลางคัน: ยอดใหม่ถูกต้องและเงินต้นไม่หายไปจากระบบ', async () => {
    const target = await get(
      `SELECT * FROM contracts WHERE status = 'active' AND principal_remaining > 10000 LIMIT 1`);
    assert.ok(target, 'ต้องมีสัญญาที่ยังผ่อนอยู่');

    const before = await financeSummary({ from: '1900-01-01', to: '2999-12-31' });
    const carried = target.principal_remaining;
    const newMoney = 200000;

    const r = await reyod(
      { fromContractId: target.id, newMoney, startDate: day(DAYS) }, ctx);

    assert.equal(r.new_contract.principal_amount, carried + newMoney, 'ยอดสัญญาใหม่ผิด');
    assert.equal(r.old_contract.status, 'closed_reyod');
    assert.equal(r.old_contract.principal_remaining, 0, 'สัญญาเดิมต้องยกยอดออกหมด');

    const after = await financeSummary({ from: '1900-01-01', to: '2999-12-31' });
    // เงินต้นคงเหลือรวมต้องเพิ่มขึ้นเท่ากับเงินเพิ่มใหม่ ลบด้วยงวดแรกที่หักทันที
    const firstInst = r.preview.first_installment;
    const expectedDelta = newMoney - (r.preview.principalAmount > 0
      ? Math.min(firstInst - r.new_contract.interest_per_inst, carried + newMoney) : 0);
    assert.ok(
      after.principal_outstanding > before.principal_outstanding,
      'เงินต้นคงเหลือรวมควรเพิ่มขึ้นหลังรียอดพร้อมเงินเพิ่ม');
    void expectedDelta;
  });

  test('ยกเลิกรายการรับเงินแล้วยอดกลับสู่สภาพเดิมทุกด้าน', async () => {
    const p = await get(
      `SELECT * FROM payments WHERE is_void = 0 AND principal_amount > 0
       ORDER BY id DESC LIMIT 1`);
    const cBefore = await get(
      `SELECT principal_remaining FROM contracts WHERE id = :id`, { id: p.contract_id });
    const fBefore = await financeSummary({ from: p.paid_date, to: p.paid_date });

    await voidPayment({ paymentId: p.id, reason: 'ทดสอบการย้อนยอด' }, ctx);

    const cAfter = await get(
      `SELECT principal_remaining FROM contracts WHERE id = :id`, { id: p.contract_id });
    const fAfter = await financeSummary({ from: p.paid_date, to: p.paid_date });

    assert.equal(cAfter.principal_remaining, cBefore.principal_remaining + p.principal_amount,
      'เงินต้นไม่ถูกคืนกลับ');
    assert.equal(fAfter.cash_from_debtors, fBefore.cash_from_debtors - p.amount_paid,
      'เงินสดรับไม่ถูกหักออก');
    assert.equal(fAfter.interest_income, fBefore.interest_income - p.interest_amount,
      'ดอกเบี้ยไม่ถูกหักออก');

    const voided = await get(`SELECT * FROM payments WHERE id = :id`, { id: p.id });
    assert.equal(voided.is_void, 1);
    assert.ok(voided.voided_at, 'ต้องบันทึกเวลาที่ยกเลิก');
    assert.equal(voided.voided_by, owner.id, 'ต้องบันทึกผู้ยกเลิก');
  });

  test('ทุกการเคลื่อนไหวมี Audit Log (ข้อ 15)', async () => {
    const cCount = (await get(`SELECT COUNT(*)::int n FROM contracts`)).n;
    const cLog = (await get(
      `SELECT COUNT(*)::int n FROM audit_logs WHERE entity='contract' AND action='create'`)).n;
    assert.ok(cLog >= cCount - 1, `Audit ของสัญญาไม่ครบ (${cLog}/${cCount})`);

    const pCount = (await get(`SELECT COUNT(*)::int n FROM payments`)).n;
    const pLog = (await get(
      `SELECT COUNT(*)::int n FROM audit_logs WHERE entity='payment' AND action='create'`)).n;
    assert.equal(pLog, pCount, `Audit ของการรับชำระไม่ครบ (${pLog}/${pCount})`);

    const voidLog = await get(
      `SELECT * FROM audit_logs WHERE entity='payment' AND action='void' ORDER BY id DESC LIMIT 1`);
    assert.ok(voidLog?.reason, 'การยกเลิกต้องมีเหตุผลบันทึกไว้');
    assert.ok(voidLog.before_json && voidLog.after_json, 'ต้องเก็บทั้งค่าเดิมและค่าใหม่');
  });

  test('ไม่มีรายการการเงินใดถูกลบถาวร (ข้อ 15)', async () => {
    // เลขที่ใบรับเงินต้องเรียงต่อเนื่องไม่มีหาย แม้จะมีรายการที่ถูกยกเลิก
    const all_ = await all(`SELECT receipt_no FROM payments ORDER BY id`);
    const byDate = {};
    for (const r of all_) {
      const [, ymd, seq] = r.receipt_no.split('-');
      (byDate[ymd] ??= []).push(Number(seq));
    }
    for (const [ymd, seqs] of Object.entries(byDate)) {
      seqs.sort((a, b) => a - b);
      for (let i = 0; i < seqs.length; i++) {
        assert.equal(seqs[i], i + 1, `ใบรับเงินวันที่ ${ymd} เลขขาดหาย — อาจมีการลบข้อมูล`);
      }
    }
  });

  test('เลขที่เอกสารไม่ซ้ำเลยแม้สร้างจำนวนมาก', async () => {
    const c = await get(
      `SELECT COUNT(*)::int total, COUNT(DISTINCT contract_no)::int uniq FROM contracts`);
    assert.equal(c.total, c.uniq, 'มีเลขที่สัญญาซ้ำ');
    const p = await get(
      `SELECT COUNT(*)::int total, COUNT(DISTINCT receipt_no)::int uniq FROM payments`);
    assert.equal(p.total, p.uniq, 'มีเลขที่ใบรับเงินซ้ำ');
  });

  test('สถานะลูกหนี้แยกกลุ่มได้ถูกต้องและรวมกันครบ', async () => {
    const s = await debtorStatusCounts({ asOf: day(DAYS) });
    const sum = s.normal + s.interest_only + s.partial + s.overdue + s.completed + s.reyod;
    assert.equal(sum, s.total, 'ผลรวมแต่ละกลุ่มไม่เท่ากับยอดรวม');
    console.log(
      `      ปกติ ${s.normal} · เฉพาะดอก ${s.interest_only} · บางส่วน ${s.partial} · ` +
      `ค้างชำระ ${s.overdue} · ครบสัญญา ${s.completed} · รียอด ${s.reyod}`);
  });

  test('รายงานพนักงานรวมกันแล้วตรงกับยอดเก็บทั้งหมด', async () => {
    const { employeeReport } = await import('../src/domain/reports.js');
    const rows = await employeeReport({ from: START, to: day(DAYS) });
    const sum = rows.reduce((a, r) => a + Number(r.collected), 0);
    const total = await get(
      `SELECT COALESCE(SUM(p.amount_paid),0) v FROM payments p
       JOIN contracts c ON c.id = p.contract_id
       WHERE p.is_void = 0 AND p.paid_date BETWEEN :from AND :to AND c.employee_id IS NOT NULL`,
      { from: START, to: day(DAYS) });
    assert.equal(sum, Number(total.v), 'ยอดเก็บรายพนักงานรวมไม่ตรงกับยอดรวมจริง');
  });
});
