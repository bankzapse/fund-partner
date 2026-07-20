import {
  all,
  get,
  run,
  insert,
  tx,
  nextCounter,
  getSettingInt,
  getSetting,
  DISBURSE_CATEGORY,
} from '../db/index.js';
import { assertNonNegative, assertPositive, formatBaht } from '../lib/money.js';
import { today, nowISO, addDays, addMonths, isDateStr } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { recordFirstInstallment } from './payments.js';

export const CONTRACT_TYPES = {
  daily24: { label: 'รายวัน 24 งวด', unit: 'day' },
  monthly: { label: 'รายเดือน', unit: 'month' },
  floating: { label: 'ดอกลอย', unit: 'month' },
};

export class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * สร้างตารางงวด (SRS ข้อ 3)
 * - รายวัน 24 งวด / รายเดือน : แต่ละงวดตัดดอกเบี้ยคงที่ ส่วนที่เหลือตัดเงินต้น
 * - ดอกลอย                    : แต่ละรอบจ่ายเฉพาะดอกเบี้ย เงินต้นคงเดิม
 */
export function buildSchedule({
  type,
  startDate,
  numInstallments,
  installmentAmount,
  interestPerInst,
  principalAmount,
}) {
  const unit = CONTRACT_TYPES[type].unit;
  const rows = [];
  let principalLeft = principalAmount;

  for (let seq = 1; seq <= numInstallments; seq++) {
    const dueDate =
      unit === 'day' ? addDays(startDate, seq - 1) : addMonths(startDate, seq - 1);

    let interestDue = interestPerInst;
    let principalDue;

    if (type === 'floating') {
      principalDue = 0; // เงินต้นคงเดิมจนกว่าจะชำระต้น รียอด หรือปิดสัญญา
    } else {
      principalDue = Math.max(0, installmentAmount - interestPerInst);
      // งวดสุดท้ายไม่ตัดเกินเงินต้นที่เหลืออยู่ (ข้อ 14: เงินต้นคงเหลือต้องไม่ต่ำกว่า 0)
      if (principalDue > principalLeft) principalDue = principalLeft;
      principalLeft -= principalDue;
    }

    rows.push({
      seq,
      due_date: dueDate,
      interest_due: interestDue,
      principal_due: principalDue,
      due_amount: interestDue + principalDue,
    });
  }
  return rows;
}

/** สรุปตัวเลขให้ผู้ใช้ตรวจก่อนยืนยัน (ข้อ 7.1 "แสดงเงินที่ลูกค้าได้รับจริงก่อนยืนยัน") */
export async function previewContract(input) {
  const p = await normalizeContractInput(input);
  const schedule = buildSchedule(p);
  const totalDue = schedule.reduce((s, r) => s + r.due_amount, 0);
  const totalInterest = schedule.reduce((s, r) => s + r.interest_due, 0);
  const totalPrincipalScheduled = schedule.reduce((s, r) => s + r.principal_due, 0);

  const docFee = p.docFee;
  const firstInst = p.deductFirst ? schedule[0].due_amount : 0;
  const grossOut = p.grossOut ?? p.principalAmount;
  const cashToCustomer = Math.max(0, grossOut - docFee - firstInst);

  const warnings = [];
  if (p.type !== 'floating' && totalPrincipalScheduled < p.principalAmount) {
    warnings.push(
      `ตารางงวดตัดเงินต้นรวม ${formatBaht(totalPrincipalScheduled)} บาท ` +
        `น้อยกว่าเงินต้นตามสัญญา ${formatBaht(p.principalAmount)} บาท ` +
        `จะเหลือเงินต้นค้าง ${formatBaht(p.principalAmount - totalPrincipalScheduled)} บาท เมื่อครบงวด (ต้องรียอดหรือชำระเพิ่ม)`,
    );
  }
  if (p.type !== 'floating' && p.installmentAmount <= p.interestPerInst) {
    warnings.push('ค่างวดต้องมากกว่าดอกเบี้ยต่องวด มิฉะนั้นเงินต้นจะไม่ลดเลย');
  }

  return {
    ...p,
    schedule,
    totals: {
      total_due: totalDue,
      total_interest: totalInterest,
      total_principal_scheduled: totalPrincipalScheduled,
    },
    doc_fee: docFee,
    first_installment: firstInst,
    gross_out: grossOut,
    cash_to_customer: cashToCustomer,
    warnings,
  };
}

