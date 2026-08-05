import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UPLOAD_DIR } from './paths.js';

/**
 * ที่เก็บไฟล์แนบ (รูปบัตร ใบเสร็จ หลักฐานการรับเงิน)
 *   - production : Supabase Storage เมื่อกำหนด SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - dev        : เขียนลงโฟลเดอร์ uploads/ ในเครื่อง
 *
 * บน Vercel ระบบไฟล์เป็นแบบอ่านอย่างเดียวและหายทุกครั้งที่ request จบ
 * จึงต้องใช้ Supabase Storage เมื่อขึ้นใช้งานจริง
 */
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'fund-partner';

export function usingSupabaseStorage() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
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

const MAX_BYTES = 8 * 1024 * 1024;

/** แยกและตรวจสอบไฟล์ที่ส่งมาแบบ data URL */
function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl));
  if (!m) throw Object.assign(new Error('รูปแบบไฟล์แนบไม่ถูกต้อง'), { status: 400 });
  const [, mime, b64] = m;
  if (!ALLOWED_MIME.has(mime)) {
    throw Object.assign(new Error('รองรับเฉพาะไฟล์ JPG, PNG, WEBP, HEIC และ PDF'), { status: 400 });
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) {
    throw Object.assign(new Error('ไฟล์ใหญ่เกิน 8 MB'), { status: 400 });
  }
  return { mime, buf };
}

/**
 * บันทึกไฟล์แนบ คืนค่า { path, mime, size }
 *
 * path ที่เก็บลงฐานข้อมูลเป็น "/uploads/<ชื่อไฟล์>" เสมอ ทั้งโหมดในเครื่องและ Supabase
 * ไม่เก็บ URL ตรงของ Supabase อีกต่อไป เพราะ URL แบบ public เปิดดูได้โดยไม่ต้องล็อกอิน
 * เวลาเปิดดูจริงจะผ่านเส้นทาง /uploads ที่ตรวจสิทธิ์ก่อน แล้วค่อยออก signed URL อายุสั้นให้
 */
export async function saveDataUrl(dataUrl, prefix = 'file') {
  if (!dataUrl) return null;
  const { mime, buf } = parseDataUrl(dataUrl);
  const name = `${prefix}-${Date.now()}-${randomBytes(6).toString('hex')}.${EXT[mime]}`;

  if (!usingSupabaseStorage()) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(join(UPLOAD_DIR, name), buf);
    return { path: `/uploads/${name}`, mime, size: buf.length };
  }

  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mime,
      'Cache-Control': '3600',
    },
    body: buf,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`อัปโหลดไฟล์ไปยัง Supabase Storage ไม่สำเร็จ (${res.status}) ${detail.slice(0, 200)}`),
      { status: 502 },
    );
  }

  // เก็บแค่เส้นทางภายใน ไม่เก็บ URL ตรงของ bucket
  return { path: `/uploads/${name}`, mime, size: buf.length };
}

/**
 * แยก "ชื่อไฟล์" ออกจากเส้นทางที่เก็บไว้ รองรับทั้งของใหม่ (/uploads/x)
 * และของเก่าที่เคยเก็บเป็น URL เต็มของ Supabase (.../object/public/<bucket>/x)
 * กันชื่อที่มี path traversal (.. หรือ /) ไม่ให้หลุดออกไป
 */
export function objectKeyFromPath(stored) {
  if (!stored) return null;
  const s = String(stored).split('?')[0]; // ตัด query (เผื่อ token) ทิ้ง
  const name = s.slice(s.lastIndexOf('/') + 1);
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  return name;
}

/**
 * ทำให้ค่าที่เก็บในฐานข้อมูลชี้กลับมาที่เส้นทาง /uploads ของเราเสมอ
 * ใช้ตอนส่งข้อมูลออก API เพื่อว่าแม้ข้อมูลเก่าจะเป็น URL public ตรง ๆ
 * เบราว์เซอร์ก็จะเรียกผ่านด่านล็อกอินของเราแทนการยิงตรงไป bucket
 */
export function toServePath(stored) {
  const name = objectKeyFromPath(stored);
  return name ? `/uploads/${name}` : stored;
}

/**
 * ขอ signed URL อายุสั้นจาก Supabase สำหรับเปิดดูไฟล์ในโหมด production
 * ผู้เรียกต้องผ่านการตรวจสิทธิ์มาก่อนแล้วเท่านั้น
 */
export async function signedUrlFor(name, expiresIn = 60) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`ออก signed URL ไม่สำเร็จ (${res.status}) ${detail.slice(0, 200)}`),
      { status: 502 },
    );
  }
  const body = await res.json();
  // signedURL ที่ได้เป็นเส้นทางสัมพัทธ์ เช่น /object/sign/<bucket>/<name>?token=...
  return `${base}/storage/v1${body.signedURL || body.signedUrl}`;
}
