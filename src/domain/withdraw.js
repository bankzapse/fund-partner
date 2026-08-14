// ถอนดอกเบี้ยออกมาใช้ (สเปกข้อ 33-40)
//
// หัวใจคือบัญชีสองแหล่งที่แยกกันเด็ดขาด (ข้อ 39):
//   1) ดอกเบี้ยตามสัญญา  = ดอกต่องวดที่จ่ายจริง (โหมดเดิม ไม่รวมดอกลอย)
//                          + ดอกรับรู้ตอนปิดสัญญา + ตอนรียอด + ดอกหักก่อน
//   2) รายได้ดอกลอย      = ดอกจากการชำระของสัญญาดอกลอย
//
// สูตร (ข้อ 34): คงเหลือ = รับรู้สะสม − ถอนสะสม
// ข้อ 37 ได้มาโดยอัตโนมัติ: สัญญาเหมารวมที่ยังไม่ปิด/ไม่รียอด ไม่มีรายการรับรู้
// จึงไม่ถูกนับใน "รับรู้สะสม" ตั้งแต่ต้น — ไม่มีทางถอนดอกที่ยังไม่รับรู้ได้
import {
  all, get, insert, tx,
  REYOD_INTEREST_CATEGORY,
  CLOSE_INTEREST_CATEGORY,
  UPFRONT_INTEREST_CATEGORY,
  WITHDRAW_INTEREST_CATEGORY,
  WITHDRAW_FLOATING_CATEGORY,
} from '../db/index.js';
import { assertPositive } from '../lib/money.js';
import { today, nowISO, isDateStr } from '../lib/time.js';
import { audit } from '../lib/audit.js';

export class WithdrawError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export const SOURCES = {
  contract_interest: {
    label: 'ดอกเบี้ยตามสัญญา',
    category: WITHDRAW_INTEREST_CATEGORY,
  },
  floating_interest: {
    label: 'รายได้ดอกลอย',
    category: WITHDRAW_FLOATING_CATEGORY,
  },
};

/**
 * ยอดรับรู้/ถอน/คงเหลือ ของสองแหล่ง — ทั้งกิจการ หรือกรองรายโซน (พนักงาน)
 * employeeId = null → ยอดรวมทั้งกิจการ (นับการถอนทุกใบ รวมใบที่ไม่ระบุโซน)
 */
export async function withdrawBalance(employeeId = null) {
  const empPay = employeeId ? 'AND c.employee_id = :emp' : '';
  const empInc = employeeId
    ? 'AND EXISTS (SELECT 1 FROM contracts c2 WHERE c2.id = i.contract_id AND c2.employee_id = :emp)'
    : '';
  const empExp = employeeId ? 'AND x.employee_id = :emp' : '';
  const params = {
    emp: employeeId,
    reyod: REYOD_INTEREST_CATEGORY,
    close: CLOSE_INTEREST_CATEGORY,
    upfront: UPFRONT_INTEREST_CATEGORY,
    wInt: WITHDRAW_INTEREST_CATEGORY,
    wFloat: WITHDRAW_FLOATING_CATEGORY,
  };

  const [pay, inc, wd] = await Promise.all([
    get(
      `SELECT
         COALESCE(SUM(CASE WHEN c.type <> 'floating' AND c.interest_mode = 'per_installment'
                           THEN p.interest_amount ELSE 0 END), 0) AS legacy_interest,
         COALESCE(SUM(CASE WHEN c.type = 'floating' THEN p.interest_amount ELSE 0 END), 0) AS floating_interest
       FROM payments p JOIN contracts c ON c.id = p.contract_id
       WHERE p.is_void = 0 ${empPay}`,
      params,
    ),
    get(
      `SELECT COALESCE(SUM(CASE WHEN i.category IN (:reyod, :close, :upfront) THEN i.amount ELSE 0 END), 0) AS recognized_entries
       FROM income_entries i
       WHERE i.is_void = 0 ${empInc}`,
      params,
    ),
    get(
      `SELECT
         COALESCE(SUM(CASE WHEN x.category = :wInt THEN x.amount ELSE 0 END), 0) AS withdrawn_contract,
         COALESCE(SUM(CASE WHEN x.category = :wFloat THEN x.amount ELSE 0 END), 0) AS withdrawn_floating
       FROM expenses x
       WHERE x.is_void = 0 ${empExp}`,
      params,
    ),
  ]);

  const contractRecognized = Number(pay.legacy_interest) + Number(inc.recognized_entries);
  const floatingRecognized = Number(pay.floating_interest);
  return {
    contract_interest: {
      recognized: contractRecognized,
      withdrawn: Number(wd.withdrawn_contract),
      remaining: contractRecognized - Number(wd.withdrawn_contract),
    },
    floating_interest: {
      recognized: floatingRecognized,
      withdrawn: Number(wd.withdrawn_floating),
      remaining: floatingRecognized - Number(wd.withdrawn_floating),
    },
  };
}

/** ยอดคงเหลือรายโซน (พนักงาน) + ยอดรวม — สำหรับหน้าจอเลือกดู (ข้อ 36) */
export async function withdrawOverview() {
  const employees = await all(
    `SELECT id, code, full_name FROM employees WHERE is_active = 1 ORDER BY code`,
  );
  const zones = [];
  for (const e of employees) {
    zones.push({ employee: e, balance: await withdrawBalance(e.id) });
  }
  return { total: await withdrawBalance(null), zones };
}

