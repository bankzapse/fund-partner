import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { requireCap, scopedToOwn } from '../lib/permissions.js';
import { get } from '../db/index.js';
import { UPLOAD_DIR } from '../lib/paths.js';

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
export function ownEmployeeId(user) {
  const row = get(`SELECT id FROM employees WHERE user_id = :uid`, { uid: user.id });
  return row?.id ?? -1; // -1 = ไม่ผูกกับพนักงานคนใด จึงไม่เห็นข้อมูลใคร
}

/** คืนค่า employee_id ที่ต้องใช้กรอง หรือ null ถ้าเห็นได้ทั้งหมด */
export function scopeEmployeeId(user, capability = 'debtors_view') {
  return scopedToOwn(user, capability) ? ownEmployeeId(user) : null;
}

/** ตรวจว่าผู้ใช้มีสิทธิ์เข้าถึงลูกหนี้รายนี้ */
export function assertDebtorAccess(user, debtorId, capability = 'debtors_view') {
  const scope = scopeEmployeeId(user, capability);
  if (scope === null) return;
  const row = get(`SELECT employee_id FROM debtors WHERE id = :id`, { id: debtorId });
  if (!row || row.employee_id !== scope) {
    throw Object.assign(new Error('คุณไม่มีสิทธิ์เข้าถึงข้อมูลลูกหนี้รายนี้'), { status: 403 });
  }
}

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

/**
 * บันทึกไฟล์แนบที่ส่งมาแบบ data URL (รูปบัตร ใบเสร็จ หลักฐานการรับเงิน)
 * คืนค่า path สาธารณะ เช่น /uploads/xxxx.jpg
 */
export function saveDataUrl(dataUrl, prefix = 'file') {
  if (!dataUrl) return null;
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl));
  if (!m) throw Object.assign(new Error('รูปแบบไฟล์แนบไม่ถูกต้อง'), { status: 400 });
  const [, mime, b64] = m;
  if (!ALLOWED_MIME.has(mime)) {
    throw Object.assign(new Error('รองรับเฉพาะไฟล์ JPG, PNG, WEBP, HEIC และ PDF'), {
      status: 400,
    });
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('ไฟล์ใหญ่เกิน 8 MB'), { status: 400 });
  }
  const name = `${prefix}-${Date.now()}-${randomBytes(6).toString('hex')}.${EXT[mime]}`;
  writeFileSync(join(UPLOAD_DIR, name), buf);
  return { path: `/uploads/${name}`, mime, size: buf.length };
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
