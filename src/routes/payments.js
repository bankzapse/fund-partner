import { Router } from 'express';
import { get, run, insert } from '../db/index.js';
import {
  recordPayment,
  previewPayment,
  voidPayment,
  listPayments,
  getPayment,
  recordFreePayment,
  freePaymentsFor,
} from '../domain/payments.js';
import { contractSummary, getContract } from '../domain/contracts.js';
import { needsApproval } from '../lib/permissions.js';
import { nowISO, today } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { wrap, need, scopeEmployeeId, assertDebtorAccess, saveDataUrl, intParam, sendCsv } from './_helpers.js';

const router = Router();

router.get(
  '/',
  need('debtors_view'),
  wrap(async (req, res) => {
    const scope = await scopeEmployeeId(req.ctx.user);
    res.json({
      items: await listPayments({
        contractId: intParam(req.query.contract_id, null),
        debtorId: intParam(req.query.debtor_id, null),
        from: req.query.from,
        to: req.query.to,
        employeeId: scope,
        includeVoid: req.query.include_void === '1',
        limit: intParam(req.query.limit, 200),
      }),
    });
  }),
);

router.get(
  '/export',
  need('reports_view'),
  wrap(async (req, res) => {
    const scope = await scopeEmployeeId(req.ctx.user, 'reports_view');
    const rows = await listPayments({
      from: req.query.from ?? today(),
      to: req.query.to ?? today(),
      employeeId: scope,
      includeVoid: true,
      limit: 10000,
    });
    sendCsv(res, 'payments.csv', rows, [
      { label: 'เลขที่ใบรับเงิน', key: 'receipt_no' },
      { label: 'วันที่', key: 'paid_date' },
      { label: 'เวลาบันทึก', key: 'recorded_at' },
      { label: 'เลขที่สัญญา', key: 'contract_no' },
      { label: 'ลูกหนี้', key: 'debtor_name' },
      { label: 'ยอดที่ควรจ่าย', value: (r) => (r.due_amount / 100).toFixed(2) },
      { label: 'ยอดจ่ายจริง', value: (r) => (r.amount_paid / 100).toFixed(2) },
      { label: 'ดอกเบี้ย', value: (r) => (r.interest_amount / 100).toFixed(2) },
      { label: 'เงินต้น', value: (r) => (r.principal_amount / 100).toFixed(2) },
      { label: 'สถานะ', key: 'status' },
      { label: 'ผู้รับเงิน', key: 'received_by_name' },
      { label: 'ยกเลิก', value: (r) => (r.is_void ? 'ยกเลิก' : '') },
    ]);
  }),
);

/** ข้อมูลประกอบหน้ารับชำระ: ยอดที่ควรจ่าย ดอก/ต้นที่ควรตัด งวดปัจจุบัน เงินต้นคงเหลือ (ข้อ 8) */
router.get(
  '/context/:contractId',
  need('payments_create'),
  wrap(async (req, res) => {
    const id = intParam(req.params.contractId);
    const contract = await getContract(id);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    await assertDebtorAccess(req.ctx.user, contract.debtor_id, 'payments_create');
    res.json({
      summary: await contractSummary(id),
      recent: await listPayments({ contractId: id, limit: 10 }),
      day_closed: Boolean(
        await get(`SELECT 1 AS x FROM daily_closings WHERE closing_date = :d`, { d: today() }),
      ),
    });
  }),
);

