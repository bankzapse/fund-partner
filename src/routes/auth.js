import { Router } from 'express';
import { login, logout, COOKIE_NAME, publicUser, hashPassword, verifyPassword } from '../lib/auth.js';
import { permissionSummary } from '../lib/permissions.js';
import { run, get, getSettingInt } from '../db/index.js';
import { nowISO } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { wrap } from './_helpers.js';

const router = Router();

router.post(
  '/login',
  wrap(async (req, res) => {
    const { token, user } = await login({
      username: req.body?.username,
      password: req.body?.password,
      ip: req.ctx.ip,
    });
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

export default router;
