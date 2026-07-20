// เกณฑ์ทดสอบรับมอบงาน — SRS ข้อ 18 (หนึ่งเทสต์ต่อหนึ่งบรรทัดในตาราง)
process.env.FP_DB_PATH = ':memory:';

import { before, beforeEach, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { db, get, run, insert, all, setSetting, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO, today, addDays } from '../src/lib/time.js';
import { createContract, reyod, contractSummary, previewContract } from '../src/domain/contracts.js';
import { recordPayment, voidPayment, previewPayment, allocatePayment } from '../src/domain/payments.js';
import { financeSummary, closeDay, closingPreview } from '../src/domain/reports.js';
import { dueToday } from '../src/domain/reports.js';
import { levelOf, scopedToOwn } from '../src/lib/permissions.js';

let owner, collector, empId, ctx, collectorCtx;

let ready = false;

/** เตรียมข้อมูลตั้งต้นครั้งเดียวสำหรับทุกชุดทดสอบ */
async function setup() {
  if (ready) return;
  await db();
  const now = nowISO();
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)
     ON CONFLICT (username) DO NOTHING`,
    { h: hashPassword('owner1234'), now },
  );
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('collector', :h, 'พนักงานเก็บเงิน', 'collector', 1, :now, :now)
     ON CONFLICT (username) DO NOTHING`,
    { h: hashPassword('collect1234'), now },
  );
  owner = await get(`SELECT * FROM users WHERE username = 'owner'`);
  collector = await get(`SELECT * FROM users WHERE username = 'collector'`);
  await run(
    `INSERT INTO employees (user_id, code, full_name, is_active, created_at, updated_at)
     VALUES (:uid, 'E001', 'พนักงานเก็บเงิน', 1, :now, :now)
     ON CONFLICT (code) DO NOTHING`,
    { uid: collector.id, now },
  );
  empId = (await get(`SELECT id FROM employees WHERE code = 'E001'`)).id;
  ctx = { user: owner, ip: 'test' };
  collectorCtx = { user: collector, ip: 'test' };
  ready = true;
}

before(setup);
beforeEach(setup);
after(async () => { await closeDb(); });

async function newDebtor(name = 'ลูกหนี้ทดสอบ', employeeId = empId) {
  const now = nowISO();
  return await insert(
    `INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
     VALUES (:code, :name, :emp, 'normal', :now, :now)`,
    { code: `D${Math.random().toString(36).slice(2, 9)}`, name, emp: employeeId, now },
  );
}

/** สัญญามาตรฐานตามตัวอย่าง SRS: เงินต้น 1,000 / ค่างวด 50 / ดอก 20 / 24 งวด */
async function standardContract({ deductFirst = true, startDate = today() } = {}) {
  return await createContract(
    {
      debtorId: await newDebtor(),
      employeeId: empId,
      type: 'daily24',
      principalAmount: 100_000,
      installmentAmount: 5_000,
      interestPerInst: 2_000,
      numInstallments: 24,
      startDate,
      deductFirst,
    },
    ctx,
  );
}