/** คำนวณและแสดงผลก่อนกดบันทึก (ข้อ 8) */
// ---- จ่ายฟรี / พักงวด (เงินกู้รายวัน) ---------------------------------------
//
// อยู่ใต้ /api/payments ไม่ใช่ /api/cashbook โดยตั้งใจ
// เพราะพนักงานเก็บเงินเป็นคนกดหน้างานจริง แต่สิทธิ์ cashbook ของตำแหน่งนี้เป็น "ไม่ได้"
// ถ้าไปใช้ endpoint ของ cashbook จะโดนปฏิเสธทันที
// และการเปิดสิทธิ์ cashbook ให้กว้างขึ้นจะเกินความจำเป็น (เห็นสรุปการเงินทั้งวันด้วย)
router.post(
  '/free',
  need('payments_create'),
  wrap(async (req, res) => {
    const contractId = intParam(req.body?.contract_id);
    // กันพนักงานเก็บเงินบันทึกข้ามเขตของคนอื่น ใช้ตัวเดียวกับเส้นทางรับชำระปกติ
    const contract = await getContract(contractId);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    await assertDebtorAccess(req.ctx.user, contract.debtor_id, 'payments_create');
    res.status(201).json({
      entry: await recordFreePayment(
        {
          contractId,
          amount: intParam(req.body?.amount, 0),
          paidDate: req.body?.paid_date,
          note: req.body?.note,
          allowDuplicate: req.body?.allow_duplicate === true,
          ownerOverride: req.body?.owner_override === true,
        },
        req.ctx,
      ),
    });
  }),
);

router.get(
  '/free/:contractId',
  need('debtors_view'),
  wrap(async (req, res) => {
    const contractId = intParam(req.params.contractId);
    const contract = await getContract(contractId);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    await assertDebtorAccess(req.ctx.user, contract.debtor_id, 'debtors_view');
    res.json({ items: await freePaymentsFor(contractId) });
  }),
);

router.post(
  '/preview',
  need('payments_create'),
  wrap(async (req, res) => {
    res.json({
      preview: await previewPayment({
        contractId: intParam(req.body?.contract_id),
        amountPaid: intParam(req.body?.amount_paid, 0),
        extraToPrincipal: req.body?.extra_to_principal === true,
      }),
    });
  }),
);

router.post(
  '/',
  need('payments_create'),
  wrap(async (req, res) => {
    const contractId = intParam(req.body?.contract_id);
    const contract = await getContract(contractId);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    await assertDebtorAccess(req.ctx.user, contract.debtor_id, 'payments_create');

    const proof = req.body?.proof_data_url ? await saveDataUrl(req.body.proof_data_url, 'receipt') : null;
    const payment = await recordPayment(
      {
        contractId,
        amountPaid: intParam(req.body?.amount_paid, 0),
        paidDate: req.body?.paid_date,
        note: req.body?.note,
        proofPath: proof?.path ?? null,
        extraToPrincipal: req.body?.extra_to_principal === true,
        ownerOverride: req.body?.owner_override === true,
      },
      req.ctx,
    );
    res.status(201).json({ payment, summary: await contractSummary(contractId) });
  }),
);

router.get(
  '/:id',
  need('debtors_view'),
  wrap(async (req, res) => {
    const payment = await getPayment(intParam(req.params.id));
    if (!payment) return res.status(404).json({ error: 'ไม่พบรายการ' });
    await assertDebtorAccess(req.ctx.user, payment.debtor_id);
    res.json({ payment });
  }),
);

/** ยกเลิกรายการรับเงิน — ไม่ลบถาวร (ข้อ 14/15) */
router.post(
  '/:id/void',
  need('payments_void'),
  wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const reason = req.body?.reason;
    if (!reason) return res.status(400).json({ error: 'ต้องระบุเหตุผลการยกเลิก' });

    if (needsApproval(req.ctx.user, 'payments_void')) {
      const approvalId = await insert(
        `INSERT INTO approvals (kind, payload, requested_by, requested_at)
         VALUES ('void_payment', :payload, :uid, :now)`,
        {
          payload: JSON.stringify({ paymentId: id, reason }),
          uid: req.ctx.user.id,
          now: nowISO(),
        },
      );
      const approval = await get(`SELECT * FROM approvals WHERE id = :id`, { id: approvalId });
      await audit({
        userId: req.ctx.user.id,
        action: 'request_approval',
        entity: 'approval',
        entityId: approval.id,
        after: approval,
        ip: req.ctx.ip,
      });
      return res.status(202).json({ pending_approval: approval });
    }

    const payment = await voidPayment({ paymentId: id, reason }, req.ctx);
    res.json({ payment, summary: await contractSummary(payment.contract_id) });
  }),
);

export default router;
