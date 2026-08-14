// ระบบวันหยุดส่ง (สเปกข้อ 23)
//
// ในวันหยุด: ไม่ต้องส่ง ไม่สร้างงวด ไม่ถือว่าขาดส่ง ไม่ขึ้นค้าง และเลื่อนกำหนดงวดออกไป
// ตั้งได้ 3 ขอบเขต: ทั้งระบบ / เฉพาะโซน (พนักงาน) / เฉพาะสัญญา
//
// กลไก "ไม่ขึ้นค้าง" ได้มาจากการเลื่อนตารางงวดจริง ๆ:
//   - ตอนสร้างสัญญาใหม่: ตารางงวดข้ามวันหยุดที่ประกาศไว้แล้ว (ดู scheduleFor)
//   - ตอนประกาศวันหยุดใหม่: งวดค้างของสัญญาที่เปิดอยู่ถูกเลื่อนออกไปทันที
//     (รายวัน: เลื่อนทุกงวดตั้งแต่วันหยุดขึ้นไป +1 วัน — ตารางยังเรียงต่อเนื่อง
//      รายเดือน/ดอกลอย: เลื่อนเฉพาะงวดที่ตรงวันหยุด +1 วัน)
// จึงไม่มีงวดไหนครบกำหนดตรงวันหยุด → dueToday/ยอดค้างไม่นับวันหยุดโดยอัตโนมัติ
import { all, get, run, insert, tx } from '../db/index.js';
import { today, nowISO, isDateStr } from '../lib/time.js';
import { audit } from '../lib/audit.js';

export class HolidayError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export async function listHolidays() {
  return await all(
    `SELECT h.*, e.full_name AS employee_name, e.code AS employee_code, c.contract_no
     FROM holidays h
     LEFT JOIN employees e ON e.id = h.employee_id
     LEFT JOIN contracts c ON c.id = h.contract_id
     ORDER BY h.holiday_date DESC, h.id DESC
     LIMIT 200`,
  );
}

/**
 * เซตวันหยุดที่มีผลกับสัญญาที่กำลังจะสร้าง (ทั้งระบบ + โซนของพนักงาน)
 * ใช้ตอนสร้างตารางงวด — วันหยุดเฉพาะสัญญายังไม่มีทางมีอยู่ก่อนสัญญาเกิด
 */
export async function holidayDatesFor({ employeeId = null, fromDate = null } = {}) {
  const rows = await all(
    `SELECT holiday_date FROM holidays
     WHERE (scope = 'all' OR (scope = 'employee' AND employee_id = :emp))
       ${fromDate ? 'AND holiday_date >= :from' : ''}`,
    { emp: employeeId, from: fromDate },
  );
  return new Set(rows.map((r) => r.holiday_date));
}

/** วันหยุดที่มีผลกับสัญญาหนึ่ง ณ วันหนึ่ง (ใช้แสดงสถานะ "วันหยุด" ในหน้าเก็บเงิน) */
export async function holidayOn(date, { employeeId = null, contractId = null } = {}) {
  return await get(
    `SELECT * FROM holidays
     WHERE holiday_date = :d
       AND (scope = 'all'
            OR (scope = 'employee' AND employee_id = :emp)
            OR (scope = 'contract' AND contract_id = :cid))
     LIMIT 1`,
    { d: date, emp: employeeId, cid: contractId },
  );
}

/**
 * ประกาศวันหยุด + เลื่อนงวดค้างของสัญญาที่อยู่ในขอบเขตทันที
 * วันหยุดหลายวันติดกัน (เช่น สงกรานต์) = ประกาศทีละวัน แต่ละวันเลื่อนสะสม +1
 */
