// ยืนยันตัวตนสองชั้นแบบ TOTP (RFC 6238) ด้วย node:crypto ล้วน ไม่พึ่ง dependency ภายนอก
// ใช้ได้กับแอป Authenticator ทั่วไป (Google Authenticator, Microsoft Authenticator, Authy ฯลฯ)
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // ตัวอักษร Base32 ตามมาตรฐาน RFC 4648

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue; // ข้ามอักขระที่ไม่ใช่ Base32
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** สร้าง secret ใหม่ (20 ไบต์ = 160 บิต ตามคำแนะนำ RFC 4226) เป็น Base32 */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP (RFC 4226) — คืนรหัสตัวเลขจาก key (Buffer) และตัวนับ */
function hotp(keyBuf, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** รหัส TOTP ณ เวลาที่กำหนด (ms) — ใช้ในเทสต์และตอนแสดงตัวอย่าง */
export function totpAt(secretBase32, timeMs = Date.now(), { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(timeMs / 1000 / step);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * ตรวจรหัส TOTP โดยเผื่อคลาดเคลื่อนของนาฬิกา ±window ช่วง (ค่าเริ่มต้น ±1 = ±30 วินาที)
 * เทียบแบบ timing-safe กันการวัดเวลาตอบกลับเพื่อเดารหัส
 */
export function verifyTotp(secretBase32, token, { timeMs = Date.now(), step = 30, window = 1, digits = 6 } = {}) {
  const t = String(token ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(t)) return false;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / step);
  const tBuf = Buffer.from(t);
  for (let w = -window; w <= window; w++) {
    const cand = Buffer.from(hotp(key, counter + w, digits));
    if (cand.length === tBuf.length && crypto.timingSafeEqual(cand, tBuf)) return true;
  }
  return false;
}

/** สร้าง otpauth:// URI สำหรับให้แอป Authenticator สแกน/กรอกเอง */
export function otpauthUri({ secret, label, issuer = 'พันธมิตรเงินทุน' }) {
  const acct = `${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${acct}?${params.toString()}`;
}

/** สร้างรหัสสำรอง (ใช้ตอนทำมือถือหาย) — คืนรหัสดิบให้ผู้ใช้เก็บครั้งเดียว */
export function generateRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 อักขระ hex
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`);
  }
  return codes;
}

/** แฮชรหัสสำรองก่อนเก็บ (ไม่เก็บแบบอ่านได้) — normalize ตัดขีดและตัวพิมพ์ */
export function hashRecoveryCode(code) {
  const norm = String(code ?? '').replace(/[-\s]/g, '').toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex');
}
