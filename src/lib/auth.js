import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { get, run, getSettingInt } from '../db/index.js';
import { nowISO } from './time.js';
import { audit } from './audit.js';
import { assertNotLocked, recordFailure, clearFailures, purgeLoginAttempts } from './login-guard.js';
import { verifySecondFactor } from './twofactor.js';

export const COOKIE_NAME = 'fp_session';

// แฮชหลอกสำหรับเผาเวลาเมื่อไม่พบชื่อผู้ใช้ (ไม่มีรหัสผ่านใดตรงกับแฮชนี้)
const DUMMY_HASH = bcrypt.hashSync('fund-partner-timing-equalizer', 10);

// ชื่อชั้นการนับสำหรับใส่ใน Audit Log ให้เจ้าของกิจการอ่านรู้เรื่อง
// เดิมเขียนเป็น "ถ้าไม่ใช่ user ก็คือ IP" ซึ่งพอเพิ่มชั้น user_ip เข้ามา
// ทำให้ log ขึ้นว่า "ล็อก IP somchai|::1" ทั้งที่เป็นคู่ชื่อผู้ใช้กับ IP
const SCOPE_LABEL = {
  user_ip: 'ชื่อผู้ใช้+IP',
  user: 'ชื่อผู้ใช้',
  ip: 'IP',
};

// รหัสผ่านยอดฮิตที่ถูกเดาเป็นอันดับต้น ๆ — ห้ามใช้ แม้จะยาวพอ
// (ระบบนี้เก็บข้อมูลการเงินและสำเนาบัตรประชาชน จึงต้องกันรหัสที่เดาง่ายไว้ก่อน)
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', 'password', 'password1',
  'passw0rd', 'qwertyui', 'qwerty123', 'iloveyou', 'abc12345', 'admin123',
  'letmein1', 'welcome1', 'changeme', 'p@ssw0rd', '11111111', '00000000',
]);

