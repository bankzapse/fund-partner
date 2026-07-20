import { Router } from 'express';
import { all, get, run, insert, getAllSettings, DISBURSE_CATEGORY, CAPITAL_IN_CATEGORY, CAPITAL_OUT_CATEGORY } from '../db/index.js';
import { nowISO, today } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { assertNonNegative } from '../lib/money.js';
import { financeSummary, closingPreview, closeDay, reopenDay } from '../domain/reports.js';
import { listPayments } from '../domain/payments.js';
import { wrap, need, saveDataUrl, intParam, sendCsv } from './_helpers.js';

const router = Router();

/** สมุดรายวัน: รายรับ-รายจ่ายของวัน พร้อมสูตรสรุป (SRS ข้อ 10) */
router.get(
  '/day',
  need('cashbook'),
  wrap(async (req, res) => {
    const date = req.query.date ?? today();
    const settings = await getAllSettings();
    res.json({
      date,
      summary: await financeSummary({ from: date, to: date }),
      payments: await listPayments({ from: date, to: date, limit: 1000 }),
      income: await all(
        `SELECT i.*, u.full_name AS created_by_name, c.contract_no
         FROM income_entries i
         LEFT JOIN users u ON u.id = i.created_by
         LEFT JOIN contracts c ON c.id = i.contract_id
         WHERE i.entry_date = :d ORDER BY i.id DESC`,
        { d: date },
      ),
      expenses: await all(
        `SELECT e.*, u.full_name AS created_by_name, emp.full_name AS employee_name, c.contract_no
         FROM expenses e
         LEFT JOIN users u ON u.id = e.created_by
         LEFT JOIN employees emp ON emp.id = e.employee_id
         LEFT JOIN contracts c ON c.id = e.contract_id
         WHERE e.entry_date = :d ORDER BY e.id DESC`,
        { d: date },
      ),
      closing: await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: date }),
      categories: {
        expense: JSON.parse(settings.expense_categories),
        income: JSON.parse(settings.income_categories),
      },
      disburse_category: DISBURSE_CATEGORY,
      capital_in_category: CAPITAL_IN_CATEGORY,
      capital_out_category: CAPITAL_OUT_CATEGORY,
    });
  }),
);

router.post(
  '/expenses',
  need('cashbook'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const amount = assertNonNegative(intParam(b.amount, 0), 'จำนวนเงิน');
    if (amount === 0) return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0' });
    const entryDate = b.entry_date ?? today();
    await assertDayOpen(entryDate, req.ctx.user);

    const receipt = b.receipt_data_url ? await saveDataUrl(b.receipt_data_url, 'expense') : null;
    const expenseId = await insert(
      `INSERT INTO expenses (entry_date, category, amount, description, paid_by, employee_id,
                             contract_id, receipt_path, approved_by, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :paid, :emp, :cid, :receipt, :appr, :uid, :now)`,
      {
        d: entryDate,
        cat: b.category ?? 'ค่าใช้จ่ายอื่น',
        amt: amount,
        desc: b.description ?? null,
        paid: b.paid_by ?? req.ctx.user.id,
        emp: b.employee_id ?? null,
        cid: b.contract_id ?? null,
        receipt: receipt?.path ?? null,
        appr: req.ctx.user.role === 'owner' ? req.ctx.user.id : null,
        uid: req.ctx.user.id,
        now: nowISO(),
      },
    );
    const row = await get(`SELECT * FROM expenses WHERE id = :id`, { id: expenseId });
    await audit({
      userId: req.ctx.user.id,
      action: 'create',
      entity: 'expense',
      entityId: row.id,
      after: row,
      ip: req.ctx.ip,
    });
    res.status(201).json({ expense: row });
  }),
);

router.post(
  '/income',
  need('cashbook'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const amount = assertNonNegative(intParam(b.amount, 0), 'จำนวนเงิน');
    if (amount === 0) return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0' });
    const entryDate = b.entry_date ?? today();
    await assertDayOpen(entryDate, req.ctx.user);

    const incomeId = await insert(
      `INSERT INTO income_entries (entry_date, category, amount, description, contract_id, debtor_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :cid, :did, :uid, :now)`,
      {
        d: entryDate,
        cat: b.category ?? 'รายรับอื่น',
        amt: amount,
        desc: b.description ?? null,
        cid: b.contract_id ?? null,
        did: b.debtor_id ?? null,
        uid: req.ctx.user.id,
        now: nowISO(),
      },
    );
    const row = await get(`SELECT * FROM income_entries WHERE id = :id`, { id: incomeId });
    await audit({
      userId: req.ctx.user.id,
      action: 'create',
      entity: 'income_entry',
      entityId: row.id,
      after: row,
      ip: req.ctx.ip,
    });
    res.status(201).json({ income: row });
  }),
);

