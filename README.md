# พันธมิตรเงินทุน (fund-partner)

ระบบบริหารลูกหนี้ สัญญา รับชำระ รียอด รายรับ-รายจ่าย และรายงาน สำหรับกิจการปล่อยเงินทุน
ใช้งานผ่านมือถือได้ — คิดดอกเบี้ยและกางตารางงวดอัตโนมัติ รองรับรายวัน 24 งวด รายเดือน และดอกลอย

> เว็บใช้งานจริง: https://fund-partner.vercel.app · หน้าแอปอยู่ที่ `/app`

## ภาพรวมทางเทคนิค

- **Node.js + Express 4** (ES modules) — **ไม่มี build step** เสิร์ฟ HTML/JS/CSS ตรง ๆ
- **Frontend**: vanilla JS (ไม่มี framework) ใต้ `public/` ใช้ hash routing (`/app#/debtors`)
- **ฐานข้อมูล**: PostgreSQL dialect เดียว
  - production: **Supabase** (ผ่าน `pg`) เมื่อกำหนด `DATABASE_URL`
  - dev/test: **PGlite** (PostgreSQL คอมไพล์เป็น WASM) ไม่ต้องติดตั้งอะไรเพิ่ม
- **เงินเก็บเป็นสตางค์ (BIGINT)** ทุกคอลัมน์ ไม่ใช้ float — กันปัญหาปัดเศษ
- **Deploy**: Vercel serverless (entry: `api/index.js`)

## เริ่มต้นใช้งาน

```bash
npm install
npm run dev        # รันเซิร์ฟเวอร์ (โหมด watch) ที่ http://localhost:3000 ใช้ PGlite ในเครื่อง
npm test           # รันชุดทดสอบทั้งหมด (PGlite ในหน่วยความจำ)
npm run lint       # ตรวจโค้ดด้วย ESLint (ล้มเมื่อมี warning)
npm run seed       # ใส่ข้อมูลตัวอย่างสำหรับ dev
```

ต้องใช้ **Node.js >= 22.5.0**

## ตัวแปรแวดล้อม (Environment variables)

| ตัวแปร | ใช้ทำอะไร |
|---|---|
| `DATABASE_URL` (หรือ `POSTGRES_URL`) | connection string ของ Supabase (production) — ถ้าไม่กำหนด ระบบใช้ PGlite |
| `FP_DB_PATH` | ที่เก็บ PGlite ตอน dev/test (`:memory:` = ในหน่วยความจำ) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | สำหรับไฟล์แนบบน Supabase Storage (production) |
| `SUPABASE_STORAGE_BUCKET` | ชื่อ bucket (ค่าเริ่มต้น `fund-partner`) — ต้องเป็น **private** |
| `FP_RATE_LIMIT` | เพดานคำขอ API ต่อ IP ต่อนาที (ค่าเริ่มต้น 600) |
| `FP_UPLOAD_DIR`, `FP_BACKUP_DIR` | โฟลเดอร์ไฟล์แนบ/สำรอง (โหมดในเครื่อง) |
| `PORT` | พอร์ตเซิร์ฟเวอร์ (ค่าเริ่มต้น 3000) |

> Supabase ต้องใช้ **Transaction pooler + เปิด "Use IPv4 connection"** (host `aws-0-...pooler.supabase.com:6543`)
> — Direct connection เป็น IPv6 อย่างเดียว ซึ่ง Vercel ต่อไม่ได้

## โครงสร้างโปรเจกต์

```
api/index.js          entry สำหรับ Vercel serverless
src/
  server.js           ประกอบ Express app, security headers, routing
  db/                 schema.sql (รันทุกครั้งที่ต่อ DB), การเชื่อมต่อ, seed
  domain/             ตรรกะธุรกิจ: contracts, payments, reports, import
  lib/                auth, 2FA (totp/twofactor), login-guard, storage,
                      rate-limit, client-ip, money, xlsx, ฯลฯ
  routes/             REST API แยกตามโดเมน
public/               frontend (app.html, landing.html, js/, css/, fonts/)
tests/                ชุดทดสอบ (node --test + PGlite)
supabase/migrations/  0001_init.sql (สร้างจาก schema.sql — ตรงกันเสมอ)
scripts/              go-live, inspect-db, rebuild-schema ฯลฯ
docs/                 เอกสารเพิ่มเติม (ดูด้านล่าง)
```

## ทดสอบและ CI

- ชุดทดสอบใช้ `node --test` + PGlite (ไม่ต้องมีฐานข้อมูลจริง)
- **CI**: [.github/workflows/ci.yml](.github/workflows/ci.yml) รัน `lint` + `test` ทุก push/PR บน Node 22.x และ 24.x
- แก้ `schema.sql` แล้ว **ต้อง regenerate** migration ด้วย `npm run sync:migration`
  (มี `tests/migration-sync.test.js` เป็นด่านใน CI — ลืม regenerate แล้ว CI แดงทันที)
  schema.sql รันซ้ำทุกครั้งที่ต่อ DB ทุกบรรทัดจึงต้อง idempotent — ใช้ `ADD COLUMN IF NOT EXISTS`

## ความปลอดภัย (สรุป)

ยืนยันตัวตนสองชั้น (2FA/TOTP), จำกัดจำนวนครั้งล็อกอิน, rate-limit ทั้งระบบ, นโยบายรหัสผ่าน,
ไฟล์แนบเป็น private + signed URL, บันทึกการเข้าถึงข้อมูลส่วนบุคคล (PDPA), CSP + security headers
รายละเอียดและสิ่งที่ควรทำต่อ: [docs/security-hardening.md](docs/security-hardening.md)

## Deploy

Push เข้า `main` → Vercel deploy อัตโนมัติ (CI รันคู่ขนานเป็นด่านกัน)
ตรวจสุขภาพระบบที่ `GET /healthz` (คืน 200 เมื่อ DB ปกติ, 503 เมื่อต่อ DB ไม่ได้)

## เอกสารเพิ่มเติม (`docs/`)

- [requirement-gap-51.md](docs/requirement-gap-51.md) — เทียบสเปกใหม่ 51 ข้อ กับระบบจริง (ครบทุกข้อ)
- [scope-vs-srs.md](docs/scope-vs-srs.md) — เทียบ SRS เดิม 20 ข้อ กับที่ส่งมอบ
- [security-hardening.md](docs/security-hardening.md) — สรุปมาตรการความปลอดภัย
- [storage-private-bucket.md](docs/storage-private-bucket.md) — ตั้งค่า Supabase Storage เป็น private
- [legal-checklist.md](docs/legal-checklist.md) — ประเด็นกฎหมายสำหรับทนาย
