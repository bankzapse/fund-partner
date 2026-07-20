import { all, get, run, insert, tx, nextCounter } from '../db/index.js';
import { assertNonNegative } from '../lib/money.js';
import { today, nowISO, isDateStr } from '../lib/time.js';
import { audit } from '../lib/audit.js';

export class PaymentError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** เลขที่ใบรับเงิน: RC-YYYYMMDD-#### (ไม่ซ้ำ — ข้อ 14) */
async function newReceiptNo(dateStr) {
  const ymd = dateStr.replaceAll('-', '');
  const n = await nextCounter(`receipt:${ymd}`);
  return `RC-${ymd}-${String(n).padStart(4, '0')}`;
}

/**
 * จัดสรรยอดที่ลูกค้าจ่ายจริงลงในตารางงวด (SRS ข้อ 3.1)
 * กติกา: ตัดดอกเบี้ยก่อน แล้วเงินส่วนที่เหลือจึงตัดเงินต้น
 * ยอดที่จ่ายเกินงวดปัจจุบันจะไหลไปงวดถัดไป และถ้ายังเหลือจะไปตัดเงินต้นคงเหลือ
 *
 * เป็นฟังก์ชันบริสุทธิ์ (pure) เพื่อให้ทดสอบได้โดยไม่ต้องแตะฐานข้อมูล
 */
export function allocatePayment({
  amountPaid,
  installments,
  principalRemaining,
  extraToPrincipal = false,
}) {
  assertNonNegative(amountPaid, 'ยอดจ่ายจริง');
  let left = amountPaid;
  let principalCap = principalRemaining;
  const allocations = [];
  let interestTotal = 0;
  let principalTotal = 0;

  // ถ้าเลือก "ส่วนที่เกินให้ตัดเงินต้น" จะจัดสรรเฉพาะงวดปัจจุบัน
  // แล้วเงินที่เหลือไปตัดเงินต้นทันที (ใช้กับดอกลอยและการปิดสัญญาก่อนกำหนด)
  const targets = extraToPrincipal ? installments.slice(0, 1) : installments;

  for (const inst of targets) {
    if (left <= 0) break;
    const interestOpen = inst.interest_due - inst.interest_paid;
    const principalOpen = inst.principal_due - inst.principal_paid;
    if (interestOpen <= 0 && principalOpen <= 0) continue;

    // 1) ดอกเบี้ยก่อน
    const iAlloc = Math.min(left, Math.max(0, interestOpen));
    left -= iAlloc;

    // 2) เงินต้น (ไม่เกินเงินต้นคงเหลือ — ข้อ 14: ห้ามติดลบ)
    const pAlloc = Math.min(left, Math.max(0, principalOpen), principalCap);
    left -= pAlloc;
    principalCap -= pAlloc;

    if (iAlloc > 0 || pAlloc > 0) {
      allocations.push({ installment_id: inst.id, seq: inst.seq, interest: iAlloc, principal: pAlloc });
      interestTotal += iAlloc;
      principalTotal += pAlloc;
    }
  }

  // 3) จ่ายเกินตารางงวด -> ตัดเงินต้นคงเหลือโดยตรง (ปิดสัญญาก่อนกำหนด / ดอกลอยชำระต้น)
  if (left > 0 && principalCap > 0) {
    const extra = Math.min(left, principalCap);
    left -= extra;
    principalCap -= extra;
    principalTotal += extra;
    allocations.push({ installment_id: null, seq: null, interest: 0, principal: extra });
  }

  if (left > 0) {
    throw new PaymentError(
      'ยอดที่รับเกินภาระหนี้คงเหลือของสัญญานี้ กรุณาตรวจสอบยอดอีกครั้ง',
    );
  }

  return { allocations, interestTotal, principalTotal };
}

/** สถานะรายการรับเงิน (ข้อ 3.1 / ข้อ 8) */
export function classifyPayment({ amountPaid, dueRemaining, interestTotal, principalTotal }) {
  if (amountPaid === 0) return 'unpaid';
  if (amountPaid >= dueRemaining && dueRemaining > 0) return 'full';
  if (principalTotal === 0 && interestTotal > 0) return 'interest_only';
  return 'partial';
}

function installmentStatus(inst) {
  const iFull = inst.interest_paid >= inst.interest_due;
  const pFull = inst.principal_paid >= inst.principal_due;
  if (iFull && pFull) return 'paid';
  if (iFull && inst.principal_paid === 0 && inst.interest_due > 0) return 'interest_only';
  if (inst.interest_paid > 0 || inst.principal_paid > 0) return 'partial';
  return 'pending';
}