export function hashPassword(plain) {
  const s = String(plain ?? '');
  if (s.length < 8) {
    throw Object.assign(new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'), { status: 400 });
  }
  // ตัวอักษรซ้ำตัวเดียวทั้งเส้น เช่น aaaaaaaa เดาง่ายพอ ๆ กับรหัสสั้น
  if (/^(.)\1+$/.test(s)) {
    throw Object.assign(new Error('รหัสผ่านต้องไม่ใช่ตัวอักษรเดียวซ้ำกันทั้งหมด'), { status: 400 });
  }
  if (WEAK_PASSWORDS.has(s.toLowerCase())) {
    throw Object.assign(new Error('รหัสผ่านนี้เดาง่ายเกินไป กรุณาตั้งรหัสอื่น'), { status: 400 });
  }
  return bcrypt.hashSync(s, 10); // ข้อ 15: ไม่เก็บรหัสผ่านแบบอ่านได้
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(String(plain ?? ''), hash);
}

async function expiryFromNow() {
  const minutes = (await getSettingInt('session_timeout_minutes')) || 120;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function login({ username, password, token, ip }) {
  // ต้องตรวจการล็อก "ก่อน" เช็ครหัสผ่าน ไม่งั้นผู้โจมตียังลองรหัสได้ต่อระหว่างถูกล็อก
  await assertNotLocked({ username, ip });

  const user = await get(`SELECT * FROM users WHERE username = :u`, { u: String(username ?? '').trim() });
  if (!user || !verifyPassword(password, user.password_hash)) {
    if (!user) {
      // เผาเวลาให้เท่ากับกรณีที่มีผู้ใช้จริง ไม่งั้นผู้โจมตีจับเวลาตอบกลับ
      // แล้วเดาได้ว่าชื่อผู้ใช้ไหนมีอยู่ในระบบ
      bcrypt.compareSync(String(password ?? ''), DUMMY_HASH);
    }
    const locked = await recordFailure({ username, ip });
    if (locked.length) {
      await audit({
        action: 'login_locked',
        entity: 'user',
        entityId: user?.id ?? null,
        ip,
        reason: locked.map((l) => `ล็อก ${SCOPE_LABEL[l.scope] ?? l.scope} ${l.key} เป็นเวลา ${l.minutes} นาที`).join(' · '),
      });
    }
    throw Object.assign(new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'), { status: 401 });
  }
  if (!user.is_active) {
    // บัญชีถูกปิด ไม่ใช่การเดารหัส จึงไม่นับเป็นความผิด แต่ก็ไม่ล้างตัวนับเดิมทิ้ง
    throw Object.assign(new Error('บัญชีนี้ถูกปิดการใช้งาน'), { status: 403 });
  }

  // ปัจจัยที่สอง (2FA) — รหัสผ่านถูกแล้ว แต่ถ้าเปิด 2FA ไว้ต้องผ่านรหัสยืนยันอีกชั้น
  if (user.totp_enabled) {
    const rawToken = String(token ?? '').trim();
    if (!rawToken) {
      // รหัสผ่านถูก แต่ยังขาดรหัส 2FA — ไม่นับเป็นการเข้าผิด (ไม่ recordFailure)
      // แจ้งฝั่งหน้าเว็บให้ขอรหัสยืนยันเพิ่ม
      throw Object.assign(new Error('กรุณากรอกรหัสยืนยัน 2 ชั้น'), {
        status: 401,
        twoFactorRequired: true,
      });
    }
    const { ok, usedRecovery, remaining } = await verifySecondFactor(user, rawToken);
    if (!ok) {
      // รหัส 2FA ผิด นับเป็นความพยายามเข้าผิด กันการเดารหัส 2FA แบบไล่สุ่ม
      await recordFailure({ username, ip });
      throw Object.assign(new Error('รหัสยืนยัน 2 ชั้นไม่ถูกต้อง'), {
        status: 401,
        twoFactorRequired: true,
      });
    }
    if (usedRecovery) {
      await audit({
        userId: user.id,
        action: 'login_recovery_code',
        entity: 'user',
        entityId: user.id,
        ip,
        reason: `ใช้รหัสสำรองเข้าสู่ระบบ เหลืออีก ${remaining} รหัส`,
      });
    }
  }

  await clearFailures({ username, ip });
  const sessionToken = randomBytes(32).toString('hex');
  await run(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES (:t, :uid, :now, :exp)`,
    { t: sessionToken, uid: user.id, now: nowISO(), exp: await expiryFromNow() },
  );
  await run(`UPDATE users SET last_login_at = :now WHERE id = :id`, { id: user.id, now: nowISO() });
  await audit({ userId: user.id, action: 'login', entity: 'user', entityId: user.id, ip });
  return { token: sessionToken, user: publicUser(user) };
}

export async function logout(token, ctx) {
  if (!token) return;
  await run(`DELETE FROM sessions WHERE token = :t`, { t: token });
  await audit({ userId: ctx?.user?.id, action: 'logout', entity: 'user', entityId: ctx?.user?.id });
}

/** ตรวจ session และเลื่อนเวลาหมดอายุ (Session Timeout ตามข้อ 15) */
export async function userFromToken(token) {
  if (!token) return null;
  const session = await get(`SELECT * FROM sessions WHERE token = :t`, { t: token });
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await run(`DELETE FROM sessions WHERE token = :t`, { t: token });
    return null;
  }
  const user = await get(`SELECT * FROM users WHERE id = :id`, { id: session.user_id });
  if (!user || !user.is_active) return null;
  await run(`UPDATE sessions SET expires_at = :exp WHERE token = :t`, {
    t: token,
    exp: await expiryFromNow(),
  });
  return user;
}

export function publicUser(user) {
  if (!user) return null;
  // ไม่ส่งความลับใด ๆ ออกไปฝั่งหน้าเว็บ — เก็บเฉพาะสถานะว่าเปิด 2FA ไว้หรือไม่
  const { password_hash, totp_secret, totp_pending, totp_recovery, totp_enabled, ...rest } = user;
  return { ...rest, two_factor_enabled: Boolean(totp_enabled) };
}

/** ล้าง session ที่หมดอายุ */
export async function purgeSessions() {
  await run(`DELETE FROM sessions WHERE expires_at < :now`, { now: new Date().toISOString() });
  await purgeLoginAttempts();
}