export async function addHoliday({ holidayDate, scope = 'all', employeeId = null, contractId = null, name }, ctx) {
  return await tx(async () => {
    if (!isDateStr(holidayDate)) throw new HolidayError('วันที่ไม่ถูกต้อง');
    if (!name?.trim()) throw new HolidayError('ต้องระบุชื่อวันหยุด');
    if (!['all', 'employee', 'contract'].includes(scope)) throw new HolidayError('ขอบเขตไม่ถูกต้อง');
    if (scope === 'employee') {
      if (!employeeId || !(await get(`SELECT id FROM employees WHERE id = :id`, { id: employeeId }))) {
        throw new HolidayError('ต้องเลือกพนักงาน/โซนสำหรับวันหยุดเฉพาะโซน');
      }
      contractId = null;
    } else if (scope === 'contract') {
      if (!contractId || !(await get(`SELECT id FROM contracts WHERE id = :id`, { id: contractId }))) {
        throw new HolidayError('ต้องระบุสัญญาสำหรับวันหยุดเฉพาะสัญญา');
      }
      employeeId = null;
    } else {
      employeeId = null;
      contractId = null;
    }

    // กันประกาศซ้ำขอบเขตเดิมวันเดิม — ไม่งั้นงวดโดนเลื่อนสองรอบ
    const dup = await get(
      `SELECT id FROM holidays
       WHERE holiday_date = :d AND scope = :s
         AND employee_id IS NOT DISTINCT FROM :emp
         AND contract_id IS NOT DISTINCT FROM :cid`,
      { d: holidayDate, s: scope, emp: employeeId, cid: contractId },
    );
    if (dup) throw new HolidayError('วันหยุดนี้ถูกประกาศไว้แล้วในขอบเขตเดียวกัน');

    const now = nowISO();
    const id = await insert(
      `INSERT INTO holidays (holiday_date, scope, employee_id, contract_id, name, created_by, created_at)
       VALUES (:d, :s, :emp, :cid, :name, :uid, :now)`,
      { d: holidayDate, s: scope, emp: employeeId, cid: contractId, name: name.trim(), uid: ctx?.user?.id ?? null, now },
    );

    const scopeCond =
      scope === 'all' ? '1=1'
      : scope === 'employee' ? 'c.employee_id = :emp'
      : 'c.id = :cid';

    // นับก่อนอัปเดต — PGlite ไม่คืน rowCount ที่เชื่อถือได้สำหรับ UPDATE ที่มี subquery
    // (ตัว UPDATE ทำงานถูกต้อง แต่ตัวเลขที่คืนอาจเป็น 0) จึงนับด้วย SELECT แยก
    const dailyWhere =
      `(interest_paid < interest_due OR principal_paid < principal_due) AND due_date >= :d
       AND contract_id IN (SELECT c.id FROM contracts c
         WHERE c.status = 'active' AND c.period_unit = 'day' AND ${scopeCond})`;
    const monthlyWhere =
      `(interest_paid < interest_due OR principal_paid < principal_due) AND due_date = :d
       AND contract_id IN (SELECT c.id FROM contracts c
         WHERE c.status = 'active' AND c.period_unit = 'month' AND ${scopeCond})`;
    const params = { d: holidayDate, emp: employeeId, cid: contractId };

    const dailyCount = Number((await get(`SELECT COUNT(*)::int AS n FROM installments WHERE ${dailyWhere}`, params)).n);
    const monthlyCount = Number((await get(`SELECT COUNT(*)::int AS n FROM installments WHERE ${monthlyWhere}`, params)).n);

    // รายวัน: เลื่อนทุกงวดค้างตั้งแต่วันหยุดขึ้นไป +1 วัน (ตารางเลื่อนทั้งแผง ไม่ชนกันเอง)
    await run(`UPDATE installments SET due_date = (due_date::date + 1)::text WHERE ${dailyWhere}`, params);
    // รายเดือน/ดอกลอย: เลื่อนเฉพาะงวดที่ตรงวันหยุดพอดี +1 วัน
    await run(`UPDATE installments SET due_date = (due_date::date + 1)::text WHERE ${monthlyWhere}`, params);
    const daily = { rowCount: dailyCount };
    const monthly = { rowCount: monthlyCount };

    const holiday = await get(`SELECT * FROM holidays WHERE id = :id`, { id });
    await audit({
      userId: ctx?.user?.id,
      action: 'create',
      entity: 'holiday',
      entityId: id,
      after: holiday,
      reason: `เลื่อนงวดค้าง: รายวัน ${daily.rowCount} งวด, รายเดือน ${monthly.rowCount} งวด`,
      ip: ctx?.ip,
    });
    return { holiday, shifted_daily: daily.rowCount, shifted_monthly: monthly.rowCount };
  });
}

/**
 * ลบประกาศวันหยุด (มี audit) — ตารางงวดที่ถูกเลื่อนไปแล้ว "ไม่" เลื่อนกลับ
 * เพราะพนักงานอาจนัดลูกค้าตามกำหนดใหม่ไปแล้ว การดึงกลับจะสร้างความสับสนหน้างาน
 */
export async function removeHoliday(id, ctx) {
  const before = await get(`SELECT * FROM holidays WHERE id = :id`, { id });
  if (!before) throw new HolidayError('ไม่พบวันหยุดนี้');
  await run(`DELETE FROM holidays WHERE id = :id`, { id });
  await audit({
    userId: ctx?.user?.id,
    action: 'delete',
    entity: 'holiday',
    entityId: id,
    before,
    reason: 'ลบประกาศวันหยุด (ตารางงวดที่เลื่อนแล้วคงเดิม)',
    ip: ctx?.ip,
  });
  return before;
}

/** วันหยุดที่มีผลของ "วันนี้" สำหรับหน้าเก็บเงิน (เช็คเป็นชุดทีเดียว) */
export async function holidaysOnDate(date) {
  return await all(`SELECT * FROM holidays WHERE holiday_date = :d`, { d: date });
}

export { today };
