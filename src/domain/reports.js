import { all, get, run, tx, DISBURSE_CATEGORY, CAPITAL_OUT_CATEGORY, CAPITAL_IN_CATEGORY, REYOD_INTEREST_CATEGORY, CLOSE_INTEREST_CATEGORY, UPFRONT_INTEREST_CATEGORY, REYOD_CARRY_RETURN_CATEGORY, DOC_FEE_PAYOUT_CATEGORY, WITHDRAW_INTEREST_CATEGORY, WITHDRAW_FLOATING_CATEGORY } from '../db/index.js';
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
       -- สัญญาเหมารวม (flat_total) ไม่รับรู้ดอกต่อรายการรับ (สเปกข้อ 13-14)
       -- ดอกของสัญญาแบบนั้นจะเข้ากำไรผ่านรายการ "ดอกเบี้ยรับรู้ตอนปิด/รียอด" แทน
       -- ส่วนที่แบ่งต้น/ดอกใน payments ของสัญญาเหมารวมเป็นแค่การจัดสรรภายในเพื่อคุมตารางงวด
       COALESCE(SUM(CASE WHEN c.interest_mode <> 'flat_total' THEN p.interest_amount ELSE 0 END), 0)
         AS interest_income,
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
       -- ค่าทำสัญญา (สเปกข้อ 21): เงินที่กิจการ "ถือแทนพนักงานผู้เปิดสัญญา"
       -- อยู่ในกระแสเงินสด (ถูกหักจากเงินที่จ่ายลูกค้า) แต่ไม่ใช่รายได้กิจการ
       COALESCE(SUM(CASE WHEN i.category = 'doc_fee' THEN i.amount ELSE 0 END), 0) AS doc_fee_collected,
       COALESCE(SUM(CASE WHEN i.category = :capIn  THEN i.amount ELSE 0 END), 0) AS capital_in,
       COALESCE(SUM(CASE WHEN i.category NOT IN ('doc_fee', :capIn, :reyodInt, :closeInt, :upfrontInt, :carryRet) THEN i.amount ELSE 0 END), 0) AS other_income,
       -- ดอกที่รับรู้ตอนรียอด/ตอนปิดสัญญา เป็นรายได้ทางบัญชี แต่ไม่มีเงินสดเคลื่อนไหวจริง
       -- (ตอนรียอด: กลายเป็นยอดหนี้สัญญาใหม่ / ตอนปิด: เงินสดเข้ามาก่อนแล้วระหว่างสัญญา)
       -- จึงต้องแยกออกมา ไม่นับรวมในกระแสเงินสด
       COALESCE(SUM(CASE WHEN i.category = :reyodInt THEN i.amount ELSE 0 END), 0) AS reyod_interest_income,
       COALESCE(SUM(CASE WHEN i.category = :closeInt THEN i.amount ELSE 0 END), 0) AS close_interest_income,
       -- ดอกหักก่อน (สเปกข้อ 15) ต่างจากสองก้อนบน: เป็น "เงินสดจริง" —
       -- ถูกหักออกจากเงินที่จ่ายให้ลูกค้า ณ วันเปิด จึงอยู่ในกระแสเงินสดตามปกติ
       COALESCE(SUM(CASE WHEN i.category = :upfrontInt THEN i.amount ELSE 0 END), 0) AS upfront_interest_income,
       COALESCE(SUM(i.amount), 0) AS total_income_entries
     FROM income_entries i
     WHERE i.is_void = 0 AND i.entry_date BETWEEN :from AND :to
     ${employeeId ? `AND EXISTS (
       SELECT 1 FROM contracts c2 WHERE c2.id = i.contract_id AND c2.employee_id = :emp
     )` : ''}`,
    {
      from, to,
      capIn: CAPITAL_IN_CATEGORY,
      reyodInt: REYOD_INTEREST_CATEGORY,
      closeInt: CLOSE_INTEREST_CATEGORY,
      upfrontInt: UPFRONT_INTEREST_CATEGORY,
      carryRet: REYOD_CARRY_RETURN_CATEGORY,
      emp: employeeId,
    },
  );

  const expP = get(
    `SELECT
       COALESCE(SUM(CASE WHEN e.category = :disb  THEN e.amount ELSE 0 END), 0) AS disbursed,
       COALESCE(SUM(CASE WHEN e.category = :capOut THEN e.amount ELSE 0 END), 0) AS capital_out,
       -- จ่ายค่าทำสัญญาให้พนักงาน = ชำระเงินที่ถือแทนอยู่ ไม่ใช่ต้นทุนดำเนินงาน
       COALESCE(SUM(CASE WHEN e.category = :feePayout THEN e.amount ELSE 0 END), 0) AS doc_fee_paid_out,
       -- ถอนดอกเบี้ย/ดอกลอยออกใช้ (สเปกข้อ 33): เจ้าของนำกำไรที่รับรู้แล้วออกไป
       -- เงินสดออกจริง แต่ไม่ใช่ต้นทุน — ห้ามปนกับค่าใช้จ่ายดำเนินงาน
       COALESCE(SUM(CASE WHEN e.category IN (:wInt, :wFloat) THEN e.amount ELSE 0 END), 0) AS interest_withdrawn,
       COALESCE(SUM(CASE WHEN e.category NOT IN (:disb, :capOut, :feePayout, :wInt, :wFloat) THEN e.amount ELSE 0 END), 0) AS operating_expense,
       COALESCE(SUM(e.amount), 0) AS total_expense
     FROM expenses e
     WHERE e.is_void = 0 AND e.entry_date BETWEEN :from AND :to
       ${employeeId ? 'AND e.employee_id = :emp' : ''}`,
    {
      from, to,
      disb: DISBURSE_CATEGORY, capOut: CAPITAL_OUT_CATEGORY, feePayout: DOC_FEE_PAYOUT_CATEGORY,
      wInt: WITHDRAW_INTEREST_CATEGORY, wFloat: WITHDRAW_FLOATING_CATEGORY,
      emp: employeeId,
    },
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

  // ดอกที่รับรู้ตอนรียอด/ตอนปิดสัญญาไม่ใช่เงินสด ณ วันที่รับรู้
  //   - ตอนรียอด: ดอกกลายเป็นส่วนหนึ่งของยอดหนี้สัญญาใหม่ ลูกหนี้ไม่ได้จ่ายเงินเข้ามา
  //   - ตอนปิด:   เงินสดทยอยเข้ามาก่อนแล้วระหว่างสัญญา (ถูกนับใน cash_from_debtors ไปแล้ว)
  // ถ้านับรวมในกระแสเงินสด ยอดปิดวันจะเกิน/ขาดเท่ากับก้อนนี้ทุกครั้ง
  const nonCashIncome = income.reyod_interest_income + income.close_interest_income;
  const totalIn = pay.cash_from_debtors + income.total_income_entries - nonCashIncome;
  const totalOut = exp.total_expense;
  // แต่ในเชิงกำไรต้องนับ ไม่งั้นดอกก้อนนี้จะหายจากรายงานตลอดกาล
  // ดอกหักก่อนเป็นรายได้เงินสดตอนเปิดสัญญา นับทั้งกระแสเงินสดและกำไร
  //
  // ค่าทำสัญญา "ไม่อยู่" ในกำไรกิจการ (สเปกข้อ 21: เป็นรายได้ของพนักงานผู้เปิดสัญญา)
  // และการจ่ายให้พนักงานก็ไม่ใช่ค่าใช้จ่าย — ทั้งคู่เป็นแค่เงินผ่านมือกิจการ
  const realIncome =
    pay.interest_income + income.other_income +
    income.upfront_interest_income + nonCashIncome;
  const netProfit = realIncome - exp.operating_expense;

  return {
    from,
    to,
    // กระแสเงินสด
    total_in: totalIn,
    total_out: totalOut,
    // ดอกที่รับรู้แบบไม่ใช่เงินสด (รียอด + ปิดสัญญา) — แยกให้เห็นทั้งก้อนรวมและรายส่วน
    recognized_interest_income: nonCashIncome,
    reyod_interest_income: income.reyod_interest_income,
    close_interest_income: income.close_interest_income,
    upfront_interest_income: income.upfront_interest_income,
    net_cash: totalIn - totalOut,
    // รายได้ / กำไร
    interest_income: pay.interest_income,
    // ค่าทำสัญญา: เงินถือแทนพนักงาน (เงินสดเข้า/ออก แต่ไม่แตะกำไร)
    doc_fee_collected: income.doc_fee_collected,
    doc_fee_paid_out: exp.doc_fee_paid_out,
    interest_withdrawn: exp.interest_withdrawn,
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
                 AND (x.interest_paid < x.interest_due OR x.principal_paid < x.principal_due)) AS arrears_amount,
            -- จ่ายจริงของสัญญานี้ในวันนี้ (แยกสถานะ จ่ายแล้ว/บางส่วน)
            (SELECT COALESCE(SUM(p.amount_paid), 0) FROM payments p
               WHERE p.contract_id = c.id AND p.is_void = 0 AND p.paid_date = :date) AS paid_today,
            -- จ่ายฟรีของสัญญานี้ในวันนี้
            (SELECT COALESCE(SUM(f.amount), 0) FROM income_entries f
               WHERE f.contract_id = c.id AND f.is_void = 0 AND f.entry_date = :date
                 AND f.category = 'จ่ายฟรี/พักงวด') AS free_pay_today,
            -- วันนี้เป็นวันหยุดของสัญญานี้ไหม (ทั้งระบบ/โซน/สัญญา)
            (SELECT COUNT(*) FROM holidays h
               WHERE h.holiday_date = :date
                 AND (h.scope = 'all'
                      OR (h.scope = 'employee' AND h.employee_id = c.employee_id)
                      OR (h.scope = 'contract' AND h.contract_id = c.id))) AS is_holiday
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
    { category: 'ดอกเบี้ยหักก่อน', amount: s.upfront_interest_income },
    { category: 'ดอกเบี้ยรับรู้ (ปิด/รียอด)', amount: s.recognized_interest_income },
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

/**
 * ปิดยอดพนักงานประจำวัน (สเปกข้อ 32) — แต่ละคน/โซนแยกกัน แล้วเจ้าของดูรวมได้
 *
 * ต่อพนักงานหนึ่งคนในวันนั้น:
 *   นำส่งกิจการ  = เงินรับชำระ + จ่ายฟรี (เงินสดที่พนักงานเก็บจากลูกหนี้จริง)
 *   กิจการต้องจ่าย = ค่าแรงตามอัตรา + ค่าน้ำมันตามอัตรา (รายวัน) + ค่าทำสัญญาที่เกิดวันนั้น
 *   ยอดสุทธิ     = นำส่ง − ต้องจ่าย
 */
export async function employeeDayClose(date, employeeId = null) {
  const employees = await all(
    `SELECT * FROM employees WHERE is_active = 1
     ${employeeId ? 'AND id = :emp' : ''} ORDER BY code`,
    { emp: employeeId },
  );

  const rows = [];
  for (const e of employees) {
    const [pay, freePay, docFee, expensesPaid, due] = await Promise.all([
      get(
        `SELECT
           COALESCE(SUM(p.amount_paid), 0) AS cash,
           COALESCE(SUM(CASE WHEN c.type = 'floating' THEN p.interest_amount ELSE 0 END), 0) AS floating_interest,
           COALESCE(SUM(CASE WHEN c.type = 'floating' THEN p.principal_amount ELSE 0 END), 0) AS principal_cut,
           COUNT(DISTINCT CASE WHEN p.amount_paid > 0 THEN p.contract_id END) AS contracts_paid
         FROM payments p JOIN contracts c ON c.id = p.contract_id
         WHERE p.is_void = 0 AND p.paid_date = :d AND c.employee_id = :emp`,
        { d: date, emp: e.id },
      ),
      get(
        `SELECT COALESCE(SUM(i.amount), 0) AS v, COUNT(*) AS n
         FROM income_entries i JOIN contracts c ON c.id = i.contract_id
         WHERE i.is_void = 0 AND i.entry_date = :d AND i.category = 'จ่ายฟรี/พักงวด'
           AND c.employee_id = :emp`,
        { d: date, emp: e.id },
      ),
      get(
        `SELECT COALESCE(SUM(i.amount), 0) AS v
         FROM income_entries i JOIN contracts c ON c.id = i.contract_id
         WHERE i.is_void = 0 AND i.entry_date = :d AND i.category = 'doc_fee'
           AND COALESCE(c.opened_by_employee_id, c.employee_id) = :emp`,
        { d: date, emp: e.id },
      ),
      get(
        `SELECT
           COALESCE(SUM(CASE WHEN x.category = 'เงินเดือน/ค่าแรง' THEN x.amount ELSE 0 END), 0) AS wage_paid,
           COALESCE(SUM(CASE WHEN x.category = 'ค่าน้ำมัน' THEN x.amount ELSE 0 END), 0) AS fuel_paid
         FROM expenses x
         WHERE x.is_void = 0 AND x.entry_date = :d AND x.employee_id = :emp`,
        { d: date, emp: e.id },
      ),
      get(
        `SELECT COUNT(*) AS due_count,
                COALESCE(SUM(i.due_amount - i.interest_paid - i.principal_paid), 0) AS expected
         FROM installments i JOIN contracts c ON c.id = i.contract_id
         WHERE i.due_date = :d AND c.status = 'active' AND c.employee_id = :emp
           AND (i.interest_paid < i.interest_due OR i.principal_paid < i.principal_due)`,
        { d: date, emp: e.id },
      ),
    ]);

    // อัตรารายวันที่ตั้งไว้ (รายเดือนไม่คิดเข้ายอดวัน — จ่ายตามรอบของมันเอง)
    const wageDue = e.wage_period === 'daily' ? Number(e.wage_amount) : 0;
    const fuelDue = e.fuel_period === 'daily' ? Number(e.fuel_amount) : 0;

    const handIn = Number(pay.cash) + Number(freePay.v);
    const owedToEmployee = wageDue + fuelDue + Number(docFee.v);
    rows.push({
      employee: { id: e.id, code: e.code, full_name: e.full_name, area: e.area },
      due_count: Number(due.due_count),
      expected: Number(due.expected),
      contracts_paid: Number(pay.contracts_paid),
      cash_collected: Number(pay.cash),
      floating_interest: Number(pay.floating_interest),
      principal_cut: Number(pay.principal_cut),
      free_pay: Number(freePay.v),
      free_pay_count: Number(freePay.n),
      doc_fee_today: Number(docFee.v),
      wage_due: wageDue,
      fuel_due: fuelDue,
      wage_paid: Number(expensesPaid.wage_paid),
      fuel_paid: Number(expensesPaid.fuel_paid),
      hand_in: handIn,
      owed_to_employee: owedToEmployee,
      net: handIn - owedToEmployee,
    });
  }

  // แถวรวมทุกโซน (ข้อ 32: Admin ดูยอดรวม A + B ได้)
  const total = rows.reduce(
    (t, r) => ({
      due_count: t.due_count + r.due_count,
      expected: t.expected + r.expected,
      contracts_paid: t.contracts_paid + r.contracts_paid,
      cash_collected: t.cash_collected + r.cash_collected,
      floating_interest: t.floating_interest + r.floating_interest,
      principal_cut: t.principal_cut + r.principal_cut,
      free_pay: t.free_pay + r.free_pay,
      doc_fee_today: t.doc_fee_today + r.doc_fee_today,
      wage_due: t.wage_due + r.wage_due,
      fuel_due: t.fuel_due + r.fuel_due,
      hand_in: t.hand_in + r.hand_in,
      owed_to_employee: t.owed_to_employee + r.owed_to_employee,
      net: t.net + r.net,
    }),
    { due_count: 0, expected: 0, contracts_paid: 0, cash_collected: 0, floating_interest: 0,
      principal_cut: 0, free_pay: 0, doc_fee_today: 0, wage_due: 0, fuel_due: 0,
      hand_in: 0, owed_to_employee: 0, net: 0 },
  );

  return { date, rows, total };
}

/**
 * รายงานรายการเงินแยกประเภทที่สเปกข้อ 44 ต้องการเพิ่ม:
 * จ่ายฟรีสะสม, ตัดต้น(ดอกลอย), ถอนดอกเบี้ย/ดอกลอย, ค่าทำสัญญา
 * รวมยอดในช่วงเวลา + รายการล่าสุด กรองตามโซนได้
 */
export async function moneyBreakdownReport({ from, to, employeeId = null }) {
  const empInc = employeeId
    ? 'AND EXISTS (SELECT 1 FROM contracts c WHERE c.id = i.contract_id AND c.employee_id = :emp)'
    : '';
  const empPayJoin = employeeId ? 'AND c.employee_id = :emp' : '';
  const empExp = employeeId ? 'AND x.employee_id = :emp' : '';
  const params = { from, to, emp: employeeId };

  const [freePay, principalCut, withdrawals, docFees] = await Promise.all([
    // จ่ายฟรีสะสม (สเปกข้อ 22 — รายงานภาพรวม)
    get(
      `SELECT COALESCE(SUM(i.amount), 0) AS total, COUNT(*) AS n
       FROM income_entries i
       WHERE i.is_void = 0 AND i.category = 'จ่ายฟรี/พักงวด'
         AND i.entry_date BETWEEN :from AND :to ${empInc}`,
      params,
    ),
    // ตัดต้น (เงินต้นที่รับคืน แยกดอกลอยกับสัญญาปกติ)
    get(
      `SELECT
         COALESCE(SUM(CASE WHEN c.type = 'floating' THEN p.principal_amount ELSE 0 END), 0) AS floating_cut,
         COALESCE(SUM(CASE WHEN c.type <> 'floating' THEN p.principal_amount ELSE 0 END), 0) AS normal_cut
       FROM payments p JOIN contracts c ON c.id = p.contract_id
       WHERE p.is_void = 0 AND p.paid_date BETWEEN :from AND :to ${empPayJoin}`,
      params,
    ),
    // ถอนดอกเบี้ย/ดอกลอย
    get(
      `SELECT
         COALESCE(SUM(CASE WHEN x.category = 'ถอนดอกเบี้ยออกใช้' THEN x.amount ELSE 0 END), 0) AS interest,
         COALESCE(SUM(CASE WHEN x.category = 'ถอนรายได้ดอกลอยออกใช้' THEN x.amount ELSE 0 END), 0) AS floating
       FROM expenses x
       WHERE x.is_void = 0 AND x.entry_date BETWEEN :from AND :to ${empExp}`,
      params,
    ),
    // ค่าทำสัญญา (รับแทน/จ่ายให้พนักงาน)
    get(
      `SELECT
         (SELECT COALESCE(SUM(i.amount),0) FROM income_entries i
            WHERE i.is_void = 0 AND i.category = 'doc_fee'
              AND i.entry_date BETWEEN :from AND :to ${empInc}) AS collected,
         (SELECT COALESCE(SUM(x.amount),0) FROM expenses x
            WHERE x.is_void = 0 AND x.category = 'จ่ายค่าทำสัญญาให้พนักงาน'
              AND x.entry_date BETWEEN :from AND :to ${empExp}) AS paid_out`,
      params,
    ),
  ]);

  return {
    from, to,
    free_pay: { total: Number(freePay.total), count: Number(freePay.n) },
    principal_cut: {
      floating: Number(principalCut.floating_cut),
      normal: Number(principalCut.normal_cut),
    },
    withdrawals: { interest: Number(withdrawals.interest), floating: Number(withdrawals.floating) },
    doc_fee: { collected: Number(docFees.collected), paid_out: Number(docFees.paid_out) },
  };
}
