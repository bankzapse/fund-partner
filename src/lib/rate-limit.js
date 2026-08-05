/**
 * เพดานกันยิงถล่ม API แบบหยาบ ระดับ instance (เก็บในหน่วยความจำ)
 *
 * นี่ไม่ใช่การกันระดับขอบเครือข่าย (edge) — บน Vercel แต่ละ instance นับแยกกัน
 * จึงตั้งเพดานให้สูงพอที่การใช้งานจริงของทั้งทีมไม่มีทางชน แต่ตัดพฤติกรรม
 * ยิงรัวผิดปกติ (สคริปต์ดูดข้อมูล/เดาสุ่ม) ที่วิ่งเข้ามาที่ instance เดียวได้
 *
 * การกันจริงจังระดับ edge ควรตั้งเพิ่มที่ Vercel (WAF/Rate Limit) อีกชั้น
 * — บันทึกไว้ใน docs/security-hardening.md
 */
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = Number(process.env.FP_RATE_LIMIT || 600); // คำขอต่อ IP ต่อ 1 นาที

const buckets = new Map(); // ip -> { count, resetAt }

/** คืน { ok, retryAfter } — ok=false เมื่อเกินเพดานในหน้าต่างเวลาปัจจุบัน */
export function rateLimit(ip, { limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS } = {}) {
  const key = ip || 'unknown';
  const now = Date.now();

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;

  // เก็บกวาดแบบเบา ๆ กัน Map โตไม่มีที่สิ้นสุดเมื่อ IP หมุนเวียนเยอะ
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }

  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/** ใช้ในเทสต์เพื่อล้างสถานะระหว่างเคส */
export function _resetRateLimit() {
  buckets.clear();
}
