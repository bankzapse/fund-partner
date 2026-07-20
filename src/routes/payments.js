import { Router } from 'express';
import { get, run } from '../db/index.js';
import {
  recordPayment,
  previewPayment,
  voidPayment,
  listPayments,
  getPayment,
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
  wrap((req, res) => {
    const scope = scopeEmployeeId(req.ctx.user);
    res.json({
      items: listPayments({
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
  wrap((req, res) => {
    const scope = scopeEmployeeId(req.ctx.user, 'reports_view');
    const rows = listPayments({
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
  wrap((req, res) => {
    const id = intParam(req.params.contractId);
    const contract = getContract(id);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    assertDebtorAccess(req.ctx.user, contract.debtor_id, 'payments_create');
    res.json({
      summary: contractSummary(id),
      recent: listPayments({ contractId: id, limit: 10 }),
      day_closed: Boolean(
        get(`SELECT 1 AS x FROM daily_closings WHERE closing_date = :d`, { d: today() }),
      ),
    });
  }),
);

/** คำนวณและแสดงผลก่อนกดบันทึก (ข้อ 8) */
router.post(
  '/preview',
  need('payments_create'),
  wrap((req, res) => {
    res.json({
      preview: previewPayment({
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
  wrap((req, res) => {
    const contractId = intParam(req.body?.contract_id);
    const contract = getContract(contractId);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    assertDebtorAccess(req.ctx.user, contract.debtor_id, 'payments_create');

    const proof = req.body?.proof_data_url ? saveDataUrl(req.body.proof_data_url, 'receipt') : null;
    const payment = recordPayment(
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
    res.status(201).json({ payment, summary: contractSummary(contractId) });
  }),
);

router.get(
  '/:id',
  need('debtors_view'),
  wrap((req, res) => {
    const payment = getPayment(intParam(req.params.id));
    if (!payment) return res.status(404).json({ error: 'ไม่พบรายการ' });
    assertDebtorAccess(req.ctx.user, payment.debtor_id);
    res.json({ payment });
  }),
);

/** ยกเลิกรายการรับเงิน — ไม่ลบถาวร (ข้อ 14/15) */
router.post(
  '/:id/void',
  need('payments_void'),
  wrap((req, res) => {
    const id = intParam(req.params.id);
    const reason = req.body?.reason;
    if (!reason) return res.status(400).json({ error: 'ต้องระบุเหตุผลการยกเลิก' });

    if (needsApproval(req.ctx.user, 'payments_void')) {
      const info = run(
        `INSERT INTO approvals (kind, payload, requested_by, requested_at)
         VALUES ('void_payment', :payload, :uid, :now)`,
        {
          payload: JSON.stringify({ paymentId: id, reason }),
          uid: req.ctx.user.id,
          now: nowISO(),
        },
      );
      const approval = get(`SELECT * FROM approvals WHERE id = :id`, {
        id: Number(info.lastInsertRowid),
      });
      audit({
        userId: req.ctx.user.id,
        action: 'request_approval',
        entity: 'approval',
        entityId: approval.id,
        after: approval,
        ip: req.ctx.ip,
      });
      return res.status(202).json({ pending_approval: approval });
    }

    const payment = voidPayment({ paymentId: id, reason }, req.ctx);
    res.json({ payment, summary: contractSummary(payment.contract_id) });
  }),
);

export default router;
