import { Router } from 'express';
import { get } from '../db/index.js';
import { financeSummary, collectionSummary, debtorStatusCounts, dueToday } from '../domain/reports.js';
import { today, monthRange } from '../lib/time.js';
import { wrap, need, scopeEmployeeId } from './_helpers.js';

const router = Router();

/** Dashboard (SRS ข้อ 5) */
router.get(
  '/',
  need('dashboard'),
  wrap((req, res) => {
    const date = req.query.date ?? today();
    const scope = scopeEmployeeId(req.ctx.user, 'dashboard');
    const day = financeSummary({ from: date, to: date, employeeId: scope });
    const month = financeSummary({ ...monthRange(date.slice(0, 7)), employeeId: scope });

    // เงินทุนทั้งหมด = เงินสดสะสมตามระบบ + เงินต้นที่ยังอยู่กับลูกหนี้
    const allTime = financeSummary({ from: '1900-01-01', to: '2999-12-31', employeeId: scope });
    const capital = {
      total_capital: allTime.net_cash + allTime.principal_outstanding,
      cash_position: allTime.net_cash,
      principal_issued: allTime.principal_issued,
      principal_outstanding: allTime.principal_outstanding,
    };

    res.json({
      date,
      capital,
      today: day,
      month,
      collection_today: collectionSummary({ from: date, to: date, employeeId: scope }),
      debtor_status: debtorStatusCounts({ employeeId: scope, asOf: date }),
      due_today: dueToday({ date, employeeId: scope, limit: 200 }),
      closing: get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: date }),
      pending_approvals:
        req.ctx.user.role === 'owner'
          ? get(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).n
          : 0,
    });
  }),
);

export default router;
