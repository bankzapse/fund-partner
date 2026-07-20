import { all, get, run, insert, tx, DISBURSE_CATEGORY, CAPITAL_OUT_CATEGORY, CAPITAL_IN_CATEGORY } from '../db/index.js';
import { today, nowISO, monthRange, yearRange, addDays } from '../lib/time.js';
import { audit } from '../lib/audit.js';

/**
 * สรุปการเงินตามช่วงเวลา (SRS ข้อ 10.3 และ ข้อ 11)
 *
 *   เงินสดสุทธิ      = เงินรับทั้งหมด - เงินจ่ายทั้งหมด
 *   รายได้จริง       = ดอกเบี้ย + ค่าทำเอกสาร + รายได้อื่น
 *   กำไรสุทธิ        = รายได้จริง - ค่าใช้จ่ายดำเนินงาน
 *   เงินทุนหมุนกลับ  = เงินต้นที่ได้รับคืน
 *
 * สำคัญ (เกณฑ์รับมอบงาน ข้อ 18): เงินต้นรับคืนไม่ถูกนับเป็นรายได้
 * และ "เงินปล่อยใหม่" ไม่ถูกนับเป็นค่าใช้จ่ายดำเนินงาน เพราะเป็นเงินทุน ไม่ใช่ต้นทุน
 */
export async function financeSummary({ from, to, employeeId = null }) {
  const params = { from, to, emp: employeeId };
  const empJoin = employeeId ? 'AND c.employee_id = :emp' : '';

  const payP = get(
    `SELECT
       COALESCE(SUM(p.amount_paid), 0)      AS cash_from_debtors,
       COALESCE(SUM(p.interest_amount), 0)  AS interest_income,
       COALESCE(SUM(p.principal_amount), 0) AS principal_back,
       COUNT(*)                             AS payment_count,
       COALESCE(SUM(CASE WHEN p.status = 'full'          THEN 1 ELSE 0 END), 0) AS full_count,
       COALESCE(SUM(CASE WHEN p.status = 'interest_only' THEN 1 ELSE 0 END), 0) AS interest_only_count,
       COALESCE(SUM(CASE WHEN p.status = 'partial'       THEN 1 ELSE 0 END), 0) AS partial_count
     FROM payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.is_void = 0 AND p.paid_date BETWEEN :from AND :to ${empJoin}`,
    params,
  );

  const incomeP = get(
    `SELECT
       COALESCE(SUM(CASE WHEN category = 'doc_fee' THEN amount ELSE 0 END), 0) AS doc_fee_income,
       COALESCE(SUM(CASE WHEN category = :capIn  THEN amount ELSE 0 END), 0) AS capital_in,
       COALESCE(SUM(CASE WHEN category NOT IN ('doc_fee', :capIn) THEN amount ELSE 0 END), 0) AS other_income,
       COALESCE(SUM(amount), 0) AS total_income_entries
     FROM income_entries
     WHERE is_void = 0 AND entry_date BETWEEN :from AND :to`,
    { from, to, capIn: CAPITAL_IN_CATEGORY },
  );

  const expP = get(
    `SELECT
       COALESCE(SUM(CASE WHEN e.category = :disb  THEN e.amount ELSE 0 END), 0) AS disbursed,
       COALESCE(SUM(CASE WHEN e.category = :capOut THEN e.amount ELSE 0 END), 0) AS capital_out,
       COALESCE(SUM(CASE WHEN e.category NOT IN (:disb, :capOut) THEN e.amount ELSE 0 END), 0) AS operating_expense,
       COALESCE(SUM(e.amount), 0) AS total_expense
     FROM expenses e
     WHERE e.is_void = 0 AND e.entry_date BETWEEN :from AND :to
       ${employeeId ? 'AND e.employee_id = :emp' : ''}`,
    { from, to, disb: DISBURSE_CATEGORY, capOut: CAPITAL_OUT_CATEGORY, emp: employeeId },
  );

  const contractsP = get(
    `SELECT
       COALESCE(SUM(principal_amount), 0) AS principal_issued,
       COALESCE(SUM(cash_disbursed), 0)   AS cash_disbursed,
       COUNT(*)                           AS contract_count
     FROM contracts
     WHERE start_date BETWEEN :from AND :to AND status <> 'cancelled'
       ${employeeId ? 'AND employee_id = :emp' : ''}`,
    { from, to, emp: employeeId },
  );

  const outstandingP = get(
    `SELECT COALESCE(SUM(principal_remaining), 0) AS principal_outstanding,
            COUNT(*) AS active_contracts
     FROM contracts WHERE status = 'active'
       ${employeeId ? 'AND employee_id = :emp' : ''}`,
    { emp: employeeId },
  );

  // ทั้ง 5 คำสั่งไม่ขึ้นต่อกัน จึงยิงพร้อมกันเพื่อลดเวลารอบนฐานข้อมูลคลาวด์
  const [pay, income, exp, contracts, outstanding] = await Promise.all([
    payP, incomeP, expP, contractsP, outstandingP,
  ]);

  const totalIn = pay.cash_from_debtors + income.total_income_entries;
  const totalOut = exp.total_expense;
  const realIncome = pay.interest_income + income.doc_fee_income + income.other_income;
  const netProfit = realIncome - exp.operating_expense;

  return {
    from,
    to,
    // กระแสเงินสด
    total_in: totalIn,
    total_out: totalOut,
    net_cash: totalIn - totalOut,
    // รายได้ / กำไร
    interest_income: pay.interest_income,
    doc_fee_income: income.doc_fee_income,
    other_income: income.other_income,
    capital_in: income.capital_in,
    capital_out: exp.capital_out,
    real_income: realIncome,
    operating_expense: exp.operating_expense,
    net_profit: netProfit,
    // เงินทุน
    principal_back: pay.principal_back,
    principal_issued: contracts.principal_issued,
    cash_disbursed: contracts.cash_disbursed,
    disbursed_out: exp.disbursed,
    principal_outstanding: outstanding.principal_outstanding,
    active_contracts: outstanding.active_contracts,
    contract_count: contracts.contract_count,
    // การเก็บเงิน
    cash_from_debtors: pay.cash_from_debtors,
    payment_count: pay.payment_count,
    full_count: pay.full_count,
    interest_only_count: pay.interest_only_count,
    partial_count: pay.partial_count,
  };
}