async function openInstallments(contractId) {
  return await all(
    `SELECT * FROM installments
     WHERE contract_id = :cid AND (interest_paid < interest_due OR principal_paid < principal_due)
     ORDER BY seq`,
    { cid: contractId },
  );
}

/**
 * บันทึกการรับชำระ (SRS ข้อ 8) — ทั้งหมดอยู่ใน transaction เดียว
 * บันทึกตามยอดที่ลูกค้าจ่ายจริง ไม่บังคับให้จ่ายเต็มงวด
 */
export async function recordPayment(input, ctx) {
  return await tx(() => recordPaymentInTx(input, ctx));
}

export async function recordPaymentInTx(input, ctx) {
  const contract = await get(`SELECT * FROM contracts WHERE id = :id`, { id: input.contractId });
  if (!contract) throw new PaymentError('ไม่พบสัญญา');

  // ข้อ 14: สัญญาที่ปิดหรือรียอดแล้วห้ามรับชำระเพิ่ม เว้นแต่เจ้าของอนุมัติ
  if (contract.status !== 'active') {
    const allowed = ctx?.user?.role === 'owner' && input.ownerOverride === true;
    if (!allowed) {
      throw new PaymentError(
        'สัญญานี้ปิดหรือรียอดแล้ว ไม่สามารถรับชำระเพิ่มได้ (ต้องได้รับอนุมัติจากเจ้าของ)',
      );
    }
  }

  const paidDate = input.paidDate || today();
  if (!isDateStr(paidDate)) throw new PaymentError('วันที่รับเงินไม่ถูกต้อง');

  // ข้อ 14: รายการที่ปิดยอดประจำวันแล้ว การแก้ไขต้องผ่านเจ้าของ
  const closing = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: paidDate });
  if (closing && !(ctx?.user?.role === 'owner' && input.ownerOverride === true)) {
    throw new PaymentError(
      `วันที่ ${paidDate} ปิดยอดประจำวันแล้ว การบันทึกย้อนหลังต้องได้รับอนุมัติจากเจ้าของ`,
    );
  }

  const amountPaid = assertNonNegative(input.amountPaid, 'ยอดจ่ายจริง'); // ข้อ 14: ห้ามรับยอดติดลบ
  const open = await openInstallments(contract.id);
  const current = open[0] ?? null;
  const dueRemaining = current
    ? current.due_amount - current.interest_paid - current.principal_paid
    : 0;

  const { allocations, interestTotal, principalTotal } = allocatePayment({
    amountPaid,
    installments: open,
    principalRemaining: contract.principal_remaining,
    extraToPrincipal: input.extraToPrincipal === true,
  });

  // ข้อ 14: ยอดที่แบ่งเป็นดอกเบี้ยและเงินต้นรวมกันต้องเท่ากับยอดรับจริง
  if (interestTotal + principalTotal !== amountPaid) {
    throw new PaymentError('การแบ่งดอกเบี้ยและเงินต้นไม่ตรงกับยอดรับจริง');
  }

  const status = classifyPayment({ amountPaid, dueRemaining, interestTotal, principalTotal });
  const now = nowISO();
  const receiptNo = await newReceiptNo(paidDate);

  const paymentId = await insert(
    `INSERT INTO payments
       (receipt_no, contract_id, debtor_id, paid_date, recorded_at, received_by,
        due_amount, amount_paid, interest_amount, principal_amount, status, source,
        proof_path, note, allocations, created_at)
     VALUES
       (:rc, :cid, :did, :pd, :now, :uid, :due, :amt, :i, :p, :status, :source,
        :proof, :note, :alloc, :now)`,
    {
      rc: receiptNo,
      cid: contract.id,
      did: contract.debtor_id,
      pd: paidDate,
      now,
      uid: ctx?.user?.id ?? null,
      due: dueRemaining,
      amt: amountPaid,
      i: interestTotal,
      p: principalTotal,
      status,
      source: input.source ?? 'collection',
      proof: input.proofPath ?? null,
      note: input.note ?? null,
      alloc: JSON.stringify(allocations),
    },
  );

  await applyAllocations(allocations, +1);
  await updatePrincipal(contract.id, -principalTotal);
  await refreshContractStatus(contract.id);

  const payment = await getPayment(paymentId);
  await audit({
    userId: ctx?.user?.id,
    action: 'create',
    entity: 'payment',
    entityId: paymentId,
    after: payment,
    reason: input.reason ?? null,
    ip: ctx?.ip,
  });

  return payment;
}

