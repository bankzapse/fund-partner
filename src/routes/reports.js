import { Router } from 'express';
import { all } from '../db/index.js';
import {
  financeSummary,
  collectionSummary,
  debtorStatusCounts,
  employeeReport,
  dailySeries,
  monthlySeries,
  breakdown,
  monthRange,
  yearRange,
} from '../domain/reports.js';
import { today } from '../lib/time.js';
import { wrap, need, scopeEmployeeId, intParam, sendCsv } from './_helpers.js';

const router = Router();

/** แปลงพารามิเตอร์ช่วงเวลา: today | month | year | custom (ข้อ 11) */
function resolveRange(query) {
  const period = query.period ?? 'today';
  if (period === 'today') return { from: query.date ?? today(), to: query.date ?? today() };
  if (period === 'month') return monthRange(query.month ?? today().slice(0, 7));
  if (period === 'year') return yearRange(query.year ?? today().slice(0, 4));
  return { from: query.from ?? today(), to: query.to ?? today() };
}

router.get(
  '/summary',
  need('reports_view'),
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    const scope = await scopeEmployeeId(req.ctx.user, 'reports_view');
    res.json({
      from,
      to,
      finance: await financeSummary({ from, to, employeeId: scope }),
      collection: await collectionSummary({ from, to, employeeId: scope }),
      debtor_status: await debtorStatusCounts({ employeeId: scope }),
      breakdown: await breakdown({ from, to }),
    });
  }),
);

router.get(
  '/daily-series',
  need('reports_view'),
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    res.json({ items: await dailySeries({ from, to }) });
  }),
);

router.get(
  '/monthly-series',
  need('reports_view'),
  wrap(async (req, res) => {
    res.json({ items: await monthlySeries(req.query.year ?? today().slice(0, 4)) });
  }),
);

router.get(
  '/employees',
  need('reports_view'),
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    res.json({ items: await employeeReport({ from, to }) });
  }),
);

/** รายงานลูกหนี้ค้างชำระ และลูกหนี้จ่ายเฉพาะดอกหลายวัน (ข้อ 16) */
router.get(
  '/overdue',
  need('reports_view'),
  wrap(async (req, res) => {
    const asOf = req.query.date ?? today();
    const scope = await scopeEmployeeId(req.ctx.user, 'reports_view');
    const minDays = intParam(req.query.min_days, 1);
    res.json({
      overdue: await all(
        `SELECT c.id AS contract_id, c.contract_no, c.principal_remaining, c.type,
                d.code AS debtor_code, d.full_name AS debtor_name, d.phone,
                e.full_name AS employee_name,
                COUNT(i.id) AS overdue_installments,
                COALESCE(SUM(i.due_amount - i.interest_paid - i.principal_paid), 0) AS arrears_amount,
                MIN(i.due_date) AS oldest_due
         FROM installments i
         JOIN contracts c ON c.id = i.contract_id
         JOIN debtors d ON d.id = c.debtor_id
         LEFT JOIN employees e ON e.id = c.employee_id
         WHERE c.status = 'active' AND i.due_date < :asOf
           AND (i.interest_paid < i.interest_due OR i.principal_paid < i.principal_due)
           ${scope !== null ? 'AND c.employee_id = :emp' : ''}
         GROUP BY c.id, c.contract_no, c.principal_remaining, c.type,
                  d.code, d.full_name, d.phone, e.full_name
         HAVING COUNT(i.id) >= :minDays
         ORDER BY arrears_amount DESC`,
        { asOf, emp: scope, minDays },
      ),
      interest_only: await all(
        `SELECT c.id AS contract_id, c.contract_no, c.principal_remaining,
                d.code AS debtor_code, d.full_name AS debtor_name, d.phone,
                COUNT(p.id) AS interest_only_count,
                MAX(p.paid_date) AS last_paid
         FROM payments p
         JOIN contracts c ON c.id = p.contract_id
         JOIN debtors d ON d.id = c.debtor_id
         WHERE p.is_void = 0 AND p.status = 'interest_only' AND c.status = 'active'
           ${scope !== null ? 'AND c.employee_id = :emp' : ''}
         GROUP BY c.id, c.contract_no, c.principal_remaining,
                  d.code, d.full_name, d.phone
         HAVING COUNT(p.id) >= :minDays
         ORDER BY interest_only_count DESC`,
        { emp: scope, minDays },
      ),
    });
  }),
);

/** ประวัติการรียอดและความเชื่อมโยงของสัญญา (ข้อ 16) */
router.get(
  '/reyod',
  need('reports_view'),
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    res.json({
      items: await all(
        `SELECT l.*, fc.contract_no AS from_no, tc.contract_no AS to_no,
                d.full_name AS debtor_name, d.code AS debtor_code,
                u.full_name AS created_by_name, tc.principal_amount AS new_principal
         FROM contract_links l
         JOIN contracts fc ON fc.id = l.from_contract_id
         JOIN contracts tc ON tc.id = l.to_contract_id
         JOIN debtors d ON d.id = tc.debtor_id
         LEFT JOIN users u ON u.id = l.created_by
         WHERE substr(l.created_at, 1, 10) BETWEEN :from AND :to
         ORDER BY l.id DESC`,
        { from, to },
      ),
    });
  }),
);

/** กำไรขาดทุน (ข้อ 16) — เงินต้นรับคืนไม่ถูกนับเป็นรายได้ (เกณฑ์ข้อ 18) */
router.get(
  '/profit-loss',
  need('profit_view'),
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    const f = await financeSummary({ from, to });
    res.json({
      from,
      to,
      revenue: [
        { label: 'ดอกเบี้ยรับ', amount: f.interest_income },
        { label: 'ค่าทำเอกสาร', amount: f.doc_fee_income },
        { label: 'รายได้อื่น', amount: f.other_income },
      ],
      total_revenue: f.real_income,
      expenses: (await breakdown({ from, to })).expenses,
      total_expense: f.operating_expense,
      net_profit: f.net_profit,
      capital_flow: {
        principal_issued: f.principal_issued,
        cash_disbursed: f.cash_disbursed,
        principal_back: f.principal_back,
        principal_outstanding: f.principal_outstanding,
        note: 'เงินต้นที่ปล่อยและรับคืนเป็นการหมุนเวียนเงินทุน ไม่นับเป็นรายได้หรือค่าใช้จ่าย',
      },
    });
  }),
);

router.get(
  '/summary.csv',
  need('reports_view'),
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req.query);
    const f = await financeSummary({ from, to });
    const rows = [
      ['เงินรับทั้งหมด', f.total_in],
      ['เงินจ่ายทั้งหมด', f.total_out],
      ['เงินสดสุทธิ', f.net_cash],
      ['ดอกเบี้ยรับ', f.interest_income],
      ['ค่าทำเอกสาร', f.doc_fee_income],
      ['รายได้อื่น', f.other_income],
      ['รายได้จริง', f.real_income],
      ['ค่าใช้จ่ายดำเนินงาน', f.operating_expense],
      ['กำไรสุทธิ', f.net_profit],
      ['เงินต้นที่ปล่อย', f.principal_issued],
      ['เงินต้นรับคืน (เงินทุนหมุนกลับ)', f.principal_back],
      ['เงินต้นคงเหลือในลูกหนี้', f.principal_outstanding],
    ].map(([label, amount]) => ({ label, amount }));

    sendCsv(res, `report-${from}-${to}.csv`, rows, [
      { label: 'รายการ', key: 'label' },
      { label: 'จำนวนเงิน (บาท)', value: (r) => (r.amount / 100).toFixed(2) },
    ]);
  }),
);

export default router;
