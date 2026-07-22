import { Router } from 'express';
import { all, get, run, insert } from '../db/index.js';
import {
  previewContract,
  createContract,
  getContract,
  listInstallments,
  contractSummary,
  contractBehaviour,
  contractChain,
  reyod,
  reyodPreview,
  CONTRACT_TYPES,
} from '../domain/contracts.js';
import { listPayments } from '../domain/payments.js';
import { auditTrail, audit } from '../lib/audit.js';
import { nowISO } from '../lib/time.js';
import { needsApproval } from '../lib/permissions.js';
import { wrap, need, scopeEmployeeId, assertDebtorAccess, intParam, sendCsv } from './_helpers.js';

const router = Router();

router.get('/types', (_req, res) => res.json({ types: CONTRACT_TYPES }));

router.get(
  '/',
  need('debtors_view'),
  wrap(async (req, res) => {
    const scope = await scopeEmployeeId(req.ctx.user);
    const q = String(req.query.q ?? '').trim();
    const status = req.query.status ? String(req.query.status) : null;
    const rows = await all(
      `SELECT c.*, d.full_name AS debtor_name, d.code AS debtor_code, d.phone AS debtor_phone,
              e.full_name AS employee_name,
              -- ยอดคงเหลือที่ใช้ตอนรียอด ขึ้นกับโหมดคิดดอกของสัญญา
              -- โหมดเหมารวม: ยอดหนี้รวม − ยอดชำระสะสม (มีดอกเดิมรวมอยู่ด้วย)
              -- โหมดเดิม: เงินต้นคงเหลือเหมือนเดิม
              CASE WHEN c.interest_mode = 'flat_total' AND c.total_due > 0
                   THEN GREATEST(0, c.total_due - COALESCE(
                          (SELECT SUM(p.amount_paid) FROM payments p
                            WHERE p.contract_id = c.id AND p.is_void = 0), 0))
                   ELSE c.principal_remaining END AS outstanding
       FROM contracts c
       JOIN debtors d ON d.id = c.debtor_id
       LEFT JOIN employees e ON e.id = c.employee_id
       WHERE 1=1
         ${q ? 'AND (c.contract_no LIKE :like OR d.full_name LIKE :like OR d.phone LIKE :like OR d.code LIKE :like)' : ''}
         ${status ? 'AND c.status = :status' : ''}
         ${scope !== null ? 'AND c.employee_id = :emp' : ''}
       ORDER BY c.id DESC LIMIT :limit`,
      { like: `%${q}%`, status, emp: scope, limit: intParam(req.query.limit, 100) },
    );
    res.json({ items: rows });
  }),
);

/** ตัวอย่างก่อนยืนยัน — แสดงเงินที่ลูกค้าได้รับจริง (ข้อ 7.1) */
router.post(
  '/preview',
  need('contracts_create'),
  wrap(async (req, res) => {
    res.json({ preview: await previewContract(mapContractBody(req.body)) });
  }),
);

router.post(
  '/',
  need('contracts_create'),
  wrap(async (req, res) => {
    const body = mapContractBody(req.body);
    const result = await createContract(body, req.ctx);
    res.status(201).json({
      contract: result.contract,
      preview: result.preview,
      first_payment: result.firstPayment,
    });
  }),
);

router.get(
  '/:id',
  need('debtors_view'),
  wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const contract = await getContract(id);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    await assertDebtorAccess(req.ctx.user, contract.debtor_id);
    res.json({
      contract,
      summary: await contractSummary(id),
      behaviour: await contractBehaviour(id),
      installments: await listInstallments(id),
      payments: await listPayments({ contractId: id, includeVoid: true, limit: 500 }),
      chain: await contractChain(id),
      audit: await auditTrail({ entity: 'contract', entityId: id, limit: 50 }),
    });
  }),
);

/** ตารางชำระสำหรับพิมพ์/ส่งออก (ข้อ 16) */
router.get(
  '/:id/schedule.csv',
  need('debtors_view'),
  wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const contract = await getContract(id);
    if (!contract) return res.status(404).json({ error: 'ไม่พบสัญญา' });
    await assertDebtorAccess(req.ctx.user, contract.debtor_id);
    sendCsv(res, `schedule-${contract.contract_no}.csv`, await listInstallments(id), [
      { label: 'งวดที่', key: 'seq' },
      { label: 'วันครบกำหนด', key: 'due_date' },
      { label: 'ยอดที่ควรจ่าย', value: (r) => (r.due_amount / 100).toFixed(2) },
      { label: 'ดอกเบี้ย', value: (r) => (r.interest_due / 100).toFixed(2) },
      { label: 'เงินต้น', value: (r) => (r.principal_due / 100).toFixed(2) },
      { label: 'ชำระดอกแล้ว', value: (r) => (r.interest_paid / 100).toFixed(2) },
      { label: 'ชำระต้นแล้ว', value: (r) => (r.principal_paid / 100).toFixed(2) },
      { label: 'สถานะ', key: 'status' },
    ]);
  }),
);

// ---- รียอด (ข้อ 9) ----------------------------------------------------------

router.post(
  '/reyod/preview',
  need('reyod'),
  wrap(async (req, res) => {
    res.json({ preview: await reyodPreview(mapReyodBody(req.body)) });
  }),
);

router.post(
  '/reyod',
  need('reyod'),
  wrap(async (req, res) => {
    const body = mapReyodBody(req.body);
    // ผู้จัดการ: ทำได้แต่ต้องรออนุมัติจากเจ้าของ (ตารางสิทธิ์ ข้อ 12)
    if (needsApproval(req.ctx.user, 'reyod')) {
      const approvalId = await insert(
        `INSERT INTO approvals (kind, payload, requested_by, requested_at)
         VALUES ('reyod', :payload, :uid, :now)`,
        { payload: JSON.stringify(body), uid: req.ctx.user.id, now: nowISO() },
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
    res.status(201).json(await reyod(body, req.ctx));
  }),
);

function mapContractBody(b = {}) {
  return {
    debtorId: intParam(b.debtor_id),
    employeeId: intParam(b.employee_id, null),
    type: b.type,
    principalAmount: intParam(b.principal_amount, 0),
    installmentAmount: intParam(b.installment_amount, 0),
    interestPerInst: intParam(b.interest_per_inst, 0),
    numInstallments: intParam(b.num_installments, 0),
    startDate: b.start_date,
    docFee: b.doc_fee === undefined || b.doc_fee === null ? undefined : intParam(b.doc_fee),
    deductFirst: b.deduct_first,
    note: b.note,
    reason: b.reason,
    interestMode: b.interest_mode,
    interestRateBp: b.interest_rate_bp === undefined ? undefined : Number(b.interest_rate_bp),
  };
}

function mapReyodBody(b = {}) {
  return {
    fromContractId: intParam(b.from_contract_id),
    newMoney: intParam(b.new_money, 0),
    type: b.type,
    installmentAmount: b.installment_amount === undefined ? undefined : intParam(b.installment_amount),
    interestPerInst: b.interest_per_inst === undefined ? undefined : intParam(b.interest_per_inst),
    numInstallments: b.num_installments === undefined ? undefined : intParam(b.num_installments),
    startDate: b.start_date,
    docFee: b.doc_fee === undefined || b.doc_fee === null ? undefined : intParam(b.doc_fee),
    deductFirst: b.deduct_first,
    employeeId: b.employee_id === undefined ? undefined : intParam(b.employee_id),
    note: b.note,
    reason: b.reason,
    interestMode: b.interest_mode,
    interestRateBp: b.interest_rate_bp === undefined ? undefined : Number(b.interest_rate_bp),
  };
}

export default router;