// -----------------------------------------------------------------------------
describe('ข้อ 18 — เกณฑ์ทดสอบรับมอบงาน', () => {
  test('สัญญา 1,000 ค่าทำเอกสาร 100 งวดแรก 50 → ลูกค้าได้รับจริง 850 และงวดแรกถูกบันทึกแล้ว', async () => {
    const { contract, preview, firstPayment } = await standardContract();

    assert.equal(preview.doc_fee, 10_000, 'ค่าทำเอกสาร 100 บาท');
    assert.equal(preview.first_installment, 5_000, 'งวดแรก 50 บาท');
    assert.equal(preview.cash_to_customer, 85_000, 'เงินที่ลูกค้าได้รับจริง 850 บาท');
    assert.equal(contract.cash_disbursed, 85_000);

    // งวดแรกต้องปรากฏในประวัติรับชำระ พร้อมแยกต้น/ดอก (ข้อ 14)
    assert.ok(firstPayment, 'ต้องมีรายการรับชำระงวดแรก');
    assert.equal(firstPayment.source, 'first_installment');
    assert.equal(firstPayment.amount_paid, 5_000);
    assert.equal(firstPayment.interest_amount, 2_000);
    assert.equal(firstPayment.principal_amount, 3_000);
    assert.equal(firstPayment.status, 'full');

    // ค่าทำเอกสารถูกบันทึกเป็นรายรับแยกประเภท (ข้อ 14)
    const fee = await get(
      `SELECT * FROM income_entries WHERE contract_id = :id AND category = 'doc_fee'`,
      { id: contract.id },
    );
    assert.equal(fee.amount, 10_000);

    // เงินสดที่จ่ายให้ลูกค้าถูกบันทึกเป็นกระแสเงินสดออก (ข้อ 14)
    const out = await get(
      `SELECT * FROM expenses WHERE contract_id = :id AND category LIKE 'เงินปล่อยใหม่%'`,
      { id: contract.id },
    );
    assert.ok(out, 'ต้องมีรายการเงินสดจ่ายออก');
    assert.match(out.description, /850\.00/);
  });

  test('รับชำระ 50 บาท → ดอก 20 ต้น 30 สถานะเต็มงวด', async () => {
    const { contract } = await standardContract();
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 5_000, paidDate: addDays(today(), 1) },
      collectorCtx,
    );
    assert.equal(p.interest_amount, 2_000);
    assert.equal(p.principal_amount, 3_000);
    assert.equal(p.status, 'full');
  });

  test('รับชำระ 20 บาท → ดอก 20 ต้น 0 สถานะเฉพาะดอก และเงินต้นไม่เปลี่ยน', async () => {
    const { contract } = await standardContract();
    const before = await get(`SELECT principal_remaining FROM contracts WHERE id = :id`, { id: contract.id });
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 2_000, paidDate: addDays(today(), 1) },
      collectorCtx,
    );
    const after = await get(`SELECT principal_remaining FROM contracts WHERE id = :id`, { id: contract.id });

    assert.equal(p.interest_amount, 2_000);
    assert.equal(p.principal_amount, 0);
    assert.equal(p.status, 'interest_only');
    assert.equal(after.principal_remaining, before.principal_remaining, 'จ่ายเฉพาะดอก เงินต้นต้องคงเดิม');
  });

  test('รับชำระ 30 บาท → ดอก 20 ต้น 10 สถานะบางส่วน', async () => {
    const { contract } = await standardContract();
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 3_000, paidDate: addDays(today(), 1) },
      collectorCtx,
    );
    assert.equal(p.interest_amount, 2_000);
    assert.equal(p.principal_amount, 1_000);
    assert.equal(p.status, 'partial');
  });

  test('ไม่ชำระ (0 บาท) → บันทึกสถานะค้างชำระได้ ต้น/ดอกเป็น 0', async () => {
    const { contract } = await standardContract();
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 0, paidDate: addDays(today(), 1) },
      collectorCtx,
    );
    assert.equal(p.status, 'unpaid');
    assert.equal(p.interest_amount, 0);
    assert.equal(p.principal_amount, 0);
  });

  test('รียอดจากต้นคงเหลือ 700 เพิ่มใหม่ 500 → สัญญาใหม่ 1,200 และสัญญาเดิมปิดด้วยการรียอด', async () => {
    const { contract } = await standardContract({ deductFirst: false });
    // ปรับเงินต้นคงเหลือให้เป็น 700 บาทตามโจทย์
    await run(`UPDATE contracts SET principal_remaining = 70000 WHERE id = :id`, { id: contract.id });

    const result = await reyod(
      { fromContractId: contract.id, newMoney: 50_000, startDate: today() },
      ctx,
    );

    assert.equal(result.carried_principal, 70_000);
    assert.equal(result.new_money, 50_000);
    assert.equal(result.new_contract.principal_amount, 120_000, 'สัญญาใหม่ 1,200 บาท');
    assert.equal(result.old_contract.status, 'closed_reyod');
    assert.equal(result.old_contract.principal_remaining, 0, 'เงินต้นถูกยกไปสัญญาใหม่');

    // ข้อมูลเดิมไม่ถูกลบ และเชื่อมโยงถึงกัน
    const link = await get(`SELECT * FROM contract_links WHERE from_contract_id = :id`, { id: contract.id });
    assert.equal(link.to_contract_id, result.new_contract.id);
    assert.equal(link.carried_principal, 70_000);
    assert.ok(await get(`SELECT id FROM contracts WHERE id = :id`, { id: contract.id }), 'สัญญาเดิมยังอยู่');
  });

  test('รียอด: เงินสดที่ลูกค้าได้รับคำนวณจากเงินเพิ่มใหม่ ไม่จ่ายซ้ำในส่วนเงินต้นเดิม (ข้อ 9)', async () => {
    const { contract } = await standardContract({ deductFirst: false });
    await run(`UPDATE contracts SET principal_remaining = 70000 WHERE id = :id`, { id: contract.id });
    const result = await reyod({ fromContractId: contract.id, newMoney: 50_000 }, ctx);
    // 500 - 100 (ค่าทำเอกสาร) - งวดแรก
    const firstInst = result.preview.first_installment;
    assert.equal(result.new_contract.cash_disbursed, 50_000 - 10_000 - firstInst);
  });

  test('ยกเลิกรายการรับเงิน → ยอดถูกย้อนกลับและมีประวัติผู้ยกเลิก', async () => {
    const { contract } = await standardContract();
    const before = await contractSummary(contract.id);
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 5_000, paidDate: addDays(today(), 1) },
      collectorCtx,
    );
    const mid = await contractSummary(contract.id);
    assert.equal(mid.principal_remaining, before.principal_remaining - 3_000);

    const voided = await voidPayment({ paymentId: p.id, reason: 'บันทึกผิดสัญญา' }, ctx);
    const after = await contractSummary(contract.id);

    assert.equal(voided.is_void, 1);
    assert.equal(voided.void_reason, 'บันทึกผิดสัญญา');
    assert.equal(voided.voided_by, owner.id, 'ต้องเก็บผู้ยกเลิก');
    assert.ok(voided.voided_at);
    assert.equal(after.principal_remaining, before.principal_remaining, 'เงินต้นถูกย้อนกลับ');

    // ไม่ลบถาวร — รายการยังอยู่ในฐานข้อมูล (ข้อ 15)
    assert.ok(await get(`SELECT id FROM payments WHERE id = :id`, { id: p.id }));
    // มี Audit Log ของการยกเลิก
    const log = await get(
      `SELECT * FROM audit_logs WHERE entity='payment' AND entity_id = :id AND action='void'`,
      { id: String(p.id) },
    );
    assert.equal(log.reason, 'บันทึกผิดสัญญา');
  });

  test('ปิดยอดประจำวัน → แสดงยอดระบบ เงินสดจริง และส่วนต่าง', async () => {
    const date = '2030-01-15';
    const debtorId = await newDebtor('ลูกหนี้ปิดยอด');
    await createContract(
      {
        debtorId,
        employeeId: empId,
        type: 'daily24',
        principalAmount: 100_000,
        installmentAmount: 5_000,
        interestPerInst: 2_000,
        numInstallments: 24,
        startDate: date,
      },
      ctx,
    );

    const preview = await closingPreview(date);
    // เงินเข้า = ค่าทำเอกสาร 100 + งวดแรก 50 ; เงินออก = เงินปล่อย 1,000
    assert.equal(preview.summary.total_in, 15_000);
    assert.equal(preview.summary.total_out, 100_000);
    assert.equal(preview.summary.net_cash, -85_000, 'เงินสดสุทธิ = เงินสดที่จ่ายให้ลูกค้า 850 บาท');

    const closing = await closeDay({ date, actualCash: -84_000, note: 'ทดสอบ' }, ctx);
    assert.equal(closing.system_cash, -85_000);
    assert.equal(closing.actual_cash, -84_000);
    assert.equal(closing.difference, 1_000, 'ส่วนต่าง = เงินสดจริง - ยอดตามระบบ');

    // วันที่ปิดยอดแล้ว ห้ามบันทึกย้อนหลังโดยไม่ได้รับอนุมัติ (ข้อ 14)
    const c = await get(`SELECT id FROM contracts WHERE start_date = :d`, { d: date });
    await assert.rejects(
      async () => await recordPayment({ contractId: c.id, amountPaid: 5_000, paidDate: date }, collectorCtx),
      /ปิดยอดประจำวันแล้ว/,
    );
  });

  test('พนักงานเก็บเงิน Login → เห็นเฉพาะลูกหนี้ที่ตนรับผิดชอบ', async () => {
    assert.equal(levelOf(collector, 'debtors_view'), 'own');
    assert.equal(scopedToOwn(collector, 'debtors_view'), true);
    assert.equal(scopedToOwn(owner, 'debtors_view'), false);
    // สิทธิ์ที่พนักงานเก็บเงินต้องไม่มี
    assert.equal(levelOf(collector, 'contracts_create'), 'no');
    assert.equal(levelOf(collector, 'reyod'), 'no');
    assert.equal(levelOf(collector, 'payments_void'), 'no');
    assert.equal(levelOf(collector, 'settings_manage'), 'no');
    // ผู้จัดการ: รียอด/ยกเลิกรับเงิน ต้องรออนุมัติ
    const manager = { role: 'manager', extra_perms: '{}' };
    assert.equal(levelOf(manager, 'reyod'), 'approval');
    assert.equal(levelOf(manager, 'payments_void'), 'approval');

    // สร้างสัญญาที่มีงวดค้างอยู่จริง เพื่อให้แน่ใจว่ามีรายการต้องเก็บวันนี้
    await createContract(
      {
        debtorId: await newDebtor('ลูกหนี้ของพนักงาน E001'),
        employeeId: empId,
        type: 'daily24',
        principalAmount: 100_000,
        installmentAmount: 5_000,
        interestPerInst: 2_000,
        numInstallments: 24,
        startDate: addDays(today(), -3),
      },
      ctx,
    );

    const mine = await dueToday({ date: today(), employeeId: empId });
    const others = await dueToday({ date: today(), employeeId: -1 });
    assert.ok(mine.length > 0, 'พนักงานต้องเห็นลูกหนี้ที่ตนดูแล');
    assert.equal(others.length, 0, 'พนักงานที่ไม่มีลูกหนี้ในความดูแลต้องไม่เห็นรายการใด');
  });

  test('รายงานกำไร → ไม่นำเงินต้นรับคืนมารวมเป็นรายได้', async () => {
    const date = '2030-03-10';
    const debtorId = await newDebtor('ลูกหนี้รายงาน');
    const { contract } = await createContract(
      {
        debtorId,
        employeeId: empId,
        type: 'daily24',
        principalAmount: 100_000,
        installmentAmount: 5_000,
        interestPerInst: 2_000,
        numInstallments: 24,
        startDate: date,
        deductFirst: false,
      },
      ctx,
    );
    const payDate = '2030-03-11';
    await recordPayment({ contractId: contract.id, amountPaid: 5_000, paidDate: payDate }, collectorCtx);

    const s = await financeSummary({ from: payDate, to: payDate });
    assert.equal(s.interest_income, 2_000, 'ดอกเบี้ย 20 บาท');
    assert.equal(s.principal_back, 3_000, 'เงินต้นรับคืน 30 บาท');
    assert.equal(s.real_income, 2_000, 'รายได้จริงต้องมีแต่ดอกเบี้ย ไม่รวมเงินต้น');
    assert.equal(s.net_profit, 2_000, 'กำไรสุทธิ = รายได้จริง - ค่าใช้จ่ายดำเนินงาน');
    assert.equal(s.cash_from_debtors, 5_000, 'กระแสเงินสดรับยังคงเป็น 50 บาทเต็ม');
  });
});