/** งวดแรกที่หัก ณ วันทำสัญญา (ข้อ 7.2 / ข้อ 14) */
export async function recordFirstInstallment({ contractId, ctx }) {
  const contract = await get(`SELECT * FROM contracts WHERE id = :id`, { id: contractId });
  const first = await get(
    `SELECT * FROM installments WHERE contract_id = :cid AND seq = 1`,
    { cid: contractId },
  );
  if (!first) return null;
  return await recordPaymentInTx(
    {
      contractId,
      amountPaid: first.due_amount,
      paidDate: contract.start_date,
      source: 'first_installment',
      note: 'หักงวดแรก ณ วันทำสัญญา',
      ownerOverride: true, // ระบบเป็นผู้บันทึกเอง ไม่ติดล็อกปิดยอดวัน
    },
    ctx,
  );
}

async function applyAllocations(allocations, sign) {
  for (const a of allocations) {
    if (!a.installment_id) continue;
    const inst = await get(
      `UPDATE installments
         SET interest_paid = interest_paid + :i, principal_paid = principal_paid + :p
       WHERE id = :id
       RETURNING *`,
      { id: a.installment_id, i: sign * a.interest, p: sign * a.principal },
    );
    await run(`UPDATE installments SET status = :s WHERE id = :id`, {
      id: inst.id,
      s: installmentStatus(inst),
    });
  }
}

async function updatePrincipal(contractId, delta) {
  const c = await get(
    `UPDATE contracts SET principal_remaining = principal_remaining + :d, updated_at = :now
     WHERE id = :id
     RETURNING principal_remaining`,
    { id: contractId, d: delta, now: nowISO() },
  );
  // ข้อ 14: เงินต้นคงเหลือต้องไม่ต่ำกว่า 0 (ฐานข้อมูลมี CHECK ซ้ำอีกชั้น)
  if (c.principal_remaining < 0) throw new PaymentError('เงินต้นคงเหลือติดลบ — ยกเลิกรายการ');
}

/** ปิดสัญญาอัตโนมัติเมื่อชำระครบทุกงวดและเงินต้นเป็นศูนย์ */
async function refreshContractStatus(contractId) {
  const c = await get(`SELECT * FROM contracts WHERE id = :id`, { id: contractId });
  if (c.status === 'closed_reyod' || c.status === 'cancelled') return;
  const openRow = await get(
    `SELECT COUNT(*) AS n FROM installments
     WHERE contract_id = :cid AND (interest_paid < interest_due OR principal_paid < principal_due)`,
    { cid: contractId },
  );
  const done = Number(openRow.n) === 0 && c.principal_remaining === 0;
  const nextStatus = done ? 'completed' : 'active';
  if (nextStatus !== c.status) {
    await run(
      `UPDATE contracts SET status = :s, closed_at = :closed, updated_at = :now WHERE id = :id`,
      {
        id: contractId,
        s: nextStatus,
        closed: done ? nowISO() : null,
        now: nowISO(),
      },
    );
  }
}

/**
 * ยกเลิกรายการรับเงิน (ข้อ 14/15)
 * ไม่ลบถาวร — ย้อนยอดกลับ เปลี่ยนสถานะเป็นยกเลิก และเก็บผู้ยกเลิก/เหตุผลไว้
 */