async function normalizeContractInput(input) {
  const type = input.type;
  if (!CONTRACT_TYPES[type]) throw new BusinessError('ประเภทสัญญาไม่ถูกต้อง');

  const startDate = input.startDate || today();
  if (!isDateStr(startDate)) throw new BusinessError('วันเริ่มสัญญาไม่ถูกต้อง');

  const principalAmount = assertPositive(input.principalAmount, 'เงินต้น');
  const interestPerInst = assertNonNegative(input.interestPerInst, 'ดอกเบี้ยต่องวด');
  let installmentAmount = assertNonNegative(input.installmentAmount, 'ค่างวด');
  let numInstallments = Number(input.numInstallments);

  if (type === 'daily24' && !numInstallments) numInstallments = 24;
  if (type === 'floating') installmentAmount = interestPerInst;
  if (!Number.isInteger(numInstallments) || numInstallments < 1 || numInstallments > 600) {
    throw new BusinessError('จำนวนงวดไม่ถูกต้อง');
  }
  if (installmentAmount <= 0) throw new BusinessError('ค่างวดต้องมากกว่า 0');

  const docFee =
    input.docFee === undefined || input.docFee === null
      ? await getSettingInt('doc_fee')
      : assertNonNegative(input.docFee, 'ค่าทำเอกสาร');
  const deductFirst =
    input.deductFirst === undefined
      ? (await getSettingInt('deduct_first_installment')) === 1
      : Boolean(input.deductFirst);

  return {
    type,
    startDate,
    principalAmount,
    installmentAmount,
    interestPerInst,
    numInstallments,
    docFee,
    deductFirst,
    grossOut: input.grossOut,
    debtorId: input.debtorId,
    employeeId: input.employeeId ?? null,
    note: input.note ?? null,
  };
}

/** เลขที่สัญญา: CT-YYYYMM-#### (ไม่ซ้ำ — ข้อ 14) */
async function newContractNo(dateStr) {
  const ym = dateStr.slice(0, 7).replace('-', '');
  const n = await nextCounter(`contract:${ym}`);
  return `CT-${ym}-${String(n).padStart(4, '0')}`;
}

/**
 * สร้างสัญญาใหม่ (SRS ข้อ 7) — ทำงานภายใน transaction เดียว
 * ผลข้างเคียงที่เกิดพร้อมกัน:
 *   1. ตารางงวด
 *   2. รายการรับชำระงวดแรก (ข้อ 14: ต้องปรากฏในประวัติรับชำระ)
 *   3. รายรับ "ค่าทำเอกสาร" แยกประเภท (ข้อ 14)
 *   4. รายจ่ายเงินปล่อยใหม่เป็นกระแสเงินสดออก (ข้อ 14)
 */
export async function createContract(input, ctx) {
  return await tx(() => createContractInTx(input, ctx));
}

