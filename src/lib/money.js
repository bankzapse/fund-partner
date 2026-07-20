// จำนวนเงินทั้งระบบเก็บเป็นจำนวนเต็ม "สตางค์" ห้ามใช้ Float (SRS ข้อ 19)

/** ข้อมูลนำเข้าผิด = ความผิดฝั่งผู้เรียก ต้องตอบ 400 ไม่ใช่ 500 ที่แปลว่าระบบพัง */
function badInput(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** แปลงค่าที่รับจากผู้ใช้ (บาท) เป็นสตางค์ */
export function toSatang(baht) {
  if (baht === null || baht === undefined || baht === '') return 0;
  const n = typeof baht === 'number' ? baht : Number(String(baht).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw badInput('จำนวนเงินไม่ถูกต้อง');
  // ปัดครึ่งขึ้นที่ทศนิยม 2 ตำแหน่ง แล้วเก็บเป็นจำนวนเต็ม
  return Math.round(n * 100);
}

/** แปลงสตางค์กลับเป็นบาท (number) สำหรับส่งออก API */
export function toBaht(satang) {
  return Math.round(satang) / 100;
}

/** จัดรูปแบบเงินบาทสำหรับแสดงผล */
export function formatBaht(satang) {
  return toBaht(satang).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** ตรวจว่าเป็นจำนวนเงินที่ไม่ติดลบ (SRS ข้อ 14: ห้ามรับยอดติดลบ) */
export function assertNonNegative(satang, label = 'จำนวนเงิน') {
  if (!Number.isInteger(satang)) throw badInput(`${label} ไม่ถูกต้อง`);
  if (satang < 0) throw badInput(`${label} ต้องไม่ติดลบ`);
  return satang;
}

export function assertPositive(satang, label = 'จำนวนเงิน') {
  assertNonNegative(satang, label);
  if (satang === 0) throw badInput(`${label} ต้องมากกว่า 0`);
  return satang;
}
