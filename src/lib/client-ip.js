/**
 * หา IP ของผู้เรียกให้ปลอมยากที่สุดเท่าที่ทำได้หลัง reverse proxy
 *
 * เดิมใช้ค่า "ซ้ายสุด" ของ X-Forwarded-For ซึ่งผู้เรียกใส่มาเองได้ทั้งหมด
 * ทำให้เลี่ยงการจำกัดจำนวนครั้ง (rate limit / login lock) ได้ด้วยการสลับค่าปลอมไปเรื่อย ๆ
 *
 * ลำดับความน่าเชื่อถือที่ใช้:
 *   1) X-Real-IP — proxy ที่เชื่อถือได้ (เช่น Vercel) เป็นผู้เติม เป็นค่าเดียว ผู้เรียกเขียนทับไม่ได้
 *   2) ค่า "ขวาสุด" ของ X-Forwarded-For — hop ที่ proxy ที่เชื่อถือได้เพิ่งต่อท้าย
 *      (ค่าซ้าย ๆ คือสิ่งที่ผู้เรียกกรอกมาเอง จึงไม่ใช้)
 *   3) ที่อยู่ปลายทางของ socket — ใช้ตอนรันในเครื่องที่ไม่มี proxy
 */
export function clientIp(req) {
  const real = req.headers?.['x-real-ip'];
  if (real && String(real).trim()) return String(real).trim();

  const xff = req.headers?.['x-forwarded-for'];
  if (xff) {
    const parts = String(xff)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }

  return req.socket?.remoteAddress || null;
}
