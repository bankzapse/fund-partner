// ตรรกะยืนยันตัวตนสองชั้น (2FA) — ต่อยอดจาก src/lib/totp.js เข้ากับฐานข้อมูลผู้ใช้
import { get, run } from '../db/index.js';
import { nowISO } from './time.js';
import {
  generateSecret,
  otpauthUri,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from './totp.js';

/**
 * เริ่มตั้งค่า 2FA — สร้าง secret ชั่วคราว (pending) ยังไม่เปิดใช้จนกว่าจะยืนยันรหัสถูก
 * เก็บเป็น pending แยกจากของจริง เพื่อไม่ให้ทับ 2FA ที่ใช้อยู่ถ้าตั้งใหม่ระหว่างทาง
 */
export async function setup2FA(userId, username) {
  const secret = generateSecret();
  await run(`UPDATE users SET totp_pending = :s, updated_at = :now WHERE id = :id`, {
    s: secret,
    now: nowISO(),
    id: userId,
  });
  return { secret, otpauth_uri: otpauthUri({ secret, label: username }) };
}

/**
 * ยืนยันและเปิดใช้ 2FA — ตรวจรหัสจากแอปกับ secret ชั่วคราว ถ้าถูกจึงเปิดใช้จริง
 * คืนรหัสสำรอง (ดิบ) ให้ผู้ใช้เก็บ "ครั้งเดียว" — ในฐานข้อมูลเก็บเฉพาะค่าที่แฮชแล้ว
 */
export async function enable2FA(userId, token) {
  const user = await get(`SELECT totp_pending, totp_enabled FROM users WHERE id = :id`, { id: userId });
  if (!user?.totp_pending) {
    throw Object.assign(new Error('ยังไม่ได้เริ่มตั้งค่า 2FA'), { status: 400 });
  }
  if (!verifyTotp(user.totp_pending, token)) {
    throw Object.assign(new Error('รหัสยืนยันไม่ถูกต้อง กรุณาลองใหม่'), { status: 400 });
  }
  const recovery = generateRecoveryCodes(10);
  const hashed = JSON.stringify(recovery.map(hashRecoveryCode));
  await run(
    `UPDATE users
       SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1,
           totp_recovery = :rec, updated_at = :now
     WHERE id = :id`,
    { rec: hashed, now: nowISO(), id: userId },
  );
  return { recovery_codes: recovery };
}

/** ปิด 2FA และล้างข้อมูลที่เกี่ยวข้องทั้งหมด (ผู้เรียกต้องยืนยันรหัสผ่านมาก่อน) */
export async function disable2FA(userId) {
  await run(
    `UPDATE users
       SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_recovery = NULL, updated_at = :now
     WHERE id = :id`,
    { now: nowISO(), id: userId },
  );
}

/** เจ้าของกิจการรีเซ็ต 2FA ให้พนักงานที่ทำมือถือหาย (เหมือนปิด แต่เป็นการกระทำของแอดมิน) */
export async function reset2FA(userId) {
  await disable2FA(userId);
}

/**
 * ตรวจปัจจัยที่สอง (ตอนเข้าสู่ระบบ) — รับได้ทั้งรหัสจากแอป (6 หลัก) และรหัสสำรอง
 * ถ้าเป็นรหัสสำรองและถูกต้อง จะ "ใช้แล้วทิ้ง" (ลบออกจากรายการทันที)
 * คืน { ok, usedRecovery }
 */
export async function verifySecondFactor(user, token) {
  const t = String(token ?? '').trim();
  if (!t) return { ok: false };

  // รหัสจากแอป Authenticator: ตัวเลข 6 หลัก
  if (/^\d{6}$/.test(t.replace(/\s/g, ''))) {
    return { ok: verifyTotp(user.totp_secret, t), usedRecovery: false };
  }

  // ไม่งั้นถือเป็นรหัสสำรอง — เทียบกับค่าที่แฮชไว้ ถ้าตรงให้ใช้แล้วทิ้ง
  let list = [];
  try {
    list = JSON.parse(user.totp_recovery || '[]');
  } catch {
    list = [];
  }
  const h = hashRecoveryCode(t);
  const idx = list.indexOf(h);
  if (idx === -1) return { ok: false };

  list.splice(idx, 1); // ใช้แล้วทิ้ง กันนำรหัสสำรองเดิมมาใช้ซ้ำ
  await run(`UPDATE users SET totp_recovery = :rec, updated_at = :now WHERE id = :id`, {
    rec: JSON.stringify(list),
    now: nowISO(),
    id: user.id,
  });
  return { ok: true, usedRecovery: true, remaining: list.length };
}

/** จำนวนรหัสสำรองที่เหลือ (ใช้แสดงเตือนผู้ใช้) */
export function recoveryRemaining(user) {
  try {
    return JSON.parse(user.totp_recovery || '[]').length;
  } catch {
    return 0;
  }
}