export async function voidPayment({ paymentId, reason }, ctx) {
  return await tx(async () => {
    const payment = await get(`SELECT * FROM payments WHERE id = :id`, { id: paymentId });
    if (!payment) throw new PaymentError('ไม่พบรายการรับเงิน');
    if (payment.is_void) throw new PaymentError('รายการนี้ถูกยกเลิกไปแล้ว');
    if (!reason || !String(reason).trim()) throw new PaymentError('ต้องระบุเหตุผลการยกเลิก');

    const closing = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, {
      d: payment.paid_date,
    });
    if (closing && ctx?.user?.role !== 'owner') {
      throw new PaymentError('รายการอยู่ในวันที่ปิดยอดแล้ว ต้องให้เจ้าของเป็นผู้ยกเลิก');
    }

    // ถ้าสัญญานี้ถูกรียอดไปแล้ว การย้อนยอดจะทำให้เงินต้นไปค้างบนสัญญาที่ปิดแล้ว
    // ซึ่งรายงานไม่นับรวม เท่ากับเงินหายจากบัญชีโดยไม่มีสัญญาณเตือน
    // ปฏิเสธไว้ก่อนดีกว่าปล่อยให้ตัวเลขผิดเงียบ ๆ
    const reyodLink = await get(
      `SELECT l.to_contract_id, c.contract_no AS new_no, f.contract_no AS old_no
       FROM contract_links l
       JOIN contracts c ON c.id = l.to_contract_id
       JOIN contracts f ON f.id = l.from_contract_id
       WHERE l.from_contract_id = :cid`,
      { cid: payment.contract_id },
    );
    if (reyodLink) {
      throw new PaymentError(
        `ยกเลิกไม่ได้ เพราะสัญญา ${reyodLink.old_no} ถูกรียอดไปเป็น ${reyodLink.new_no} แล้ว ` +
          'ยอดที่ยกไปคำนวณจากรายการนี้ด้วย การย้อนยอดจะทำให้เงินต้นค้างบนสัญญาที่ปิดแล้ว ' +
          'และหายจากรายงาน — ให้บันทึกรายการปรับปรุงในสัญญาใหม่แทน',
      );
    }

    const allocations = JSON.parse(payment.allocations || '[]');
    await applyAllocations(allocations, -1);
    await updatePrincipal(payment.contract_id, +payment.principal_amount);

    const now = nowISO();
    await run(
      `UPDATE payments
         SET is_void = 1, void_reason = :reason, voided_by = :uid, voided_at = :now
       WHERE id = :id`,
      { id: paymentId, reason, uid: ctx?.user?.id ?? null, now },
    );
    await refreshContractStatus(payment.contract_id);

    const after = await getPayment(paymentId);
    await audit({
      userId: ctx?.user?.id,
      action: 'void',
      entity: 'payment',
      entityId: paymentId,
      before: payment,
      after,
      reason,
      ip: ctx?.ip,
    });

    return after;
  });
}

export async function getPayment(id) {
  return await get(
    `SELECT p.*, c.contract_no, d.full_name AS debtor_name, d.code AS debtor_code,
            u.full_name AS received_by_name, v.full_name AS voided_by_name
     FROM payments p
     JOIN contracts c ON c.id = p.contract_id
     JOIN debtors d   ON d.id = p.debtor_id
     LEFT JOIN users u ON u.id = p.received_by
     LEFT JOIN users v ON v.id = p.voided_by
     WHERE p.id = :id`,
    { id },
  );
}

/** ตัวอย่างผลการคำนวณก่อนกดบันทึก (ข้อ 8 "ระบบคำนวณและแสดงผลก่อนกดบันทึก") */
export async function previewPayment({ contractId, amountPaid, extraToPrincipal = false }) {
  const contract = await get(`SELECT * FROM contracts WHERE id = :id`, { id: contractId });
  if (!contract) throw new PaymentError('ไม่พบสัญญา');
  const open = await openInstallments(contractId);
  const current = open[0] ?? null;
  const dueRemaining = current
    ? current.due_amount - current.interest_paid - current.principal_paid
    : 0;
  const { allocations, interestTotal, principalTotal } = allocatePayment({
    amountPaid,
    installments: open,
    principalRemaining: contract.principal_remaining,
    extraToPrincipal,
  });
  return {
    due_remaining: dueRemaining,
    amount_paid: amountPaid,
    interest_amount: interestTotal,
    principal_amount: principalTotal,
    principal_remaining_after: contract.principal_remaining - principalTotal,
    status: classifyPayment({ amountPaid, dueRemaining, interestTotal, principalTotal }),
    allocations,
  };
}

export async function listPayments(filter = {}) {
  const where = ['1=1'];
  const params = {};
  if (filter.contractId) {
    where.push('p.contract_id = :cid');
    params.cid = filter.contractId;
  }
  if (filter.debtorId) {
    where.push('p.debtor_id = :did');
    params.did = filter.debtorId;
  }
  if (filter.from) {
    where.push('p.paid_date >= :from');
    params.from = filter.from;
  }
  if (filter.to) {
    where.push('p.paid_date <= :to');
    params.to = filter.to;
  }
  if (filter.receivedBy) {
    where.push('p.received_by = :rb');
    params.rb = filter.receivedBy;
  }
  if (filter.employeeId) {
    where.push('c.employee_id = :emp');
    params.emp = filter.employeeId;
  }
  if (!filter.includeVoid) where.push('p.is_void = 0');
  params.limit = filter.limit ?? 200;

  return await all(
    `SELECT p.*, c.contract_no, d.full_name AS debtor_name, d.code AS debtor_code,
            u.full_name AS received_by_name
     FROM payments p
     JOIN contracts c ON c.id = p.contract_id
     JOIN debtors d   ON d.id = p.debtor_id
     LEFT JOIN users u ON u.id = p.received_by
     WHERE ${where.join(' AND ')}
     ORDER BY p.paid_date DESC, p.id DESC
     LIMIT :limit`,
    params,
  );
}
