// ค่าทำสัญญาของพนักงานผู้เปิดสัญญา (สเปกข้อ 21, 29)
//
// เงินค่าทำสัญญาที่หักจากลูกค้าตอนเปิดสัญญาเป็น "ของพนักงานผู้เปิดสัญญา"
// กิจการแค่ถือเงินไว้แทน — โมดูลนี้ตอบ 3 คำถามของสเปก:
//   รับแล้วหรือยัง   → รายการ doc_fee ใน income_entries (หักจริงเท่าไรบันทึกเท่านั้น)
//   จ่ายแล้วหรือยัง  → รายการจ่ายในหมวด DOC_FEE_PAYOUT_CATEGORY (expenses)
//   ค้างจ่ายเท่าไร   → รับแทนสะสม − จ่ายแล้วสะสม (ต่อพนักงาน)
import { all, get, insert, tx, DOC_FEE_PAYOUT_CATEGORY } from '../db/index.js';
import { assertPositive } from '../lib/money.js';
import { today, nowISO, isDateStr } from '../lib/time.js';
import { audit } from '../lib/audit.js';

export class DocFeeError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * ยอดค่าทำสัญญาต่อพนักงาน: รับแทนสะสม / จ่ายแล้วสะสม / ค้างจ่าย
 *
 * เจ้าของค่าทำสัญญา = พนักงานผู้เปิดสัญญา (opened_by_employee_id)
 * สัญญาเก่าที่สร้างก่อนมีคอลัมน์นี้ (NULL) ใช้พนักงานผู้ดูแล (employee_id) แทน
 */
export async function docFeeBalances() {
  return await all(
    `SELECT e.id AS employee_id, e.code, e.full_name,
       COALESCE((
         SELECT SUM(i.amount) FROM income_entries i
         JOIN contracts c ON c.id = i.contract_id
         WHERE i.category = 'doc_fee' AND i.is_void = 0
           AND COALESCE(c.opened_by_employee_id, c.employee_id) = e.id
       ), 0) AS collected,
       COALESCE((
         SELECT SUM(x.amount) FROM expenses x
         WHERE x.category = :payout AND x.is_void = 0 AND x.employee_id = e.id
       ), 0) AS paid_out
     FROM employees e
     WHERE e.is_active = 1
     ORDER BY e.code`,
    { payout: DOC_FEE_PAYOUT_CATEGORY },
  ).then((rows) =>
    rows.map((r) => ({
      ...r,
      collected: Number(r.collected),
      paid_out: Number(r.paid_out),
      owed: Number(r.collected) - Number(r.paid_out),
    })),
  );
}

/** รายละเอียดของพนักงานหนึ่งคน: สัญญาที่มีค่าทำสัญญา + ประวัติการจ่าย */
export async function docFeeDetail(employeeId) {
  const [contracts, payouts] = await Promise.all([
    all(
      `SELECT c.id, c.contract_no, c.start_date, d.full_name AS debtor_name, i.amount
       FROM income_entries i
       JOIN contracts c ON c.id = i.contract_id
       JOIN debtors d ON d.id = c.debtor_id
       WHERE i.category = 'doc_fee' AND i.is_void = 0
         AND COALESCE(c.opened_by_employee_id, c.employee_id) = :emp
       ORDER BY c.id DESC LIMIT 100`,
      { emp: employeeId },
    ),
    all(
      `SELECT x.id, x.entry_date, x.amount, x.description, x.is_void
       FROM expenses x
       WHERE x.category = :payout AND x.employee_id = :emp
       ORDER BY x.id DESC LIMIT 50`,
      { payout: DOC_FEE_PAYOUT_CATEGORY, emp: employeeId },
    ),
  ]);
  return { contracts, payouts };
}

/**
 * จ่ายค่าทำสัญญาค้างจ่ายให้พนักงาน — เงินสดออกจริง แต่ไม่ใช่ค่าใช้จ่ายดำเนินงาน
 * ห้ามจ่ายเกินยอดค้าง (กันเงินกิจการรั่วผ่านช่องนี้)
 */
export async function recordDocFeePayout({ employeeId, amount, payoutDate, note }, ctx) {
  return await tx(async () => {
    const emp = await get(`SELECT * FROM employees WHERE id = :id`, { id: employeeId });
    if (!emp) throw new DocFeeError('ไม่พบพนักงาน');
    const amt = assertPositive(amount, 'จำนวนเงินที่จ่าย');
    const date = payoutDate || today();
    if (!isDateStr(date)) throw new DocFeeError('วันที่จ่ายไม่ถูกต้อง');

    // ห้ามจ่ายวันที่ปิดยอดแล้ว (กติกาเดียวกับรายการเงินอื่น ๆ)
    const closing = await get(`SELECT 1 AS x FROM daily_closings WHERE closing_date = :d`, { d: date });
    if (closing && ctx?.user?.role !== 'owner') {
      throw new DocFeeError(`วันที่ ${date} ปิดยอดประจำวันแล้ว ต้องให้เจ้าของเป็นผู้บันทึก`);
    }

    const balances = await docFeeBalances();
    const mine = balances.find((b) => b.employee_id === employeeId);
    const owed = mine?.owed ?? 0;
    if (amt > owed) {
      throw new DocFeeError(
        `ยอดจ่าย (${(amt / 100).toFixed(2)} บาท) มากกว่าค่าทำสัญญาค้างจ่ายของ ${emp.full_name} ` +
          `(${(owed / 100).toFixed(2)} บาท)`,
      );
    }

    const now = nowISO();
    const id = await insert(
      `INSERT INTO expenses (entry_date, category, amount, description, employee_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :emp, :uid, :now)`,
      {
        d: date,
        cat: DOC_FEE_PAYOUT_CATEGORY,
        amt,
        desc: note?.trim() || `จ่ายค่าทำสัญญาค้างจ่ายให้ ${emp.full_name} (${emp.code})`,
        emp: employeeId,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );
    const entry = await get(`SELECT * FROM expenses WHERE id = :id`, { id });
    await audit({
      userId: ctx?.user?.id,
      action: 'create',
      entity: 'doc_fee_payout',
      entityId: id,
      after: entry,
      ip: ctx?.ip,
    });
    return entry;
  });
}