/** ยอดที่ควรเก็บ / เก็บจริง / ค้าง ในช่วงเวลา (ข้อ 11) */
export async function collectionSummary({ from, to, employeeId = null }) {
  const expected = await get(
    `SELECT COALESCE(SUM(i.due_amount), 0) AS expected, COUNT(*) AS due_count
     FROM installments i JOIN contracts c ON c.id = i.contract_id
     WHERE i.due_date BETWEEN :from AND :to AND c.status IN ('active','completed')
       ${employeeId ? 'AND c.employee_id = :emp' : ''}`,
    { from, to, emp: employeeId },
  );
  const collected = await get(
    `SELECT COALESCE(SUM(p.amount_paid), 0) AS collected
     FROM payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.is_void = 0 AND p.paid_date BETWEEN :from AND :to
       ${employeeId ? 'AND c.employee_id = :emp' : ''}`,
    { from, to, emp: employeeId },
  );
  return {
    expected: expected.expected,
    due_count: expected.due_count,
    collected: collected.collected,
    outstanding: Math.max(0, expected.expected - collected.collected),
  };
}

/** จำนวนลูกหนี้แยกตามสถานะ (ข้อ 5 / ข้อ 11) */
export async function debtorStatusCounts({ employeeId = null, asOf = today() } = {}) {
  const thresholdRow = await get(
    `SELECT value FROM settings WHERE key = 'overdue_days_threshold'`,
  );
  const threshold = Number(thresholdRow?.value) || 3;

  const rows = await all(
    `SELECT c.id, c.status,
       (SELECT COUNT(*) FROM installments i
          WHERE i.contract_id = c.id AND i.due_date <= :asOf
            AND (i.interest_paid < i.interest_due OR i.principal_paid < i.principal_due)) AS overdue_count,
       (SELECT p.status FROM payments p WHERE p.contract_id = c.id AND p.is_void = 0
          ORDER BY p.paid_date DESC, p.id DESC LIMIT 1) AS last_status
     FROM contracts c
     WHERE 1=1 ${employeeId ? 'AND c.employee_id = :emp' : ''}`,
    { asOf, emp: employeeId },
  );

  const counts = {
    total: rows.length,
    normal: 0,
    interest_only: 0,
    partial: 0,
    overdue: 0,
    completed: 0,
    reyod: 0,
  };
  for (const r of rows) {
    if (r.status === 'completed') counts.completed++;
    else if (r.status === 'closed_reyod') counts.reyod++;
    else if (r.status === 'cancelled') continue;
    else if (r.overdue_count >= threshold) counts.overdue++;
    else if (r.last_status === 'interest_only') counts.interest_only++;
    else if (r.last_status === 'partial') counts.partial++;
    else counts.normal++;
  }
  return counts;
}

