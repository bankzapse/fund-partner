import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { ROOT, PUBLIC_DIR, UPLOAD_DIR } from './lib/paths.js';

import { db, getSettingInt, isServerless } from './db/index.js';
import { COOKIE_NAME, userFromToken, purgeSessions } from './lib/auth.js';
import { permissionSummary } from './lib/permissions.js';
import { renderLanding } from './lib/landing.js';
import { publicUser } from './lib/auth.js';
import { usingSupabaseStorage, signedUrlFor, objectKeyFromPath } from './lib/storage.js';
import { clientIp } from './lib/client-ip.js';
import { rateLimit } from './lib/rate-limit.js';
import { logAccess } from './lib/audit.js';

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

  // ส่วนหัวความปลอดภัย — บน Vercel ตั้งไว้ใน vercel.json ด้วย แต่ตั้งซ้ำที่นี่
  // เพื่อให้ครอบคลุมตอนรันเองในเครื่อง/โฮสต์อื่น และกันกรณีตั้งค่าแพลตฟอร์มหลุด
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; font-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
    );
    next();
  });

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
    const ip = clientIp(req);
    userFromToken(token)
      .then((user) => {
        req.ctx = { user, token, ip };
        next();
      })
      .catch(next);
  });

  // เพดานกันยิงถล่ม API แบบหยาบ (รวมถึงหน้าเข้าสู่ระบบ) — ก่อนถึงเส้นทางใด ๆ ใต้ /api
  app.use('/api', (req, res, next) => {
    const { ok, retryAfter } = rateLimit(req.ctx.ip);
    if (!ok) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'มีการเรียกใช้งานถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' });
    }
    next();
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

  // ไฟล์แนบเป็นข้อมูลอ่อนไหว (สำเนาบัตรประชาชน หลักฐานการเงิน)
  // ต้องผ่านด่านล็อกอินก่อนเสมอ ไม่งั้นใครมี URL ก็เปิดดูได้ทันที
  app.use('/uploads', (req, res, next) => {
    if (!req.ctx?.user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    next();
  });

  // โหมด production: ไฟล์อยู่บน Supabase (bucket แบบ private)
  // ผู้ใช้ที่ล็อกอินแล้วเท่านั้นจะได้ signed URL อายุสั้นแล้วพาไปเปิดไฟล์
  if (usingSupabaseStorage()) {
    app.get('/uploads/:name', (req, res, next) => {
      const name = objectKeyFromPath(req.params.name);
      if (!name) return res.status(400).type('text/plain; charset=utf-8').send('ชื่อไฟล์ไม่ถูกต้อง');
      signedUrlFor(name, 60)
        .then(async (url) => {
          // PDPA: บันทึกว่าใครเปิดดูไฟล์แนบ (สำเนาบัตร/หลักฐาน) ตัวไหน
          await logAccess({
            userId: req.ctx.user.id,
            entity: 'attachment',
            entityId: name,
            ip: req.ctx.ip,
          });
          res.setHeader('Cache-Control', 'private, no-store');
          res.redirect(302, url);
        })
        .catch(next);
    });
  } else {
    // โหมดในเครื่อง: เสิร์ฟจากโฟลเดอร์ uploads/ ตามปกติ
    app.use('/uploads', express.static(UPLOAD_DIR));
  }

  // ที่อยู่เดิมของหน้าแนะนำ — ส่งต่อถาวรมาที่หน้าแรก กันเนื้อหาซ้ำสองที่
  app.get('/welcome', (_req, res) => res.redirect(301, '/'));

  // หน้าแนะนำระบบ (SEO) อยู่ที่ / โดยตรง ไม่ต้อง redirect
  // Google จึงเก็บหน้าแรกของโดเมนได้ตรง ๆ
  //
  // เก็บไฟล์ไว้ชื่อ landing.html ไม่ใช่ index.html โดยตั้งใจ
  // เพราะถ้าชื่อ index.html บน Vercel จะถูกเสิร์ฟเป็นไฟล์นิ่งก่อนถึงโค้ดนี้
  // (Vercel ตรวจระบบไฟล์ก่อน rewrite เสมอ) ทำให้ราคาที่ตั้งไว้ไม่ถูกเติมลงไป
  app.get('/', (_req, res, next) => {
    renderLanding(PUBLIC_DIR)
      .then((html) => {
        // ให้ CDN เก็บไว้ 5 นาที และเสิร์ฟของเดิมไปพลางระหว่างดึงใหม่
        // แก้ราคาแล้วจะเห็นผลภายในไม่กี่นาที โดยไม่ต้องปลุกเซิร์ฟเวอร์ทุกครั้งที่มีคนเข้า
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
        res.type('html').send(html);
      })
      .catch(next);
  });

  // กันไม่ให้เปิดไฟล์ต้นแบบตรง ๆ ได้
  // ไฟล์นี้ยังไม่ได้เติมราคา ถ้า Google เก็บไปจะกลายเป็นเนื้อหาซ้ำที่ไม่มีราคา
  // ต้องดักก่อน express.static ไม่งั้นไฟล์จะถูกส่งออกไปก่อน
  app.get('/landing.html', (_req, res) => res.redirect(301, '/'));

  app.use(express.static(PUBLIC_DIR));

  // ตัวระบบอยู่ใต้ /app ทั้งหมด (ภายในใช้ hash routing เช่น /app#/debtors)
  app.get(/^\/app(\/.*)?$/, (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'app.html'));
  });

  // หน้านโยบายความเป็นส่วนตัว (URL สั้น) — ต้องดักก่อน catch-all ด้านล่าง
  // ไม่งั้นเส้นทางที่ไม่มีนามสกุลไฟล์จะถูก redirect กลับหน้าแรก
  app.get('/privacy', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'privacy.html')));

  // เส้นทางอื่นที่ไม่รู้จัก
  //
  // แยกสองกรณี เพราะปลายทางต่างกันโดยสิ้นเชิง:
  //   - คนพิมพ์ URL ผิด เช่น /login → พาไปหน้าแรก ดีกว่าโชว์หน้า 404 ดิบ ๆ
  //   - ไฟล์ที่หายไป เช่น /js/typo.js → ต้องตอบ 404 ตรง ๆ
  //     ถ้า redirect ไปหน้าแรก เบราว์เซอร์จะได้ HTML มาแทนไฟล์ JS
  //     แล้วขึ้น error แปลก ๆ ที่ตามหาต้นตอยาก
  app.get(/^(?!\/api\/).*/, (req, res) => {
    if (/\.[a-z0-9]{1,8}$/i.test(req.path)) {
      return res.status(404).type('text/plain; charset=utf-8').send('ไม่พบไฟล์ที่ร้องขอ');
    }
    res.redirect(302, '/');
  });

  // ตัวจัดการข้อผิดพลาดกลาง — ส่งข้อความภาษาไทยกลับให้ผู้ใช้
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    if (err.retryAfterSeconds > 0) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    // error 500 ไม่ส่งข้อความดิบกลับ เพราะอาจมีชื่อตาราง foreign key หรือโครงสร้าง
    // ฐานข้อมูลปนอยู่ ซึ่งช่วยผู้โจมตีวางแผนต่อ ส่งข้อความกลาง ๆ แทน
    // ส่วน error ที่ตั้ง status เอง (4xx) เป็นข้อความที่เราเขียนให้ผู้ใช้อ่าน จึงส่งได้
    const message = status >= 500 ? 'เกิดข้อผิดพลาดภายในระบบ' : (err.message || 'เกิดข้อผิดพลาด');
    res.status(status).json({ error: message });
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