// -----------------------------------------------------------------------------
describe('ข้อ 3 — กติกาการคำนวณ', () => {
  test('ตัดดอกเบี้ยก่อนเสมอ แล้วจึงตัดเงินต้น', async () => {
    const insts = [
      { id: 1, seq: 1, interest_due: 2000, principal_due: 3000, interest_paid: 0, principal_paid: 0 },
    ];
    const r = allocatePayment({ amountPaid: 2500, installments: insts, principalRemaining: 100000 });
    assert.equal(r.interestTotal, 2000);
    assert.equal(r.principalTotal, 500);
  });

  test('จ่ายเกินงวดปัจจุบันจะไหลไปงวดถัดไป', async () => {
    const insts = [
      { id: 1, seq: 1, interest_due: 2000, principal_due: 3000, interest_paid: 0, principal_paid: 0 },
      { id: 2, seq: 2, interest_due: 2000, principal_due: 3000, interest_paid: 0, principal_paid: 0 },
    ];
    const r = allocatePayment({ amountPaid: 7000, installments: insts, principalRemaining: 100000 });
    assert.equal(r.interestTotal, 4000);
    assert.equal(r.principalTotal, 3000);
    assert.equal(r.allocations.length, 2);
  });

  test('ดอกลอย: จ่ายตามรอบ เงินต้นคงเดิม', async () => {
    const debtorId = await newDebtor('ลูกหนี้ดอกลอย');
    const { contract } = await createContract(
      {
        debtorId,
        employeeId: empId,
        type: 'floating',
        principalAmount: 500_000,
        installmentAmount: 0,
        interestPerInst: 25_000,
        numInstallments: 12,
        startDate: '2030-05-01',
        deductFirst: false,
      },
      ctx,
    );
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 25_000, paidDate: '2030-06-01' },
      collectorCtx,
    );
    assert.equal(p.interest_amount, 25_000);
    assert.equal(p.principal_amount, 0);
    const after = await get(`SELECT principal_remaining FROM contracts WHERE id = :id`, { id: contract.id });
    assert.equal(after.principal_remaining, 500_000, 'ดอกลอย: เงินต้นคงเดิม');
  });

  test('ดอกลอย: ชำระเกินดอกจะไปตัดเงินต้น', async () => {
    const debtorId = await newDebtor('ลูกหนี้ดอกลอย 2');
    const { contract } = await createContract(
      {
        debtorId,
        type: 'floating',
        principalAmount: 500_000,
        installmentAmount: 0,
        interestPerInst: 25_000,
        numInstallments: 12,
        startDate: '2030-05-01',
        deductFirst: false,
      },
      ctx,
    );
    await recordPayment(
      {
        contractId: contract.id,
        amountPaid: 125_000,
        paidDate: '2030-06-02',
        extraToPrincipal: true, // ระบุชัดว่าส่วนที่เกินดอกให้ตัดเงินต้น
      },
      ctx,
    );
    const after = await get(`SELECT principal_remaining FROM contracts WHERE id = :id`, { id: contract.id });
    assert.equal(after.principal_remaining, 400_000);
  });

  test('นับจำนวนงวดเต็มที่ชำระแล้วและจำนวนวันที่จ่ายเฉพาะดอกแยกกัน (ข้อ 3.1)', async () => {
    const { contract } = await standardContract({ startDate: '2031-01-01' });
    await recordPayment({ contractId: contract.id, amountPaid: 5_000, paidDate: '2031-01-02' }, ctx); // เต็มงวด
    await recordPayment({ contractId: contract.id, amountPaid: 2_000, paidDate: '2031-01-03' }, ctx); // เฉพาะดอก
    await recordPayment({ contractId: contract.id, amountPaid: 1_000, paidDate: '2031-01-04' }, ctx); // บางส่วน

    const s = await contractSummary(contract.id, '2031-01-04');
    assert.equal(s.paid_full_installments, 2, 'งวดแรก + จ่ายเต็ม 1 ครั้ง');
    assert.equal(s.interest_only_days, 1);
    assert.equal(s.partial_count, 1);
  });
});

