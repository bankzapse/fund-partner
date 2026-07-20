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
 * path เป็น URL ที่เปิดดูได้ทันที
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
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${name}`, {
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

  return {
    path: `${base}/storage/v1/object/public/${BUCKET}/${name}`,
    mime,
    size: buf.length,
  };
}