/** ลูกหนี้ที่ต้องเก็บวันนี้ พร้อมข้อมูลสำหรับปุ่มรับชำระ (ข้อ 5) */
export async function dueToday({ date = today(), employeeId = null, limit = 500 } = {}) {
  return await all(
    `SELECT c.id AS contract_id, c.contract_no, c.type, c.principal_remaining,
            d.id AS debtor_id, d.code AS debtor_code, d.full_name AS debtor_name, d.phone,
            e.full_name AS employee_name,
            i.seq, i.due_date, i.due_amount,
            (i.due_amount - i.interest_paid - i.principal_paid) AS due_remaining,
            (SELECT COUNT(*) FROM installments x
               WHERE x.contract_id = c.id AND x.due_date < :date
                 AND (x.interest_paid < x.interest_due OR x.principal_paid < x.principal_due)) AS overdue_count,
            (SELECT COALESCE(SUM(x.due_amount - x.interest_paid - x.principal_paid), 0) FROM installments x
               WHERE x.contract_id = c.id AND x.due_date < :date
                 AND (x.interest_paid < x.interest_due OR x.principal_paid < x.principal_due)) AS arrears_amount
     FROM installments i
     JOIN contracts c ON c.id = i.contract_id
     JOIN debtors d   ON d.id = c.debtor_id
     LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.status = 'active'
       AND i.due_date <= :date
       AND (i.interest_paid < i.interest_due OR i.principal_paid < i.principal_due)
       AND i.seq = (SELECT MIN(y.seq) FROM installments y
                    WHERE y.contract_id = c.id
                      AND (y.interest_paid < y.interest_due OR y.principal_paid < y.principal_due))
       ${employeeId ? 'AND c.employee_id = :emp' : ''}
     ORDER BY overdue_count DESC, d.full_name
     LIMIT :limit`,
    { date, emp: employeeId, limit },
  );
}

/** รายงานรายพนักงาน (ข้อ 11) */
export async function employeeReport({ from, to }) {
  const rows = await all(
    `SELECT e.id, e.code, e.full_name, e.area,
       (SELECT COUNT(*) FROM debtors d WHERE d.employee_id = e.id) AS debtor_count,
       (SELECT COALESCE(SUM(p.amount_paid), 0) FROM payments p
          JOIN contracts c ON c.id = p.contract_id
          WHERE c.employee_id = e.id AND p.is_void = 0 AND p.paid_date BETWEEN :from AND :to) AS collected,
       (SELECT COALESCE(SUM(p.interest_amount), 0) FROM payments p
          JOIN contracts c ON c.id = p.contract_id
          WHERE c.employee_id = e.id AND p.is_void = 0 AND p.paid_date BETWEEN :from AND :to) AS interest_collected,
       (SELECT COALESCE(SUM(i.due_amount), 0) FROM installments i
          JOIN contracts c ON c.id = i.contract_id
          WHERE c.employee_id = e.id AND i.due_date BETWEEN :from AND :to
            AND c.status IN ('active','completed')) AS expected,
       (SELECT COALESCE(SUM(x.amount), 0) FROM expenses x
          WHERE x.employee_id = e.id AND x.is_void = 0 AND x.entry_date BETWEEN :from AND :to
            AND x.category <> :disb) AS expenses,
       (SELECT COALESCE(SUM(x.amount), 0) FROM expenses x
          WHERE x.employee_id = e.id AND x.is_void = 0 AND x.entry_date BETWEEN :from AND :to
            AND x.category = 'คอมมิชชั่นพนักงาน') AS commission
     FROM employees e WHERE e.is_active = 1
     ORDER BY collected DESC`,
    { from, to, disb: DISBURSE_CATEGORY },
  );
  return rows.map((r) => ({ ...r, outstanding: Math.max(0, Number(r.expected) - Number(r.collected)) }));
}