// -----------------------------------------------------------------------------
describe('ข้อ 14 — กฎธุรกิจและการตรวจสอบข้อมูล', () => {
  test('ห้ามรับยอดติดลบ', async () => {
    const { contract } = await standardContract();
    await assert.rejects(
      async () => await recordPayment({ contractId: contract.id, amountPaid: -100 }, ctx),
      /ต้องไม่ติดลบ/,
    );
  });

  test('เงินต้นคงเหลือต้องไม่ต่ำกว่า 0 — จ่ายเกินภาระหนี้ถูกปฏิเสธ', async () => {
    const { contract } = await standardContract();
    await assert.rejects(
      async () => await recordPayment({ contractId: contract.id, amountPaid: 10_000_000 }, ctx),
      /เกินภาระหนี้/,
    );
  });

  test('ยอดดอกเบี้ย + เงินต้น ต้องเท่ากับยอดรับจริงเสมอ', async () => {
    const { contract } = await standardContract();
    for (const amount of [1_000, 2_000, 3_000, 5_000, 7_500]) {
      const p = await previewPayment({ contractId: contract.id, amountPaid: amount });
      assert.equal(p.interest_amount + p.principal_amount, amount);
    }
  });

  test('สัญญาที่ปิด/รียอดแล้วห้ามรับชำระเพิ่ม เว้นแต่เจ้าของอนุมัติ', async () => {
    const { contract } = await standardContract({ deductFirst: false });
    await reyod({ fromContractId: contract.id, newMoney: 0 }, ctx);
    await assert.rejects(
      async () => await recordPayment({ contractId: contract.id, amountPaid: 5_000 }, collectorCtx),
      /ปิดหรือรียอดแล้ว/,
    );
    // เจ้าของอนุมัติได้
    const ok = await recordPayment(
      { contractId: contract.id, amountPaid: 2_000, ownerOverride: true },
      ctx,
    );
    assert.equal(ok.amount_paid, 2_000);
  });

  test('ยกเลิกรายการรับเงินหลังรียอดไปแล้วต้องถูกปฏิเสธ (กันเงินหายจากรายงาน)', async () => {
    const { contract } = await standardContract({ startDate: '2033-03-01' });
    const p = await recordPayment(
      { contractId: contract.id, amountPaid: 5_000, paidDate: '2033-03-02' }, ctx);

    // ยกเลิกก่อนรียอด ทำได้ปกติ
    const p2 = await recordPayment(
      { contractId: contract.id, amountPaid: 5_000, paidDate: '2033-03-03' }, ctx);
    await voidPayment({ paymentId: p2.id, reason: 'ปกติ' }, ctx);

    await reyod({ fromContractId: contract.id, newMoney: 50_000, startDate: '2033-03-04' }, ctx);

    // หลังรียอด ยอดที่ยกไปคำนวณจากรายการนี้แล้ว การย้อนยอดจะทำให้เงินต้น
    // ไปค้างบนสัญญาที่ปิดแล้ว ซึ่งรายงานไม่นับ เท่ากับเงินหายเงียบ ๆ
    await assert.rejects(
      async () => voidPayment({ paymentId: p.id, reason: 'ลองหลังรียอด' }, ctx),
      /ถูกรียอดไปเป็น/,
    );

    const old = await get(`SELECT principal_remaining FROM contracts WHERE id = :id`,
      { id: contract.id });
    assert.equal(old.principal_remaining, 0, 'สัญญาที่รียอดแล้วต้องไม่มีเงินต้นค้าง');
  });

  test('เลขที่สัญญาและเลขที่ใบรับเงินต้องไม่ซ้ำ', async () => {
    const nos = new Set();
    for (let i = 0; i < 5; i++) {
      const { contract } = await standardContract({ startDate: '2032-02-02' });
      assert.equal(nos.has(contract.contract_no), false);
      nos.add(contract.contract_no);
    }
    const receipts = (await all(`SELECT receipt_no FROM payments`)).map((r) => r.receipt_no);
    assert.equal(new Set(receipts).size, receipts.length);
  });

  test('ค่าทำเอกสารตั้งค่าได้จากหน้าตั้งค่า (ข้อ 7.2)', async () => {
    await setSetting('doc_fee', '25000', owner.id);
    const p = await previewContract({
      debtorId: await newDebtor(),
      type: 'daily24',
      principalAmount: 100_000,
      installmentAmount: 5_000,
      interestPerInst: 2_000,
      numInstallments: 24,
      startDate: today(),
    });
    assert.equal(p.doc_fee, 25_000);
    assert.equal(p.cash_to_customer, 100_000 - 25_000 - 5_000);
    await setSetting('doc_fee', '10000', owner.id);
  });
});