/** ประวัติการถอน (รวมใบที่ยกเลิกเพื่อดูย้อนหลังตามข้อ 40) */
export async function withdrawHistory(limit = 100) {
  return await all(
    `SELECT x.*, e.full_name AS employee_name, e.code AS employee_code,
            u.full_name AS created_by_name, pb.full_name AS withdrawn_by_name
     FROM expenses x
     LEFT JOIN employees e ON e.id = x.employee_id
     LEFT JOIN users u ON u.id = x.created_by
     LEFT JOIN users pb ON pb.id = x.paid_by
     WHERE x.category IN (:wInt, :wFloat)
     ORDER BY x.id DESC LIMIT :limit`,
    { wInt: WITHDRAW_INTEREST_CATEGORY, wFloat: WITHDRAW_FLOATING_CATEGORY, limit },
  );
}

/**
 * บันทึกการถอน (ข้อ 35: วันที่ จำนวน ผู้ถอน โซน แหล่งเงิน วิธีรับ หมายเหตุ ผู้บันทึก)
 *
 * เพดาน (ข้อ 38): ห้ามถอนเกินคงเหลือของแหล่ง+ขอบเขตที่เลือก
 *   - ระบุโซน  → เช็คกับคงเหลือของโซนนั้น
 *   - ไม่ระบุ  → เช็คกับคงเหลือรวมทั้งกิจการ
 * เจ้าของ override ได้เมื่อให้เหตุผล (บันทึกลง audit เป็นรายการปรับปรุงพิเศษ)
 */
export async function recordWithdrawal(
  { source, amount, withdrawDate, employeeId = null, method, note, ownerOverride = false, reason },
  ctx,
) {
  return await tx(async () => {
    const src = SOURCES[source];
    if (!src) throw new WithdrawError('แหล่งเงินไม่ถูกต้อง (ดอกเบี้ยตามสัญญา หรือ รายได้ดอกลอย)');
    const amt = assertPositive(amount, 'จำนวนเงินที่ถอน');
    const date = withdrawDate || today();
    if (!isDateStr(date)) throw new WithdrawError('วันที่ถอนไม่ถูกต้อง');

    if (employeeId) {
      const emp = await get(`SELECT id FROM employees WHERE id = :id`, { id: employeeId });
      if (!emp) throw new WithdrawError('ไม่พบพนักงาน/โซนที่ระบุ');
    }

    const closing = await get(`SELECT 1 AS x FROM daily_closings WHERE closing_date = :d`, { d: date });
    if (closing && ctx?.user?.role !== 'owner') {
      throw new WithdrawError(`วันที่ ${date} ปิดยอดประจำวันแล้ว ต้องให้เจ้าของเป็นผู้บันทึก`);
    }

    const balance = (await withdrawBalance(employeeId ?? null))[source];
    if (amt > balance.remaining) {
      const scope = employeeId ? 'ของโซนที่เลือก' : 'ทั้งกิจการ';
      // ข้อ 38: เจ้าของใช้รายการปรับปรุงพิเศษได้ แต่ต้องมีเหตุผลกำกับ
      const canOverride = ownerOverride === true && ctx?.user?.role === 'owner';
      if (!canOverride || !String(reason ?? '').trim()) {
        throw new WithdrawError(
          `ยอดถอนมากกว่า${src.label}คงเหลือ${scope} ` +
            `(คงเหลือ ${(balance.remaining / 100).toFixed(2)} บาท) — ` +
            'เจ้าของบันทึกเกินได้เฉพาะรายการปรับปรุงพิเศษพร้อมเหตุผล',
        );
      }
    }

    const now = nowISO();
    const methodLabel = method === 'transfer' ? 'โอน' : 'เงินสด';
    const descParts = [`วิธีรับเงิน: ${methodLabel}`];
    if (note?.trim()) descParts.push(note.trim());
    if (amt > balance.remaining) descParts.push(`ปรับปรุงพิเศษ: ${String(reason).trim()}`);

    const id = await insert(
      `INSERT INTO expenses (entry_date, category, amount, description, paid_by, employee_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :paidBy, :emp, :uid, :now)`,
      {
        d: date,
        cat: src.category,
        amt,
        desc: descParts.join(' · '),
        paidBy: ctx?.user?.id ?? null, // ผู้ถอน (คนรับเงินไป)
        emp: employeeId ?? null,       // โซนที่ถอนจาก (ไม่ระบุ = ถอนจากยอดรวม)
        uid: ctx?.user?.id ?? null,    // ผู้บันทึกรายการ
        now,
      },
    );
    const entry = await get(`SELECT * FROM expenses WHERE id = :id`, { id });
    await audit({
      userId: ctx?.user?.id,
      action: 'create',
      entity: 'interest_withdrawal',
      entityId: id,
      after: entry,
      reason: amt > balance.remaining ? `ปรับปรุงพิเศษ: ${reason}` : (reason ?? null),
      ip: ctx?.ip,
    });
    return entry;
  });
}
