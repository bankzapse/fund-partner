// วันที่/เวลาทั้งระบบอิงโซนเวลา Asia/Bangkok (SRS ข้อ 19)

export const TZ = 'Asia/Bangkok';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** วันที่ปัจจุบันตามเวลาไทย รูปแบบ YYYY-MM-DD */
export function today(now = new Date()) {
  return dateFmt.format(now);
}

/** เวลาปัจจุบันตามเวลาไทย รูปแบบ YYYY-MM-DD HH:mm:ss+07:00 */
export function nowISO(now = new Date()) {
  return `${dateFmt.format(now)} ${timeFmt.format(now)}+07:00`;
}

/** บวกวันให้กับสตริงวันที่ (ไม่ผูกกับ timezone ของเครื่อง) */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** บวกเดือน โดยหนีบวันที่ให้อยู่ในเดือนปลายทาง (31 ม.ค. + 1 เดือน = 28/29 ก.พ.) */
export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** ช่วงวันที่ของเดือน/ปี */
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export function yearRange(y) {
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** แปลง YYYY-MM-DD เป็นรูปแบบไทย เช่น 20/07/2569 */
export function thaiDate(dateStr) {
  if (!isDateStr(dateStr)) return dateStr ?? '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${Number(y) + 543}`;
}
