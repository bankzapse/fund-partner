import { requireCap, scopedToOwn } from '../lib/permissions.js';
import { get } from '../db/index.js';
export { saveDataUrl } from '../lib/storage.js';

/** ครอบ handler ให้ error ถูกส่งต่อไปยัง error middleware */
export const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** ต้องมีสิทธิ์ตามตารางข้อ 12 */
export const need = (capability) => (req, _res, next) => {
  requireCap(req.ctx.user, capability);
  next();
};

/**
 * รหัสพนักงานที่ผูกกับผู้ใช้ปัจจุบัน — ใช้จำกัดขอบเขตข้อมูล
 * (ข้อ 12: พนักงานเก็บเงินเห็นเฉพาะลูกหนี้ที่ได้รับมอบหมาย)
 */
export async function ownEmployeeId(user) {
  const row = await get(`SELECT id FROM employees WHERE user_id = :uid`, { uid: user.id });
  return row?.id ?? -1; // -1 = ไม่ผูกกับพนักงานคนใด จึงไม่เห็นข้อมูลใคร
}

/**
 * คืนค่า employee_id ที่ต้องใช้กรอง หรือ null ถ้าเห็นข้อมูลได้ทั้งหมด
 *
 * ขอบเขตการมองเห็นข้อมูลยึดจาก debtors_view เสมอ และเข้มขึ้นได้ตามความสามารถที่ระบุ
 * แยกจาก "สิทธิ์ทำรายการ" โดยเด็ดขาด เพราะพนักงานเก็บเงินมีสิทธิ์ "รับชำระ" เต็ม
 * แต่ต้องทำได้เฉพาะกับลูกหนี้ที่ตนดูแลเท่านั้น (SRS ข้อ 12)
 * ถ้าเอาสิทธิ์ทำรายการมาตัดสินขอบเขต จะกลายเป็นเห็นและแตะข้อมูลของคนอื่นได้
 */
export async function scopeEmployeeId(user, capability = null) {
  const restricted =
    scopedToOwn(user, 'debtors_view') || (capability ? scopedToOwn(user, capability) : false);
  return restricted ? await ownEmployeeId(user) : null;
}

/** ตรวจว่าผู้ใช้มีสิทธิ์เข้าถึงลูกหนี้รายนี้ */
export async function assertDebtorAccess(user, debtorId, capability = null) {
  const scope = await scopeEmployeeId(user, capability);
  if (scope === null) return;
  const row = await get(`SELECT employee_id FROM debtors WHERE id = :id`, { id: debtorId });
  if (!row || row.employee_id !== scope) {
    throw Object.assign(new Error('คุณไม่มีสิทธิ์เข้าถึงข้อมูลลูกหนี้รายนี้'), { status: 403 });
  }
}

/** แปลงพารามิเตอร์ตัวเลขอย่างปลอดภัย */
export function intParam(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** สร้างไฟล์ CSV ที่ Excel ภาษาไทยเปิดได้ (มี BOM) — SRS ข้อ 16 */
export function sendCsv(res, filename, rows, headers) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const head = headers.map((h) => esc(h.label)).join(',');
  const body = rows
    .map((r) => headers.map((h) => esc(typeof h.value === 'function' ? h.value(r) : r[h.key])).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + head + '\n' + body);
}
