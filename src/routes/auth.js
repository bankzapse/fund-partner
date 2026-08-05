import { Router } from 'express';
import { login, logout, COOKIE_NAME, publicUser, hashPassword, verifyPassword } from '../lib/auth.js';
import { setup2FA, enable2FA, disable2FA } from '../lib/twofactor.js';
import { permissionSummary } from '../lib/permissions.js';
import { run, get, getSettingInt } from '../db/index.js';
import { nowISO } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { wrap } from './_helpers.js';

const router = Router();

router.post(
  '/login',
  wrap(async (req, res) => {
    let result;
    try {
      result = await login({
        username: req.body?.username,
        password: req.body?.password,
        token: req.body?.token, // รหัสยืนยัน 2 ชั้น (ถ้ามี)
        ip: req.ctx.ip,
      });
    } catch (err) {
      // รหัสผ่านถูกแต่ต้องกรอกรหัส 2FA เพิ่ม — บอกหน้าเว็บให้ขึ้นช่องกรอกรหัส
      if (err.twoFactorRequired) {
        return res.status(401).json({ error: err.message, two_factor_required: true });
      }
      throw err;
    }
    const { token, user } = result;
    res.cookie?.(COOKIE_NAME, token);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
        (await getSettingInt('session_timeout_minutes') || 120) * 60
      }${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    );
    res.json({ user, permissions: permissionSummary(user) });
  }),
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    await logout(req.ctx.token, req.ctx);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  }),
);

router.post(
  '/change-password',
  wrap(async (req, res) => {
    if (!req.ctx.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    const user = await get(`SELECT * FROM users WHERE id = :id`, { id: req.ctx.user.id });
    if (!verifyPassword(req.body?.current_password, user.password_hash)) {
      return res.status(400).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    }
    await run(`UPDATE users SET password_hash = :h, updated_at = :now WHERE id = :id`, {
      id: user.id,
      h: hashPassword(req.body?.new_password),
      now: nowISO(),
    });
    await audit({
      userId: user.id,
      action: 'update',
      entity: 'user',
      entityId: user.id,
      after: { password_changed: true },
      ip: req.ctx.ip,
    });
    res.json({ ok: true });
  }),
);

router.get('/session', (req, res) => {
  res.json({
    user: publicUser(req.ctx.user),
    permissions: req.ctx.user ? permissionSummary(req.ctx.user) : {},
  });
});

// ---- ยืนยันตัวตนสองชั้น (2FA) ------------------------------------------------

// เริ่มตั้งค่า: สร้าง secret ชั่วคราว คืน URI/secret ให้ผู้ใช้เพิ่มเข้าแอป Authenticator
router.post(
  '/2fa/setup',
  wrap(async (req, res) => {
    if (!req.ctx.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    const info = await setup2FA(req.ctx.user.id, req.ctx.user.username);
    res.json(info);
  }),
);

// ยืนยันรหัสจากแอปเพื่อเปิดใช้จริง คืนรหัสสำรอง (แสดงครั้งเดียว)
router.post(
  '/2fa/enable',
  wrap(async (req, res) => {
    if (!req.ctx.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    const { recovery_codes } = await enable2FA(req.ctx.user.id, req.body?.token);
    await audit({
      userId: req.ctx.user.id, action: 'enable_2fa', entity: 'user',
      entityId: req.ctx.user.id, ip: req.ctx.ip,
    });
    res.json({ ok: true, recovery_codes });
  }),
);

// ปิด 2FA — ต้องยืนยันรหัสผ่านปัจจุบันก่อน กันคนแอบปิดตอนเผลอเปิดจอทิ้งไว้
router.post(
  '/2fa/disable',
  wrap(async (req, res) => {
    if (!req.ctx.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    const user = await get(`SELECT * FROM users WHERE id = :id`, { id: req.ctx.user.id });
    if (!verifyPassword(req.body?.password, user.password_hash)) {
      return res.status(400).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }
    await disable2FA(req.ctx.user.id);
    await audit({
      userId: req.ctx.user.id, action: 'disable_2fa', entity: 'user',
      entityId: req.ctx.user.id, ip: req.ctx.ip,
    });
    res.json({ ok: true });
  }),
);

export default router;