/** กราฟรายวันในช่วงเวลา (ข้อ 11) */
export async function dailySeries({ from, to }) {
  const dates = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 400) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  // เรียกพร้อมกัน ไม่เรียงทีละวัน เพราะบนฐานข้อมูลคลาวด์แต่ละครั้งมีค่า latency
  const summaries = await Promise.all(
    dates.map((d) => financeSummary({ from: d, to: d })),
  );
  return summaries.map((s, i) => ({
    date: dates[i],
    total_in: s.total_in,
    total_out: s.total_out,
    net_cash: s.net_cash,
    real_income: s.real_income,
    operating_expense: s.operating_expense,
    net_profit: s.net_profit,
    principal_back: s.principal_back,
  }));
}

/** สรุป 12 เดือนของปี (ข้อ 11 รายปี) */
export async function monthlySeries(year) {
  const months = Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`,
  );
  const summaries = await Promise.all(
    months.map((ym) => financeSummary(monthRange(ym))),
  );
  return summaries.map((s, i) => ({ month: months[i], ...s }));
}

/** รายได้/ค่าใช้จ่ายแยกประเภท (ข้อ 11 กราฟ) */
export async function breakdown({ from, to }) {
  const expenses = await all(
    `SELECT category, COALESCE(SUM(amount), 0) AS amount
     FROM expenses WHERE is_void = 0 AND entry_date BETWEEN :from AND :to
       AND category NOT IN (:disb, :capOut)
     GROUP BY category ORDER BY amount DESC`,
    { from, to, disb: DISBURSE_CATEGORY, capOut: CAPITAL_OUT_CATEGORY },
  );
  const s = await financeSummary({ from, to });
  const income = [
    { category: 'ดอกเบี้ย', amount: s.interest_income },
    { category: 'ค่าทำเอกสาร', amount: s.doc_fee_income },
    { category: 'รายได้อื่น', amount: s.other_income },
  ].filter((r) => r.amount > 0);
  return { income, expenses };
}

// ---- ปิดยอดประจำวัน (ข้อ 10.3) ---------------------------------------------

export async function closingPreview(date) {
  const s = await financeSummary({ from: date, to: date });
  const existing = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: date });
  return { date, summary: s, existing };
}

export async function closeDay({ date, actualCash, note }, ctx) {
  return await tx(async () => {
    const existing = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: date });
    if (existing) throw Object.assign(new Error('วันนี้ปิดยอดไปแล้ว'), { status: 400 });
    const s = await financeSummary({ from: date, to: date });
    const difference = actualCash - s.net_cash;
    await run(
      `INSERT INTO daily_closings
         (closing_date, system_cash, actual_cash, difference, total_in, total_out,
          real_income, net_profit, principal_back, note, closed_by, closed_at)
       VALUES (:d, :sys, :act, :diff, :in, :out, :ri, :np, :pb, :note, :uid, :now)`,
      {
        d: date,
        sys: s.net_cash,
        act: actualCash,
        diff: difference,
        in: s.total_in,
        out: s.total_out,
        ri: s.real_income,
        np: s.net_profit,
        pb: s.principal_back,
        note: note ?? null,
        uid: ctx?.user?.id ?? null,
        now: nowISO(),
      },
    );
    const row = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: date });
    await audit({
      userId: ctx?.user?.id,
      action: 'close_day',
      entity: 'daily_closing',
      entityId: date,
      after: row,
      ip: ctx?.ip,
    });
    return row;
  });
}

export async function reopenDay({ date, reason }, ctx) {
  return await tx(async () => {
    const row = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: date });
    if (!row) throw Object.assign(new Error('ยังไม่ได้ปิดยอดวันนี้'), { status: 400 });
    if (!reason) throw Object.assign(new Error('ต้องระบุเหตุผล'), { status: 400 });
    await run(`DELETE FROM daily_closings WHERE closing_date = :d`, { d: date });
    await audit({
      userId: ctx?.user?.id,
      action: 'reopen_day',
      entity: 'daily_closing',
      entityId: date,
      before: row,
      reason,
      ip: ctx?.ip,
    });
    return { ok: true };
  });
}

export { monthRange, yearRange };