/** ยกเลิกรายการ (ไม่ลบถาวร — ข้อ 15) */
router.post(
  '/:kind(expenses|income)/:id/void',
  need('cashbook'),
  wrap(async (req, res) => {
    const table = req.params.kind === 'expenses' ? 'expenses' : 'income_entries';
    const id = intParam(req.params.id);
    const reason = req.body?.reason;
    if (!reason) return res.status(400).json({ error: 'ต้องระบุเหตุผลการยกเลิก' });
    const before = await get(`SELECT * FROM ${table} WHERE id = :id`, { id });
    if (!before) return res.status(404).json({ error: 'ไม่พบรายการ' });
    if (before.is_void) return res.status(400).json({ error: 'รายการนี้ถูกยกเลิกไปแล้ว' });
    await assertDayOpen(before.entry_date, req.ctx.user);

    await run(`UPDATE ${table} SET is_void = 1, void_reason = :r WHERE id = :id`, { id, r: reason });
    const after = await get(`SELECT * FROM ${table} WHERE id = :id`, { id });
    await audit({
      userId: req.ctx.user.id,
      action: 'void',
      entity: table === 'expenses' ? 'expense' : 'income_entry',
      entityId: id,
      before,
      after,
      reason,
      ip: req.ctx.ip,
    });
    res.json({ item: after });
  }),
);

// ---- ปิดยอดประจำวัน (ข้อ 10.3) ---------------------------------------------

router.get(
  '/closing',
  need('daily_closing'),
  wrap(async (req, res) => {
    res.json(await closingPreview(req.query.date ?? today()));
  }),
);

router.post(
  '/closing',
  need('daily_closing'),
  wrap(async (req, res) => {
    const row = await closeDay(
      {
        date: req.body?.date ?? today(),
        actualCash: intParam(req.body?.actual_cash, 0),
        note: req.body?.note,
      },
      req.ctx,
    );
    res.status(201).json({ closing: row });
  }),
);

/** เปิดยอดที่ปิดแล้วอีกครั้ง — เจ้าของเท่านั้น (ข้อ 14) */
router.post(
  '/closing/reopen',
  need('settings_manage'),
  wrap(async (req, res) => {
    res.json(await reopenDay({ date: req.body?.date, reason: req.body?.reason }, req.ctx));
  }),
);

router.get(
  '/closings',
  need('daily_closing'),
  wrap(async (req, res) => {
    res.json({
      items: await all(
        `SELECT dc.*, u.full_name AS closed_by_name FROM daily_closings dc
         LEFT JOIN users u ON u.id = dc.closed_by
         ORDER BY closing_date DESC LIMIT :limit`,
        { limit: intParam(req.query.limit, 60) },
      ),
    });
  }),
);

router.get(
  '/export',
  need('cashbook'),
  wrap(async (req, res) => {
    const from = req.query.from ?? today();
    const to = req.query.to ?? today();
    const rows = [
      ...(await all(
        `SELECT entry_date, 'รายรับ' AS kind, category, amount, description, is_void
         FROM income_entries WHERE entry_date BETWEEN :from AND :to`,
        { from, to },
      )),
      ...(await all(
        `SELECT entry_date, 'รายจ่าย' AS kind, category, amount, description, is_void
         FROM expenses WHERE entry_date BETWEEN :from AND :to`,
        { from, to },
      )),
    ].sort((a, b) => a.entry_date.localeCompare(b.entry_date));

    sendCsv(res, `cashbook-${from}-${to}.csv`, rows, [
      { label: 'วันที่', key: 'entry_date' },
      { label: 'ประเภท', key: 'kind' },
      { label: 'หมวด', key: 'category' },
      { label: 'จำนวนเงิน (บาท)', value: (r) => (r.amount / 100).toFixed(2) },
      { label: 'รายละเอียด', key: 'description' },
      { label: 'ยกเลิก', value: (r) => (r.is_void ? 'ยกเลิก' : '') },
    ]);
  }),
);

/** ข้อ 14: รายการที่ปิดยอดประจำวันแล้ว การแก้ไขต้องผ่านเจ้าของ */
async function assertDayOpen(date, user) {
  const closed = await get(`SELECT 1 AS x FROM daily_closings WHERE closing_date = :d`, { d: date });
  if (closed && user.role !== 'owner') {
    throw Object.assign(
      new Error(`วันที่ ${date} ปิดยอดแล้ว การแก้ไขต้องได้รับอนุมัติจากเจ้าของ`),
      { status: 403 },
    );
  }
}

export default router;
