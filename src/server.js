import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { ROOT, PUBLIC_DIR, UPLOAD_DIR } from './lib/paths.js';

import { db, getSettingInt, isServerless } from './db/index.js';
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
import importRoutes from './routes/import.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createApp() {
  await db(); // เตรียมการเชื่อมต่อและสร้างตาราง
  if (!isServerless()) mkdirSync(UPLOAD_DIR, { recursive: true });

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
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    userFromToken(token)
      .then((user) => {
        req.ctx = { user, token, ip };
        next();
      })
      .catch(next);
  });

  app.use('/api/auth', authRoutes);

  // ต่อจากนี้ต้องเข้าสู่ระบบ
  app.use('/api', (req, res, next) => {
    if (!req.ctx.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    next();
  });

  app.get('/api/me', (req, res, next) => {
    getSettingInt('session_timeout_minutes')
      .then((timeout) => {
        res.json({
          user: publicUser(req.ctx.user),
          permissions: permissionSummary(req.ctx.user),
          session_timeout_minutes: timeout,
        });
      })
      .catch(next);
  });

  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/debtors', debtorRoutes);
  app.use('/api/contracts', contractRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/cashbook', cashbookRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/import', importRoutes);

  app.use('/uploads', express.static(UPLOAD_DIR));

  // ที่อยู่เดิมของหน้าแนะนำ — ส่งต่อถาวรมาที่หน้าแรก กันเนื้อหาซ้ำสองที่
  app.get('/welcome', (_req, res) => res.redirect(301, '/'));

  // public/index.html คือหน้าแนะนำระบบ (SEO) จึงถูกเสิร์ฟที่ / โดยอัตโนมัติ
  // ไม่ต้อง redirect ทำให้ Google เก็บหน้าแรกของโดเมนได้ตรง ๆ
  app.use(express.static(PUBLIC_DIR));

  // ตัวระบบอยู่ใต้ /app ทั้งหมด (ภายในใช้ hash routing เช่น /app#/debtors)
  app.get(/^\/app(\/.*)?$/, (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'app.html'));
  });

  // เส้นทางอื่นที่ไม่รู้จัก ส่งกลับหน้าแรก
  app.get(/^(?!\/api\/).*/, (_req, res) => res.redirect(302, '/'));

  // ตัวจัดการข้อผิดพลาดกลาง — ส่งข้อความภาษาไทยกลับให้ผู้ใช้
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'เกิดข้อผิดพลาดภายในระบบ' });
  });

  // ล้าง session ที่หมดอายุเป็นระยะ (ไม่ทำบน Serverless เพราะ process ไม่อยู่ยาว)
  if (!isServerless()) {
    setInterval(() => {
      purgeSessions().catch((err) => console.error('purgeSessions:', err.message));
    }, 15 * 60_000).unref();
  }
  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, 'server.js');
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const app = await createApp();
  app.listen(port, () => {
    console.log(`พันธมิตรเงินทุน — เปิดใช้งานที่ http://localhost:${port}`);
  });
}