export async function createContractInTx(input, ctx) {
  const preview = await previewContract(input);
  const debtor = await get(`SELECT * FROM debtors WHERE id = :id`, { id: input.debtorId });
  if (!debtor) throw new BusinessError('ไม่พบลูกหนี้');
  if (debtor.status === 'disabled') throw new BusinessError('ลูกหนี้รายนี้ถูกงดใช้งาน');

  const now = nowISO();
  const contractNo = input.contractNo || (await newContractNo(preview.startDate));

  const contractId = await insert(
    `INSERT INTO contracts
       (contract_no, debtor_id, employee_id, type, principal_amount, installment_amount,
        interest_per_inst, num_installments, period_unit, start_date, doc_fee,
        first_inst_deducted, cash_disbursed, principal_remaining, status, note,
        created_by, created_at, updated_at)
     VALUES
       (:no, :debtor, :emp, :type, :principal, :inst, :interest, :n, :unit, :start, :fee,
        :first, :cash, :principal, 'active', :note, :uid, :now, :now)`,
    {
      no: contractNo,
      debtor: input.debtorId,
      emp: preview.employeeId ?? debtor.employee_id ?? null,
      type: preview.type,
      principal: preview.principalAmount,
      inst: preview.installmentAmount,
      interest: preview.interestPerInst,
      n: preview.numInstallments,
      unit: CONTRACT_TYPES[preview.type].unit,
      start: preview.startDate,
      fee: preview.doc_fee,
      first: preview.first_installment,
      cash: preview.cash_to_customer,
      note: preview.note,
      uid: ctx?.user?.id ?? null,
      now,
    },
  );

  for (const row of preview.schedule) {
    await run(
      `INSERT INTO installments (contract_id, seq, due_date, due_amount, interest_due, principal_due)
       VALUES (:cid, :seq, :due, :amt, :i, :p)`,
      {
        cid: contractId,
        seq: row.seq,
        due: row.due_date,
        amt: row.due_amount,
        i: row.interest_due,
        p: row.principal_due,
      },
    );
  }

  // 3) ค่าทำเอกสาร -> รายรับแยกประเภท
  if (preview.doc_fee > 0) {
    await run(
      `INSERT INTO income_entries (entry_date, category, amount, description, contract_id, debtor_id, created_by, created_at)
       VALUES (:d, 'doc_fee', :amt, :desc, :cid, :did, :uid, :now)`,
      {
        d: preview.startDate,
        amt: preview.doc_fee,
        desc: `ค่าทำเอกสารสัญญา ${contractNo}`,
        cid: contractId,
        did: input.debtorId,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );
  }

  // 4) เงินปล่อยใหม่ -> กระแสเงินสดออก (บันทึกแบบยอดเต็ม แล้วรับค่าทำเอกสาร/งวดแรกเป็นเงินเข้า
  //    เงินสดสุทธิจึงเท่ากับเงินที่จ่ายให้ลูกค้าจริง)
  if (preview.gross_out > 0) {
    await run(
      `INSERT INTO expenses (entry_date, category, amount, description, contract_id, employee_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :cid, :emp, :uid, :now)`,
      {
        d: preview.startDate,
        cat: DISBURSE_CATEGORY,
        amt: preview.gross_out,
        desc:
          `สัญญา ${contractNo} — จ่ายเงินสดให้ลูกค้าจริง ${formatBaht(preview.cash_to_customer)} บาท ` +
          `(หักค่าทำเอกสาร ${formatBaht(preview.doc_fee)} และงวดแรก ${formatBaht(preview.first_installment)})`,
        cid: contractId,
        emp: preview.employeeId ?? debtor.employee_id ?? null,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );
  }

  // 2) งวดแรกถูกหัก ณ วันทำสัญญา -> บันทึกเป็นรายการชำระจริง พร้อมแยกต้น/ดอก
  let firstPayment = null;
  if (preview.first_installment > 0) {
    firstPayment = await recordFirstInstallment({ contractId, ctx });
  }

  const contract = await getContract(contractId);
  await audit({
    userId: ctx?.user?.id,
    action: 'create',
    entity: 'contract',
    entityId: contractId,
    after: contract,
    reason: input.reason ?? null,
    ip: ctx?.ip,
  });

  return { contract, preview, firstPayment };
}

export async function getContract(id) {
  return await get(
    `SELECT c.*, d.full_name AS debtor_name, d.code AS debtor_code, d.phone AS debtor_phone,
            e.full_name AS employee_name
     FROM contracts c
     JOIN debtors d ON d.id = c.debtor_id
     LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.id = :id`,
    { id },
  );
}

export async function getContractByNo(no) {
  const row = await get(`SELECT id FROM contracts WHERE contract_no = :no`, { no });
  return row ? await getContract(row.id) : null;
}

export async function listInstallments(contractId) {
  return await all(
    `SELECT * FROM installments WHERE contract_id = :cid ORDER BY seq`,
    { cid: contractId },
  );
}

/**
 * สรุปสถานะสัญญา (ใช้ในหน้ารับชำระและรายงาน)
 * - งวดปัจจุบัน, ยอดที่ควรจ่าย, ดอกเบี้ย/เงินต้นที่ควรตัด
 * - จำนวนงวดเต็มที่ชำระแล้ว และจำนวนวันที่จ่ายเฉพาะดอก (ข้อ 3.1)
 */
export async function contractSummary(contractId, asOfDate = today()) {
  const contract = await getContract(contractId);
  if (!contract) return null;
  const installments = await listInstallments(contractId);

  const current = installments.find(
    (i) => i.interest_paid < i.interest_due || i.principal_paid < i.principal_due,
  );

  const overdue = installments.filter(
    (i) =>
      i.due_date <= asOfDate &&
      (i.interest_paid < i.interest_due || i.principal_paid < i.principal_due),
  );
  const arrears = overdue.reduce(
    (s, i) => s + (i.due_amount - i.interest_paid - i.principal_paid),
    0,
  );

  const stats = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'full'          THEN 1 ELSE 0 END), 0) AS full_count,
       COALESCE(SUM(CASE WHEN status = 'interest_only' THEN 1 ELSE 0 END), 0) AS interest_only_count,
       COALESCE(SUM(CASE WHEN status = 'partial'       THEN 1 ELSE 0 END), 0) AS partial_count,
       COALESCE(SUM(amount_paid), 0)      AS total_paid,
       COALESCE(SUM(interest_amount), 0)  AS total_interest,
       COALESCE(SUM(principal_amount), 0) AS total_principal
     FROM payments WHERE contract_id = :cid AND is_void = 0`,
    { cid: contractId },
  );

  const dueRemaining = current
    ? current.due_amount - current.interest_paid - current.principal_paid
    : 0;

  return {
    contract,
    installments_total: installments.length,
    current_installment: current
      ? {
          seq: current.seq,
          due_date: current.due_date,
          due_amount: current.due_amount,
          due_remaining: dueRemaining,
          interest_remaining: current.interest_due - current.interest_paid,
          principal_remaining_this: current.principal_due - current.principal_paid,
        }
      : null,
    arrears_amount: arrears,
    arrears_installments: overdue.length,
    principal_remaining: contract.principal_remaining,
    paid_full_installments: Number(stats.full_count),
    interest_only_days: Number(stats.interest_only_count),
    partial_count: Number(stats.partial_count),
    total_paid: Number(stats.total_paid),
    total_interest_received: Number(stats.total_interest),
    total_principal_received: Number(stats.total_principal),
    is_closed: contract.status !== 'active',
  };
}

/** ป้ายสถานะลูกหนี้จากพฤติกรรมการชำระ (ใช้ใน Dashboard ข้อ 5) */
export async function contractBehaviour(contractId, asOfDate = today()) {
  const s = await contractSummary(contractId, asOfDate);
  if (!s) return 'unknown';
  if (s.contract.status === 'completed') return 'completed';
  if (s.contract.status === 'closed_reyod') return 'reyod';
  if (s.contract.status === 'cancelled') return 'cancelled';
  const threshold = (await getSettingInt('overdue_days_threshold')) || 3;
  if (s.arrears_installments >= threshold) return 'overdue';
  const last = await get(
    `SELECT status FROM payments WHERE contract_id = :cid AND is_void = 0
     ORDER BY paid_date DESC, id DESC LIMIT 1`,
    { cid: contractId },
  );
  if (last?.status === 'interest_only') return 'interest_only';
  if (last?.status === 'partial') return 'partial';
  return 'normal';
}

/**
 * รียอด / ทำสัญญาใหม่ (SRS ข้อ 9)
 * ยอดสัญญาใหม่ = เงินต้นคงเหลือเดิม + เงินเพิ่มใหม่
 * สัญญาเดิมปิดด้วยสถานะ "ปิดด้วยการรียอด" โดยไม่ลบข้อมูล และเชื่อมโยงกับสัญญาใหม่
 */
export async function reyod(input, ctx) {
  return await tx(async () => {
    const old = await getContract(input.fromContractId);
    if (!old) throw new BusinessError('ไม่พบสัญญาเดิม');
    if (old.status !== 'active') throw new BusinessError('สัญญาเดิมถูกปิดไปแล้ว');

    const newMoney = assertNonNegative(input.newMoney ?? 0, 'เงินเพิ่มใหม่');
    const carried = old.principal_remaining;
    const newPrincipal = carried + newMoney;
    if (newPrincipal <= 0) throw new BusinessError('ยอดสัญญาใหม่ต้องมากกว่า 0');

    // ฐานการคำนวณเงินสดที่จ่ายให้ลูกค้า (ตั้งค่าได้ — ข้อ 9)
    const basis = await getSetting('reyod_cash_basis');
    const grossOut = basis === 'full' ? newPrincipal : newMoney;

    const created = await createContractInTx(
      {
        debtorId: old.debtor_id,
        employeeId: input.employeeId ?? old.employee_id,
        type: input.type ?? old.type,
        principalAmount: newPrincipal,
        installmentAmount: input.installmentAmount ?? old.installment_amount,
        interestPerInst: input.interestPerInst ?? old.interest_per_inst,
        numInstallments: input.numInstallments ?? old.num_installments,
        startDate: input.startDate ?? today(),
        docFee: input.docFee,
        deductFirst: input.deductFirst,
        grossOut,
        note: input.note ?? `รียอดจากสัญญา ${old.contract_no}`,
      },
      ctx,
    );

    const now = nowISO();
    await run(
      `UPDATE contracts
         SET status = 'closed_reyod', closed_at = :now, principal_remaining = 0, updated_at = :now
       WHERE id = :id`,
      { id: old.id, now },
    );
    await run(
      `INSERT INTO contract_links
         (from_contract_id, to_contract_id, link_type, carried_principal, new_money, created_by, created_at)
       VALUES (:from, :to, 'reyod', :carried, :new, :uid, :now)`,
      {
        from: old.id,
        to: created.contract.id,
        carried,
        new: newMoney,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );

    await audit({
      userId: ctx?.user?.id,
      action: 'reyod',
      entity: 'contract',
      entityId: old.id,
      before: { status: old.status, principal_remaining: carried },
      after: {
        status: 'closed_reyod',
        new_contract_id: created.contract.id,
        new_contract_no: created.contract.contract_no,
        carried_principal: carried,
        new_money: newMoney,
        new_principal: newPrincipal,
      },
      reason: input.reason ?? null,
      ip: ctx?.ip,
    });

    return {
      old_contract: await getContract(old.id),
      new_contract: created.contract,
      preview: created.preview,
      carried_principal: carried,
      new_money: newMoney,
    };
  });
}

/** ตัวอย่างตัวเลขก่อนยืนยันรียอด (ข้อ 9) */
export async function reyodPreview(input) {
  const old = await getContract(input.fromContractId);
  if (!old) throw new BusinessError('ไม่พบสัญญาเดิม');
  const summary = await contractSummary(old.id);
  const newMoney = assertNonNegative(input.newMoney ?? 0, 'เงินเพิ่มใหม่');
  const carried = old.principal_remaining;
  const basis = await getSetting('reyod_cash_basis');
  const grossOut = basis === 'full' ? carried + newMoney : newMoney;

  const preview = await previewContract({
    debtorId: old.debtor_id,
    type: input.type ?? old.type,
    principalAmount: carried + newMoney,
    installmentAmount: input.installmentAmount ?? old.installment_amount,
    interestPerInst: input.interestPerInst ?? old.interest_per_inst,
    numInstallments: input.numInstallments ?? old.num_installments,
    startDate: input.startDate ?? today(),
    docFee: input.docFee,
    deductFirst: input.deductFirst,
    grossOut,
  });

  return {
    old_contract: old,
    old_summary: summary,
    carried_principal: carried,
    principal_paid_before: old.principal_amount - carried,
    new_money: newMoney,
    cash_basis: basis,
    preview,
  };
}

/** ประวัติการรียอดของสัญญา (ข้อ 16) */
export async function contractChain(contractId) {
  const chain = [];
  let cursor = contractId;
  // ย้อนกลับไปหาต้นสาย
  for (;;) {
    const link = await get(
      `SELECT * FROM contract_links WHERE to_contract_id = :id`,
      { id: cursor },
    );
    if (!link) break;
    cursor = link.from_contract_id;
  }
  // เดินหน้าไล่ลูกโซ่
  for (;;) {
    const c = await getContract(cursor);
    if (!c) break;
    chain.push(c);
    const link = await get(
      `SELECT * FROM contract_links WHERE from_contract_id = :id`,
      { id: cursor },
    );
    if (!link) break;
    cursor = link.to_contract_id;
  }
  return chain;
}
