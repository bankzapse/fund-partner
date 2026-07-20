import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { ROOT, PUBLIC_DIR, UPLOAD_DIR } from './lib/paths.js';

import { db, getSettingInt } from './db/index.js';
import { COOKIE_NAME, userFromToken, purgeSessions } from './lib/auth.js';
import { permissionSummary } from './lib/permissions.js';
import { publicUser } from './lib/auth.js';

import authRoutes from './routes/auth.js';
import debtorRoutes from './routes/debtors.js';
import contractRoutes from './routes/contracts.js';
import paymentRoutes from './routes/payments.js';
import cashbookRoutes from './routes/cashbook.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import dashboardRoutes from './routes/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  db(); // เตรียมฐานข้อมูล/สร้างตาราง
  mkdirSync(UPLOAD_DIR, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' })); // รองรับแนบรูปแบบ base64

  // แยกคุกกี้เอง (ไม่พึ่ง dependency เพิ่ม)
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const i = s.indexOf('=');
          return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
        }),
    );
    next();
  });

  // ผูกผู้ใช้ปัจจุบันเข้ากับ request
  app.use((req, _res, next) => {
    const token = req.cookies[COOKIE_NAME];
    const user = userFromToken(token);
    req.ctx = {
      user,
      token,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
    };
    next();
  });

  app.use('/api/auth', authRoutes);

  // ต่อจากนี้ต้องเข้าสู่ระบบ
  app.use('/api', (req, res, next) => {
    if (!req.ctx.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    next();
  });

  app.get('/api/me', (req, res) => {
    res.json({
      user: publicUser(req.ctx.user),
      permissions: permissionSummary(req.ctx.user),
      session_timeout_minutes: getSettingInt('session_timeout_minutes'),
    });
  });

  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/debtors', debtorRoutes);
  app.use('/api/contracts', contractRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/cashbook', cashbookRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/admin', adminRoutes);

  app.use('/uploads', express.static(UPLOAD_DIR));

  // หน้าแนะนำระบบสำหรับ SEO — เป็น HTML สมบูรณ์ ไม่ต้องรอ JavaScript
  app.get('/welcome', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'welcome.html')));

  app.use(express.static(PUBLIC_DIR));

  // SPA fallback
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

  // ตัวจัดการข้อผิดพลาดกลาง — ส่งข้อความภาษาไทยกลับให้ผู้ใช้
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'เกิดข้อผิดพลาดภายในระบบ' });
  });

  setInterval(purgeSessions, 15 * 60_000).unref();
  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, 'server.js');
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`พันธมิตรเงินทุน — เปิดใช้งานที่ http://localhost:${port}`);
  });
}
