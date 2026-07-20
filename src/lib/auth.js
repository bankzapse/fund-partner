import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { get, run, insert, getSettingInt } from '../db/index.js';
import { nowISO } from './time.js';
import { audit } from './audit.js';

export const COOKIE_NAME = 'fp_session';

export function hashPassword(plain) {
  if (!plain || String(plain).length < 6) {
    throw Object.assign(new Error('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร'), { status: 400 });
  }
  return bcrypt.hashSync(String(plain), 10); // ข้อ 15: ไม่เก็บรหัสผ่านแบบอ่านได้
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(String(plain ?? ''), hash);
}

async function expiryFromNow() {
  const minutes = (await getSettingInt('session_timeout_minutes')) || 120;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function login({ username, password, ip }) {
  const user = await get(`SELECT * FROM users WHERE username = :u`, { u: String(username ?? '').trim() });
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw Object.assign(new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'), { status: 401 });
  }
  if (!user.is_active) {
    throw Object.assign(new Error('บัญชีนี้ถูกปิดการใช้งาน'), { status: 403 });
  }
  const token = randomBytes(32).toString('hex');
  await run(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES (:t, :uid, :now, :exp)`,
    { t: token, uid: user.id, now: nowISO(), exp: await expiryFromNow() },
  );
  await run(`UPDATE users SET last_login_at = :now WHERE id = :id`, { id: user.id, now: nowISO() });
  await audit({ userId: user.id, action: 'login', entity: 'user', entityId: user.id, ip });
  return { token, user: publicUser(user) };
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
  const { password_hash, ...rest } = user;
  return rest;
}

/** ล้าง session ที่หมดอายุ */
export async function purgeSessions() {
  await run(`DELETE FROM sessions WHERE expires_at < :now`, { now: new Date().toISOString() });
}
