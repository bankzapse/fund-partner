import {
  all,
  get,
  run,
  insert,
  tx,
  nextCounter,
  getSettingInt,
  getSetting,
  DISBURSE_CATEGORY,
  REYOD_INTEREST_CATEGORY,
  UPFRONT_INTEREST_CATEGORY,
  REYOD_CARRY_RETURN_CATEGORY,
} from '../db/index.js';
import { assertNonNegative, assertPositive, formatBaht } from '../lib/money.js';
import { today, nowISO, addDays, addMonths, isDateStr } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { recordFirstInstallment } from './payments.js';
import { holidayDatesFor } from './holidays.js';

export const CONTRACT_TYPES = {
  daily24: { label: 'รายวัน 24 งวด', unit: 'day' },
  monthly: { label: 'รายเดือน', unit: 'month' },
  // ดอกลอยเป็นบาท/วัน (สเปกข้อ 17) — ตารางที่สร้างเป็นแค่ปฏิทินเก็บดอกล่วงหน้า
  // ไม่ใช่วันครบสัญญา: สัญญาปิดเมื่อเงินต้นหมดเท่านั้น (ข้อ 18/20)
  floating: { label: 'ดอกลอย (บาท/วัน)', unit: 'day' },
};

export class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * สร้างตารางงวด (SRS ข้อ 3)
 * - รายวัน 24 งวด / รายเดือน : แต่ละงวดตัดดอกเบี้ยคงที่ ส่วนที่เหลือตัดเงินต้น
 * - ดอกลอย                    : แต่ละรอบจ่ายเฉพาะดอกเบี้ย เงินต้นคงเดิม
 */
/**
 * กระจายจำนวนเงินก้อนหนึ่งลง n งวด โดยผลรวมตรงเป๊ะเสมอ
 *
 * ใช้วิธี "ปัดแบบสะสม" คือคำนวณยอดสะสมถึงงวดที่ k แล้วลบยอดสะสมของงวดก่อนหน้า
 * ผลรวมจึงเท่ากับยอดตั้งต้นเสมอโดยไม่ต้องตามเก็บเศษทีหลัง
 *
 * จำเป็นเพราะถ้าผลรวมเงินต้นรายงวดต่างจากเงินต้นตามสัญญาแม้แต่สตางค์เดียว
 * สัญญาจะปิดเป็น "ครบสัญญา" ไม่ได้เลยและค้างเป็นหนี้ค้างในรายงานตลอดไป
 */
function spreadExact(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let cumW = 0, cumOut = 0;
  for (const w of weights) {
    cumW += w;
    const target = Math.round((total * cumW) / sumW);
    out.push(target - cumOut);
    cumOut = target;
  }
  return out;
}

/**
 * ตารางงวดแบบ "ดอกเหมารวมคงที่ต่อสัญญา"
 *
 * ยอดหนี้รวม = เงินต้น + ดอก โดยดอกคิดเป็น % ของเงินต้นครั้งเดียวตอนทำสัญญา
 * เช่น กู้ 2,000 ดอก 20% => ดอก 400 ยอดรวม 2,400 จำนวน 24 งวด งวดละ 100
 *
 * ค่างวดปัดเป็นบาทถ้วน เพราะพนักงานเก็บเงินสดหน้างานจริง
 * ถ้าเก็บเป็นเศษสตางค์ พนักงานจะปัดเอง แล้วยอดในระบบกับเงินสดจริงจะไม่ตรงกัน
 * เศษที่เหลือทั้งหมดไปรวมที่งวดสุดท้าย
 */
/**
 * ชุดวันครบกำหนดของตารางงวด แบบข้ามวันหยุด (สเปกข้อ 23: วันหยุดไม่สร้างงวด)
 *   รายวัน: วันถัดไปเรื่อย ๆ ข้ามทุกวันที่อยู่ในเซตวันหยุด (ตารางเลื่อนออกไปทั้งแผง)
 *   รายเดือน: ยึดรอบเดือนเดิม ถ้าตรงวันหยุดเลื่อนวันนั้น +1 จนพ้น
 */
function dueDatesFor(unit, startDate, count, skipDates = null) {
  const out = [];
  if (unit === 'day') {
    let cursor = startDate;
    for (let i = 0; i < count; i++) {
      if (i > 0) cursor = addDays(cursor, 1);
      while (skipDates?.has(cursor)) cursor = addDays(cursor, 1);
      out.push(cursor);
    }
  } else {
    for (let i = 0; i < count; i++) {
      let d = addMonths(startDate, i);
      while (skipDates?.has(d)) d = addDays(d, 1);
      out.push(d);
    }
  }
  return out;
}

export function buildFlatSchedule({ type, startDate, numInstallments, principalAmount, interestRateBp, skipDates = null }) {
  const unit = CONTRACT_TYPES[type].unit;
  const n = numInstallments;
  // ปัดดอกเบี้ยเป็น "บาทถ้วน" ไม่ใช่แค่สตางค์
  //
  // ถ้าปัดเป็นสตางค์ ยอดหนี้รวมจะมีเศษสตางค์ได้ (เช่น 3,333 บาท ดอก 15% = 499.95)
  // แล้วงวดสุดท้ายจะกลายเป็นเศษสตางค์ตามไปด้วย ซึ่งพนักงานเก็บเงินสดหน้างานไม่ได้
  // พอเก็บไม่ครบแม้แต่สตางค์เดียว เงินต้นคงเหลือจะไม่เป็น 0
  // สัญญาจึงปิดเป็น "ครบสัญญา" ไม่ได้ตลอดไป และรียอดออกก็ไม่ได้
  // สำรวจแล้วพบว่าเกิดกับเงินต้นบาทถ้วนถึง 80–95% ของกรณีจริง ไม่ใช่กรณีหายาก
  const interestTotal = Math.round((principalAmount * interestRateBp) / 10000 / 100) * 100;
  const totalDue = principalAmount + interestTotal;

  // ค่างวดเป็นบาทถ้วน (100 สตางค์) เศษไปงวดสุดท้าย
  const per = Math.floor(totalDue / n / 100) * 100;
  // ถ้าค่างวดปัดแล้วเหลือ 0 แปลว่าเงินต้นน้อยเกินไปเมื่อเทียบกับจำนวนงวด
  // ปล่อยผ่านจะได้ตารางที่หลายงวดเป็น 0 บาทแล้วไปกองที่งวดสุดท้าย ซึ่งใช้งานจริงไม่ได้
  // โยนออกตรงนี้ด้วย เผื่อมีคนเรียกฟังก์ชันนี้ตรง ๆ โดยไม่ผ่านด่านตรวจของ normalizeContractInput
  if (per <= 0) {
    throw new BusinessError('จำนวนงวดมากเกินไปจนค่างวดต่ำกว่า 1 บาท');
  }
  const dues = Array(n).fill(per);
  dues[n - 1] = totalDue - per * (n - 1);

  // แบ่งดอก/ต้นในแต่ละงวดตามสัดส่วนของค่างวด ผลรวมทั้งสองฝั่งจึงตรงเป๊ะ
  const interests = spreadExact(interestTotal, dues);

  const dates = dueDatesFor(unit, startDate, n, skipDates);
  const rows = dues.map((due, i) => ({
    seq: i + 1,
    due_date: dates[i],
    interest_due: interests[i],
    principal_due: due - interests[i],
    due_amount: due,
  }));

  // คืนค่างวดจากแถวแรกของตารางจริง ไม่ใช่ค่า per ที่ปัดลงไว้
  // เพราะกรณีมีงวดเดียว แถวนั้นคือทั้งยอด ซึ่งต่างจาก per
  // ถ้าคืน per ไป ค่างวดที่บันทึกในสัญญาจะไม่ตรงกับที่ต้องเก็บจริง
  return { rows, interestTotal, totalDue, installmentAmount: rows[0].due_amount };
}

/**
 * ตารางงวดโหมด "หักดอกก่อน" (สเปกข้อ 9, 15)
 *
 * ยอดสัญญา 2,000 ดอก 10% → หักดอก 200 ตอนจ่ายเงิน ลูกค้าได้จริง 1,800
 * แต่ส่งคืนตามยอดสัญญา 2,000 — ตารางงวดจึงเป็น "เงินต้นล้วน" รวมเท่ายอดสัญญา
 * (ดอกถูกรับรู้เป็นรายได้ตั้งแต่วันเปิดสัญญา ไม่ปนอยู่ในงวด)
 *
 * ใช้กติกาปัดบาทถ้วนเดียวกับโหมดเหมารวม: ค่างวดบาทถ้วน เศษไปงวดสุดท้าย
 */
export function buildDeductUpfrontSchedule({ type, startDate, numInstallments, principalAmount, interestRateBp, skipDates = null }) {
  const unit = CONTRACT_TYPES[type].unit;
  const n = numInstallments;
  // ดอกหักก่อน ปัดเป็นบาทถ้วน (เหตุผลเดียวกับโหมดเหมารวม — เก็บเงินสดหน้างานจริง)
  const upfrontInterest = Math.round((principalAmount * interestRateBp) / 10000 / 100) * 100;
  const totalDue = principalAmount; // ลูกค้าส่งคืนตามยอดสัญญา ไม่บวกดอก

  const per = Math.floor(totalDue / n / 100) * 100;
  if (per <= 0) {
    throw new BusinessError('จำนวนงวดมากเกินไปจนค่างวดต่ำกว่า 1 บาท');
  }
  const dues = Array(n).fill(per);
  dues[n - 1] = totalDue - per * (n - 1);

  const dates = dueDatesFor(unit, startDate, n, skipDates);
  const rows = dues.map((due, i) => ({
    seq: i + 1,
    due_date: dates[i],
    interest_due: 0, // ดอกรับรู้ไปแล้ววันเปิดสัญญา งวดเป็นเงินต้นล้วน
    principal_due: due,
    due_amount: due,
  }));

  return { rows, upfrontInterest, totalDue, installmentAmount: rows[0].due_amount };
}

export function buildSchedule({
  type,
  startDate,
  numInstallments,
  installmentAmount,
  interestPerInst,
  principalAmount,
  skipDates = null,
}) {
  const unit = CONTRACT_TYPES[type].unit;
  const rows = [];
  let principalLeft = principalAmount;
  const dates = dueDatesFor(unit, startDate, numInstallments, skipDates);

  for (let seq = 1; seq <= numInstallments; seq++) {
    const dueDate = dates[seq - 1];

    let interestDue = interestPerInst;
    let principalDue;

    if (type === 'floating') {
      principalDue = 0; // เงินต้นคงเดิมจนกว่าจะชำระต้น รียอด หรือปิดสัญญา
    } else {
      principalDue = Math.max(0, installmentAmount - interestPerInst);
      // งวดสุดท้ายไม่ตัดเกินเงินต้นที่เหลืออยู่ (ข้อ 14: เงินต้นคงเหลือต้องไม่ต่ำกว่า 0)
      if (principalDue > principalLeft) principalDue = principalLeft;
      principalLeft -= principalDue;
    }

    rows.push({
      seq,
      due_date: dueDate,
      interest_due: interestDue,
      principal_due: principalDue,
      due_amount: interestDue + principalDue,
    });
  }
  return rows;
}

/** สรุปตัวเลขให้ผู้ใช้ตรวจก่อนยืนยัน (ข้อ 7.1 "แสดงเงินที่ลูกค้าได้รับจริงก่อนยืนยัน") */
/**
 * สร้างตารางงวดตามโหมดของสัญญา — จุดเดียวที่ตัดสินใจว่าจะใช้สูตรไหน
 * ทุกที่ที่ต้องการตารางงวดต้องเรียกผ่านตัวนี้ ไม่เรียก buildSchedule ตรง ๆ
 */
export function scheduleFor(p) {
  if (p.interestMode === 'flat_total') return buildFlatSchedule(p).rows;
  if (p.interestMode === 'deduct_upfront') return buildDeductUpfrontSchedule(p).rows;
  return buildSchedule(p);
}

export async function previewContract(input) {
  const p = await normalizeContractInput(input);
  const schedule = scheduleFor(p);
  const totalDue = schedule.reduce((s, r) => s + r.due_amount, 0);
  const totalInterest = schedule.reduce((s, r) => s + r.interest_due, 0);
  const totalPrincipalScheduled = schedule.reduce((s, r) => s + r.principal_due, 0);

  const docFee = p.docFee;
  const firstInst = p.deductFirst ? schedule[0].due_amount : 0;
  const grossOut = p.grossOut ?? p.principalAmount;
  // โหมดหักดอกก่อน (สเปกข้อ 9): ดอกทั้งก้อนถูกหักออกจากเงินที่จ่ายให้ลูกค้า ณ วันเปิด
  // เช่น ยอดสัญญา 2,000 ดอก 10% → หัก 200 ลูกค้าได้ 1,800 แต่ส่งคืน 2,000
  const upfrontIntended =
    p.interestMode === 'deduct_upfront'
      ? Math.round((p.principalAmount * p.interestRateBp) / 10000 / 100) * 100
      : 0;
  // ห้ามหักเกินเงินที่จ่ายออกจริง
  //
  // เดิมใช้ Math.max(0, ...) ซึ่งกลืนส่วนที่ติดลบทิ้งเงียบ ๆ
  // ผลคือระบบยังบันทึกค่าทำเอกสารและงวดแรกเป็นเงินเข้าเต็มจำนวน
  // ทั้งที่ไม่มีเงินสดจ่ายออกให้หัก เงินสดในระบบจึงงอกขึ้นเองทุกครั้งที่รียอด
  // (รียอดโดยไม่เติมเงิน + ค่าตั้งต้นของระบบ = เงินงอก 170 บาทต่อครั้ง)
  //
  // ลำดับการหัก: ดอกหักก่อน (นิยามของโหมด) → ค่าเอกสาร → งวดแรก
  const upfrontCharged = Math.min(upfrontIntended, grossOut);
  const feeCharged = Math.min(docFee, Math.max(0, grossOut - upfrontCharged));
  const firstCharged = Math.min(firstInst, Math.max(0, grossOut - upfrontCharged - feeCharged));
  const cashToCustomer = grossOut - upfrontCharged - feeCharged - firstCharged;

  const warnings = [];
  // โหมดที่คิดจากอัตรา % (เหมารวม/หักดอกก่อน) กระจายเงินต้นครบเสมอโดยการออกแบบ
  // จึงไม่ต้องเตือนสองข้อนี้ — เตือนเฉพาะโหมดเดิมที่ผู้ใช้กรอกค่างวดเอง
  const legacyMode = p.interestMode === 'per_installment';
  if (upfrontCharged < upfrontIntended) {
    warnings.push(
      `เงินที่จ่ายออกจริงมีแค่ ${formatBaht(grossOut)} บาท ` +
        `จึงหักดอกก่อนได้ ${formatBaht(upfrontCharged)} จาก ${formatBaht(upfrontIntended)} บาท — ` +
        `ส่วนที่หักไม่ได้จะไม่ถูกบันทึกเป็นรายได้ ถ้าต้องการเก็บครบ ให้เก็บเป็นเงินสดแยกต่างหาก`,
    );
  }
  if (legacyMode && p.type !== 'floating' && totalPrincipalScheduled < p.principalAmount) {
    warnings.push(
      `ตารางงวดตัดเงินต้นรวม ${formatBaht(totalPrincipalScheduled)} บาท ` +
        `น้อยกว่าเงินต้นตามสัญญา ${formatBaht(p.principalAmount)} บาท ` +
        `จะเหลือเงินต้นค้าง ${formatBaht(p.principalAmount - totalPrincipalScheduled)} บาท เมื่อครบงวด (ต้องรียอดหรือชำระเพิ่ม)`,
    );
  }
  if (legacyMode && p.type !== 'floating' && p.installmentAmount <= p.interestPerInst) {
    warnings.push('ค่างวดต้องมากกว่าดอกเบี้ยต่องวด มิฉะนั้นเงินต้นจะไม่ลดเลย');
  }
  // หักงวดแรกมากกว่าเงินที่ปล่อยจริง = บันทึกรับเงินสดที่ไม่มีอยู่จริง
  // เกิดได้ในโหมดเหมารวมเพราะผู้ใช้ไม่ได้กรอกค่างวดเอง ระบบคำนวณให้จากอัตรา %
  // จึงมองไม่เห็นว่ากำลังหักเกิน ต่างจากโหมดเดิมที่กรอกค่างวดเองแล้วเห็นตัวเลข
  if (feeCharged < docFee || firstCharged < firstInst) {
    warnings.push(
      `เงินที่จ่ายออกจริงมีแค่ ${formatBaht(grossOut)} บาท ` +
        `จึงหักค่าทำเอกสารได้ ${formatBaht(feeCharged)} จาก ${formatBaht(docFee)} บาท ` +
        `และหักงวดแรกได้ ${formatBaht(firstCharged)} จาก ${formatBaht(firstInst)} บาท — ` +
        `ส่วนที่หักไม่ได้จะไม่ถูกบันทึกเป็นเงินเข้า ถ้าต้องการเก็บครบ ให้เก็บเป็นเงินสดแยกต่างหาก`,
    );
  }

  // งวดสุดท้ายไม่เท่างวดอื่นเพราะรับเศษไว้ ต้องบอกให้เห็นก่อนยืนยัน
  // ไม่งั้นพนักงานจะไปเก็บผิดยอดในวันสุดท้าย
  if (!legacyMode && schedule.length > 1) {
    const last = schedule[schedule.length - 1].due_amount;
    if (last !== schedule[0].due_amount) {
      warnings.push(
        `งวดสุดท้ายเป็น ${formatBaht(last)} บาท ไม่เท่างวดอื่นที่ ${formatBaht(schedule[0].due_amount)} บาท ` +
          `เพราะยอดหนี้รวมหารด้วยจำนวนงวดไม่ลงตัว — ปรับเงินต้นหรือจำนวนงวดถ้าอยากให้เท่ากันทุกงวด`,
      );
    }
  }

  return {
    ...p,
    schedule,
    totals: {
      total_due: totalDue,
      total_interest: totalInterest,
      total_principal_scheduled: totalPrincipalScheduled,
    },
    doc_fee: feeCharged,
    first_installment: firstCharged,
    // ดอกหักก่อนที่หักได้จริง (โหมด deduct_upfront เท่านั้น อื่น ๆ เป็น 0)
    upfront_interest: upfrontCharged,
    // ค่าที่ตั้งใจหักเดิม เก็บไว้เพื่อเตือนเมื่อหักได้ไม่ครบ
    doc_fee_intended: docFee,
    first_installment_intended: firstInst,
    upfront_interest_intended: upfrontIntended,
    gross_out: grossOut,
    cash_to_customer: cashToCustomer,
    warnings,
  };
}

async function normalizeContractInput(input) {
  const type = input.type;
  if (!CONTRACT_TYPES[type]) throw new BusinessError('ประเภทสัญญาไม่ถูกต้อง');

  const startDate = input.startDate || today();
  if (!isDateStr(startDate)) throw new BusinessError('วันเริ่มสัญญาไม่ถูกต้อง');

  const principalAmount = assertPositive(input.principalAmount, 'เงินต้น');

  // อ่านโหมดก่อนตรวจค่าอื่น เพราะโหมดที่คิดจากอัตรา % (เหมารวม/หักดอกก่อน)
  // ผู้ใช้ไม่ได้กรอกดอกต่องวดกับค่างวดมาเลย ระบบคำนวณให้เองจากอัตรา
  // โหมดที่ส่งมาผิด (สะกดผิด) ต้องบอกชัด ไม่ปล่อยตกไป per_installment เงียบ ๆ
  if (input.interestMode && !['flat_total', 'deduct_upfront', 'per_installment'].includes(input.interestMode)) {
    throw new BusinessError('วิธีคิดดอกเบี้ยไม่ถูกต้อง');
  }
  const interestMode =
    input.interestMode === 'flat_total' ? 'flat_total'
    : input.interestMode === 'deduct_upfront' ? 'deduct_upfront'
    : 'per_installment';
  // สองโหมดที่ใช้อัตรา % และคำนวณตารางงวดให้เอง
  const rateMode = interestMode === 'flat_total' || interestMode === 'deduct_upfront';

  let interestPerInst = rateMode
    ? 0
    : assertNonNegative(input.interestPerInst, 'ดอกเบี้ยต่องวด');
  let installmentAmount = rateMode
    ? 0
    : assertNonNegative(input.installmentAmount, 'ค่างวด');
  let numInstallments = Number(input.numInstallments);

  if (type === 'daily24' && !numInstallments) numInstallments = 24;
  // ดอกลอยไม่มีจำนวนงวดตายตัว (ข้อ 18) — สร้างปฏิทินเก็บดอกล่วงหน้า 1 ปี
  // ถ้าลูกหนี้ยังส่งต่อหลังจากนั้นให้รียอด/ต่อสัญญา สัญญาปิดเมื่อต้นหมดเท่านั้น
  if (type === 'floating' && !numInstallments) numInstallments = 365;
  if (type === 'floating') installmentAmount = interestPerInst;
  if (!Number.isInteger(numInstallments) || numInstallments < 1 || numInstallments > 600) {
    throw new BusinessError('จำนวนงวดไม่ถูกต้อง');
  }

  // วันหยุดที่ประกาศไว้แล้ว (ทั้งระบบ + โซนของพนักงาน) — ตารางงวดใหม่ข้ามวันเหล่านี้
  // (สเปกข้อ 23: วันหยุดไม่สร้างงวด) วันหยุดเฉพาะสัญญาไม่มีทางมีอยู่ก่อนสัญญาเกิด
  const skipDates = await holidayDatesFor({
    employeeId: input.employeeId ?? null,
    fromDate: startDate,
  });

  // โหมดที่คิดจากอัตรา % — คำนวณยอดหนี้รวมและค่างวดจากอัตรา ก่อนถึงด่านตรวจค่างวด
  let interestRateBp = 0;

  if (rateMode) {
    if (type === 'floating') {
      throw new BusinessError('ดอกลอยยังไม่รองรับโหมดดอกเหมารวมหรือหักดอกก่อน');
    }
    interestRateBp = Math.round(Number(input.interestRateBp));
    if (!Number.isInteger(interestRateBp) || interestRateBp < 0 || interestRateBp > 100000) {
      throw new BusinessError('อัตราดอกเบี้ยไม่ถูกต้อง (0–1000%)');
    }
    const built =
      interestMode === 'flat_total'
        ? buildFlatSchedule({ type, startDate, numInstallments, principalAmount, interestRateBp, skipDates })
        : buildDeductUpfrontSchedule({ type, startDate, numInstallments, principalAmount, interestRateBp, skipDates });
    installmentAmount = built.installmentAmount;
    // เก็บดอกต่องวดไว้เป็นค่าอ้างอิงเท่านั้น ตารางงวดจริงใช้ค่าที่กระจายแล้วรายงวด
    // (หักดอกก่อน: งวดเป็นเงินต้นล้วน ค่านี้จึงเป็น 0)
    interestPerInst = built.rows[0].interest_due;
    if (installmentAmount <= 0) {
      throw new BusinessError('จำนวนงวดมากเกินไปจนค่างวดต่ำกว่า 1 บาท');
    }
  }

  if (installmentAmount <= 0) throw new BusinessError('ค่างวดต้องมากกว่า 0');

  // สเปกข้อ 18/21: "ดอกลอยไม่มีค่าทำสัญญา" — บังคับ 0 ไม่ว่าจะตั้งค่าระบบไว้เท่าไร
  const docFee =
    type === 'floating'
      ? 0
      : input.docFee === undefined || input.docFee === null
        ? await getSettingInt('doc_fee')
        : assertNonNegative(input.docFee, 'ค่าทำเอกสาร');
  // สเปกข้อ 11: "หักดอกก่อน → ไม่หักงวดแรก" — บังคับที่ระดับ domain
  // ไม่ว่าค่าตั้งต้นของระบบหรือผู้เรียกจะส่งอะไรมา
  const deductFirst =
    interestMode === 'deduct_upfront'
      ? false
      : input.deductFirst === undefined
        ? (await getSettingInt('deduct_first_installment')) === 1
        : Boolean(input.deductFirst);

  return {
    type,
    startDate,
    principalAmount,
    installmentAmount,
    interestPerInst,
    numInstallments,
    interestMode,
    interestRateBp,
    docFee,
    deductFirst,
    grossOut: input.grossOut,
    debtorId: input.debtorId,
    employeeId: input.employeeId ?? null,
    openedByEmployeeId: input.openedByEmployeeId ?? null,
    skipDates,
    note: input.note ?? null,
  };
}

/** เลขที่สัญญา: CT-YYYYMM-#### (ไม่ซ้ำ — ข้อ 14) */
async function newContractNo(dateStr) {
  const ym = dateStr.slice(0, 7).replace('-', '');
  const n = await nextCounter(`contract:${ym}`);
  return `CT-${ym}-${String(n).padStart(4, '0')}`;
}

/**
 * สร้างสัญญาใหม่ (SRS ข้อ 7) — ทำงานภายใน transaction เดียว
 * ผลข้างเคียงที่เกิดพร้อมกัน:
 *   1. ตารางงวด
 *   2. รายการรับชำระงวดแรก (ข้อ 14: ต้องปรากฏในประวัติรับชำระ)
 *   3. รายรับ "ค่าทำเอกสาร" แยกประเภท (ข้อ 14)
 *   4. รายจ่ายเงินปล่อยใหม่เป็นกระแสเงินสดออก (ข้อ 14)
 */
export async function createContract(input, ctx) {
  return await tx(() => createContractInTx(input, ctx));
}

export async function createContractInTx(input, ctx) {
  const preview = await previewContract(input);
  const debtor = await get(`SELECT * FROM debtors WHERE id = :id`, { id: input.debtorId });
  if (!debtor) throw new BusinessError('ไม่พบลูกหนี้');
  if (debtor.status === 'disabled') throw new BusinessError('ลูกหนี้รายนี้ถูกงดใช้งาน');

  const now = nowISO();
  const contractNo = input.contractNo || (await newContractNo(preview.startDate));

  const contractId = await insert(
    `INSERT INTO contracts
       (contract_no, debtor_id, employee_id, type, principal_amount, installment_amount,
        interest_per_inst, num_installments, period_unit, start_date, doc_fee,
        first_inst_deducted, cash_disbursed, principal_remaining,
        interest_mode, interest_rate_bp, total_due, opened_by_employee_id, status, note,
        created_by, created_at, updated_at)
     VALUES
       (:no, :debtor, :emp, :type, :principal, :inst, :interest, :n, :unit, :start, :fee,
        :first, :cash, :principal,
        :mode, :rate_bp, :total_due, :openedBy, 'active', :note, :uid, :now, :now)`,
    {
      no: contractNo,
      debtor: input.debtorId,
      emp: preview.employeeId ?? debtor.employee_id ?? null,
      // ค่าทำสัญญาเป็นของพนักงานผู้เปิดสัญญา (สเปกข้อ 21/29)
      // ไม่ระบุ = พนักงานผู้ดูแลลูกหนี้เป็นผู้เปิด
      openedBy: preview.openedByEmployeeId ?? preview.employeeId ?? debtor.employee_id ?? null,
      type: preview.type,
      principal: preview.principalAmount,
      inst: preview.installmentAmount,
      interest: preview.interestPerInst,
      n: preview.numInstallments,
      unit: CONTRACT_TYPES[preview.type].unit,
      start: preview.startDate,
      fee: preview.doc_fee,
      first: preview.first_installment,
      cash: preview.cash_to_customer,
      mode: preview.interestMode,
      rate_bp: preview.interestRateBp,
      total_due: preview.totals.total_due,
      note: preview.note,
      uid: ctx?.user?.id ?? null,
      now,
    },
  );

  for (const row of preview.schedule) {
    await run(
      `INSERT INTO installments (contract_id, seq, due_date, due_amount, interest_due, principal_due)
       VALUES (:cid, :seq, :due, :amt, :i, :p)`,
      {
        cid: contractId,
        seq: row.seq,
        due: row.due_date,
        amt: row.due_amount,
        i: row.interest_due,
        p: row.principal_due,
      },
    );
  }

  // 3) ค่าทำเอกสาร -> รายรับแยกประเภท
  if (preview.doc_fee > 0) {
    await run(
      `INSERT INTO income_entries (entry_date, category, amount, description, contract_id, debtor_id, created_by, created_at)
       VALUES (:d, 'doc_fee', :amt, :desc, :cid, :did, :uid, :now)`,
      {
        d: preview.startDate,
        amt: preview.doc_fee,
        desc: `ค่าทำเอกสารสัญญา ${contractNo}`,
        cid: contractId,
        did: input.debtorId,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );
  }

  // 3.5) ดอกหักก่อน -> รายรับ ณ วันเปิดสัญญา (สเปกข้อ 15: รับรู้ตั้งแต่เปิดสัญญา)
  //      เป็นเงินสดจริง เพราะถูกหักออกจากเงินที่จ่ายให้ลูกค้า (คู่กับรายจ่ายเงินปล่อยข้อ 4)
  if (preview.upfront_interest > 0) {
    await run(
      `INSERT INTO income_entries (entry_date, category, amount, description, contract_id, debtor_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :cid, :did, :uid, :now)`,
      {
        d: preview.startDate,
        cat: UPFRONT_INTEREST_CATEGORY,
        amt: preview.upfront_interest,
        desc: `ดอกเบี้ยหักก่อนของสัญญา ${contractNo} (หักจากเงินที่จ่ายให้ลูกค้า ณ วันเปิดสัญญา)`,
        cid: contractId,
        did: input.debtorId,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );
  }

  // 4) เงินปล่อยใหม่ -> กระแสเงินสดออก (บันทึกแบบยอดเต็ม แล้วรับดอกหักก่อน/ค่าทำเอกสาร/
  //    งวดแรกเป็นเงินเข้า เงินสดสุทธิจึงเท่ากับเงินที่จ่ายให้ลูกค้าจริง)
  if (preview.gross_out > 0) {
    await run(
      `INSERT INTO expenses (entry_date, category, amount, description, contract_id, employee_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :cid, :emp, :uid, :now)`,
      {
        d: preview.startDate,
        cat: DISBURSE_CATEGORY,
        amt: preview.gross_out,
        desc:
          `สัญญา ${contractNo} — จ่ายเงินสดให้ลูกค้าจริง ${formatBaht(preview.cash_to_customer)} บาท ` +
          `(หักดอกก่อน ${formatBaht(preview.upfront_interest)} ค่าทำเอกสาร ${formatBaht(preview.doc_fee)} ` +
          `และงวดแรก ${formatBaht(preview.first_installment)})`,
        cid: contractId,
        emp: preview.employeeId ?? debtor.employee_id ?? null,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );
  }

  // 2) งวดแรกถูกหัก ณ วันทำสัญญา -> บันทึกเป็นรายการชำระจริง พร้อมแยกต้น/ดอก
  let firstPayment = null;
  if (preview.first_installment > 0) {
    firstPayment = await recordFirstInstallment({ contractId, ctx });
  }

  const contract = await getContract(contractId);
  await audit({
    userId: ctx?.user?.id,
    action: 'create',
    entity: 'contract',
    entityId: contractId,
    after: contract,
    reason: input.reason ?? null,
    ip: ctx?.ip,
  });

  return { contract, preview, firstPayment };
}

/**
 * ยกเลิกสัญญาที่ "เปิดผิด" (backlog ข้อ 10)
 *
 * ล้างรายการอัตโนมัติที่ผูกกับสัญญาทั้งหมดแบบ "ไม่ลบถาวร" (void) เพื่อให้กระแสเงินสด/
 * รายได้/เงินต้นกลับไปเหมือนไม่เคยเปิดสัญญา:
 *   - เงินปล่อย (รายจ่าย DISBURSE) → void
 *   - ค่าทำเอกสาร (doc_fee) + ดอกหักก่อน (upfront) + ดอกรับรู้ตอนปิด/รียอด ฯลฯ (income) → void
 *   - รายการรับเงินทุกใบ (งวดแรกที่หัก ณ วันทำสัญญา + ที่เก็บมาจริง) → void
 *   - ล้างยอดชำระของงวดกลับเป็น pending, เงินต้นคงเหลือ = 0, สถานะ = 'cancelled'
 *
 * รายงานทุกตัวกรอง is_void = 0 และข้าม status = 'cancelled' อยู่แล้ว → ยอดกลับเข้าที่เอง
 *
 * กันพลาด:
 *   - สัญญาที่ถูกรียอด/เกิดจากการรียอด: ห้าม (ยอดผูกกับอีกสัญญา ย้อนแล้วเงินหายจากรายงาน)
 *   - รายการในวันที่ปิดยอดแล้ว: ต้องให้เจ้าของเป็นผู้ทำ (เหมือน voidPayment ข้อ 14/15)
 */
export async function cancelContract({ contractId, reason }, ctx) {
  return await tx(async () => {
    const contract = await get(`SELECT * FROM contracts WHERE id = :id`, { id: contractId });
    if (!contract) throw new BusinessError('ไม่พบสัญญา');
    if (contract.status === 'cancelled') throw new BusinessError('สัญญานี้ถูกยกเลิกไปแล้ว');
    if (contract.status === 'closed_reyod') {
      throw new BusinessError('สัญญานี้ถูกรียอดไปเป็นสัญญาใหม่แล้ว ยกเลิกไม่ได้ — จัดการที่สัญญาใหม่แทน');
    }
    if (!reason || !String(reason).trim()) throw new BusinessError('ต้องระบุเหตุผลการยกเลิกสัญญา');

    // สัญญาที่เชื่อมกับการรียอด (เป็นต้นทางหรือปลายทาง) — ห้ามยกเลิก
    const link = await get(
      `SELECT l.from_contract_id, l.to_contract_id,
              f.contract_no AS from_no, t.contract_no AS to_no
       FROM contract_links l
       JOIN contracts f ON f.id = l.from_contract_id
       JOIN contracts t ON t.id = l.to_contract_id
       WHERE l.from_contract_id = :id OR l.to_contract_id = :id
       LIMIT 1`,
      { id: contractId },
    );
    if (link) {
      const other = link.from_contract_id === contractId ? link.to_no : link.from_no;
      throw new BusinessError(
        `สัญญานี้เชื่อมกับการรียอด (คู่กับ ${other}) ยกเลิกไม่ได้ ` +
          'เพราะยอดที่ยกไป/มาคำนวณจากสัญญานี้ การย้อนกลับจะทำให้เงินต้นค้างบนสัญญาที่ปิดแล้วและหายจากรายงาน',
      );
    }

    const payments = await all(
      `SELECT id, paid_date FROM payments WHERE contract_id = :id AND is_void = 0`,
      { id: contractId },
    );

    // กันย้อนเงินในวันที่ปิดยอดแล้วโดยคนที่ไม่ใช่เจ้าของ (เหมือน voidPayment)
    const dates = new Set(payments.map((p) => p.paid_date));
    dates.add(contract.start_date); // วันจ่ายเงินปล่อย/ค่าเอกสาร/ดอกหักก่อน
    for (const d of dates) {
      const closing = await get(`SELECT id FROM daily_closings WHERE closing_date = :d`, { d });
      if (closing && ctx?.user?.role !== 'owner') {
        throw new BusinessError(
          `มีรายการของสัญญาอยู่ในวันที่ปิดยอดแล้ว (${d}) ต้องให้เจ้าของเป็นผู้ยกเลิกสัญญา`,
        );
      }
    }

    const now = nowISO();
    const voidReason = `ยกเลิกสัญญา ${contract.contract_no}: ${String(reason).trim()}`;

    // 1) void รายการรับเงินทุกใบ (งวดแรก + ที่เก็บมาจริง)
    await run(
      `UPDATE payments SET is_void = 1, void_reason = :r, voided_by = :uid, voided_at = :now
       WHERE contract_id = :id AND is_void = 0`,
      { id: contractId, r: voidReason, uid: ctx?.user?.id ?? null, now },
    );
    // 2) void รายรับที่ผูกกับสัญญา (ค่าเอกสาร/ดอกหักก่อน/ดอกปิด-รียอด/เงินต้นรับคืน ฯลฯ)
    await run(
      `UPDATE income_entries SET is_void = 1, void_reason = :r
       WHERE contract_id = :id AND is_void = 0`,
      { id: contractId, r: voidReason },
    );
    // 3) void รายจ่ายที่ผูกกับสัญญา (เงินปล่อย)
    await run(
      `UPDATE expenses SET is_void = 1, void_reason = :r
       WHERE contract_id = :id AND is_void = 0`,
      { id: contractId, r: voidReason },
    );
    // 4) ล้างงวด + ปิดสัญญาเป็น 'cancelled'
    await run(
      `UPDATE installments SET interest_paid = 0, principal_paid = 0, status = 'pending'
       WHERE contract_id = :id`,
      { id: contractId },
    );
    await run(
      `UPDATE contracts SET status = 'cancelled', principal_remaining = 0,
              closed_at = :now, updated_at = :now WHERE id = :id`,
      { id: contractId, now },
    );

    const after = await getContract(contractId);
    await audit({
      userId: ctx?.user?.id,
      action: 'cancel',
      entity: 'contract',
      entityId: contractId,
      before: contract,
      after,
      reason,
      ip: ctx?.ip,
    });
    return { contract: after, voided_payments: payments.length };
  });
}

export async function getContract(id) {
  return await get(
    `SELECT c.*, d.full_name AS debtor_name, d.code AS debtor_code, d.phone AS debtor_phone,
            e.full_name AS employee_name
     FROM contracts c
     JOIN debtors d ON d.id = c.debtor_id
     LEFT JOIN employees e ON e.id = c.employee_id
     WHERE c.id = :id`,
    { id },
  );
}

export async function getContractByNo(no) {
  const row = await get(`SELECT id FROM contracts WHERE contract_no = :no`, { no });
  return row ? await getContract(row.id) : null;
}

export async function listInstallments(contractId) {
  return await all(
    `SELECT * FROM installments WHERE contract_id = :cid ORDER BY seq`,
    { cid: contractId },
  );
}

/**
 * สรุปสถานะสัญญา (ใช้ในหน้ารับชำระและรายงาน)
 * - งวดปัจจุบัน, ยอดที่ควรจ่าย, ดอกเบี้ย/เงินต้นที่ควรตัด
 * - จำนวนงวดเต็มที่ชำระแล้ว และจำนวนวันที่จ่ายเฉพาะดอก (ข้อ 3.1)
 */
export async function contractSummary(contractId, asOfDate = today()) {
  const contract = await getContract(contractId);
  if (!contract) return null;
  const installments = await listInstallments(contractId);

  const current = installments.find(
    (i) => i.interest_paid < i.interest_due || i.principal_paid < i.principal_due,
  );

  const overdue = installments.filter(
    (i) =>
      i.due_date <= asOfDate &&
      (i.interest_paid < i.interest_due || i.principal_paid < i.principal_due),
  );
  const arrears = overdue.reduce(
    (s, i) => s + (i.due_amount - i.interest_paid - i.principal_paid),
    0,
  );

  const stats = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'full'          THEN 1 ELSE 0 END), 0) AS full_count,
       COALESCE(SUM(CASE WHEN status = 'interest_only' THEN 1 ELSE 0 END), 0) AS interest_only_count,
       COALESCE(SUM(CASE WHEN status = 'partial'       THEN 1 ELSE 0 END), 0) AS partial_count,
       COALESCE(SUM(amount_paid), 0)      AS total_paid,
       COALESCE(SUM(interest_amount), 0)  AS total_interest,
       COALESCE(SUM(principal_amount), 0) AS total_principal
     FROM payments WHERE contract_id = :cid AND is_void = 0`,
    { cid: contractId },
  );

  const dueRemaining = current
    ? current.due_amount - current.interest_paid - current.principal_paid
    : 0;

  return {
    contract,
    installments_total: installments.length,
    current_installment: current
      ? {
          seq: current.seq,
          due_date: current.due_date,
          due_amount: current.due_amount,
          due_remaining: dueRemaining,
          interest_remaining: current.interest_due - current.interest_paid,
          principal_remaining_this: current.principal_due - current.principal_paid,
        }
      : null,
    arrears_amount: arrears,
    arrears_installments: overdue.length,
    principal_remaining: contract.principal_remaining,
    paid_full_installments: Number(stats.full_count),
    interest_only_days: Number(stats.interest_only_count),
    partial_count: Number(stats.partial_count),
    total_paid: Number(stats.total_paid),
    total_interest_received: Number(stats.total_interest),
    total_principal_received: Number(stats.total_principal),
    is_closed: contract.status !== 'active',
  };
}

/**
 * ยอดหนี้รวมตามสัญญา — รองรับสัญญาที่สร้างก่อนมีคอลัมน์ total_due
 *
 * สัญญาเก่ามี total_due = 0 จึงต้องรวมจากตารางงวดแทน
 * ห้ามคืน 0 เฉย ๆ ไม่งั้นการรียอดจะคำนวณยอดคงเหลือติดลบ
 */
export async function contractTotalDue(contract) {
  if (contract.total_due > 0) return contract.total_due;
  const row = await get(
    `SELECT COALESCE(SUM(due_amount), 0) AS t FROM installments WHERE contract_id = :cid`,
    { cid: contract.id },
  );
  return Number(row?.t ?? 0);
}

/**
 * ยอดคงเหลือของสัญญา แยกตามวิธีคิดของแต่ละโหมด
 *
 * โหมดดอกเหมารวม (flat_total)
 *   "ยอดคงเหลือสัญญาเดิม" = ยอดหนี้รวมตามสัญญา − ยอดชำระสะสมทั้งหมด
 *   ยอดนี้มีทั้งเงินต้นและดอกเบี้ยเดิมรวมอยู่แล้ว จึงไม่เรียกว่า "เงินต้นคงเหลือ"
 *   ตามที่ผู้ใช้กำหนด: ไม่ต้องตัดดอกเบี้ยที่ยังไม่ถึงงวดออก
 *
 * โหมดเดิม (per_installment)
 *   ใช้เงินต้นคงเหลือเหมือนเดิม เพื่อไม่ให้สัญญาที่มีอยู่แล้วเปลี่ยนพฤติกรรม
 */
export async function contractOutstanding(contract) {
  const paid = await get(
    `SELECT COALESCE(SUM(amount_paid), 0) AS p, COALESCE(SUM(interest_amount), 0) AS i
     FROM payments WHERE contract_id = :cid AND is_void = 0`,
    { cid: contract.id },
  );
  const totalPaid = Number(paid?.p ?? 0);
  const interestPaid = Number(paid?.i ?? 0);

  // โหมดหักดอกก่อน: ดอกรับรู้ไปแล้ววันเปิดสัญญา ยอดคงเหลือจึงเป็นเงินต้นล้วน
  // ยกยอดตามสัญญา (ยอดสัญญา − ชำระสะสม) ไม่มีดอกค้างรับรู้ปนอยู่
  if (contract.interest_mode === 'deduct_upfront') {
    const due = await contractTotalDue(contract);
    const carry = Math.max(0, due - totalPaid);
    return {
      mode: 'deduct_upfront',
      carry,
      total_due: due,
      total_paid: totalPaid,
      principal_part: carry,
      interest_part: 0,
    };
  }

  if (contract.interest_mode !== 'flat_total') {
    return {
      mode: 'per_installment',
      carry: contract.principal_remaining,
      total_due: await contractTotalDue(contract),
      total_paid: totalPaid,
      principal_part: contract.principal_remaining,
      interest_part: 0,
    };
  }

  const totalDue = await contractTotalDue(contract);
  const carry = Math.max(0, totalDue - totalPaid);
  // แยกว่าในยอดที่ยกไปนั้นเป็นเงินต้นเท่าไร เป็นดอกที่ยังไม่ได้รับรู้เท่าไร
  // ไม่ได้เอาไปใช้คำนวณยอดยก (ผู้ใช้กำหนดว่าไม่ต้องแยก) แต่ต้องรู้เพื่อให้บัญชีถูก
  const interestTotal = Math.max(0, totalDue - contract.principal_amount);
  const interestUnearned = Math.max(0, interestTotal - interestPaid);
  return {
    mode: 'flat_total',
    carry,
    total_due: totalDue,
    total_paid: totalPaid,
    principal_part: Math.max(0, carry - interestUnearned),
    interest_part: Math.min(carry, interestUnearned),
  };
}

/** ป้ายสถานะลูกหนี้จากพฤติกรรมการชำระ (ใช้ใน Dashboard ข้อ 5) */
export async function contractBehaviour(contractId, asOfDate = today()) {
  const s = await contractSummary(contractId, asOfDate);
  if (!s) return 'unknown';
  if (s.contract.status === 'completed') return 'completed';
  if (s.contract.status === 'closed_reyod') return 'reyod';
  if (s.contract.status === 'cancelled') return 'cancelled';
  const threshold = (await getSettingInt('overdue_days_threshold')) || 3;
  if (s.arrears_installments >= threshold) return 'overdue';
  const last = await get(
    `SELECT status FROM payments WHERE contract_id = :cid AND is_void = 0
     ORDER BY paid_date DESC, id DESC LIMIT 1`,
    { cid: contractId },
  );
  if (last?.status === 'interest_only') return 'interest_only';
  if (last?.status === 'partial') return 'partial';
  return 'normal';
}

/**
 * รียอด / ทำสัญญาใหม่ (SRS ข้อ 9)
 * ยอดสัญญาใหม่ = เงินต้นคงเหลือเดิม + เงินเพิ่มใหม่
 * สัญญาเดิมปิดด้วยสถานะ "ปิดด้วยการรียอด" โดยไม่ลบข้อมูล และเชื่อมโยงกับสัญญาใหม่
 */
export async function reyod(input, ctx) {
  return await tx(async () => {
    const old = await getContract(input.fromContractId);
    if (!old) throw new BusinessError('ไม่พบสัญญาเดิม');
    if (old.status !== 'active') throw new BusinessError('สัญญาเดิมถูกปิดไปแล้ว');

    // การรียอดสร้างรายการเงินและรายได้ จึงต้องติดด่านเดียวกับการรับชำระ
    // ไม่งั้นตัวเลขของวันที่ปิดบัญชีไปแล้วจะเปลี่ยนย้อนหลังได้เงียบ ๆ
    const reyodDate = input.startDate ?? today();
    const closed = await get(`SELECT * FROM daily_closings WHERE closing_date = :d`, { d: reyodDate });
    if (closed && !(ctx?.user?.role === 'owner' && input.ownerOverride === true)) {
      throw new BusinessError(
        `วันที่ ${reyodDate} ปิดยอดประจำวันแล้ว การรียอดย้อนหลังต้องได้รับอนุมัติจากเจ้าของ`,
      );
    }

    const newMoney = assertNonNegative(input.newMoney ?? 0, 'เงินเพิ่มใหม่');
    const out = await contractOutstanding(old);
    const carried = out.carry;
    const newPrincipal = carried + newMoney;
    if (newPrincipal <= 0) throw new BusinessError('ยอดสัญญาใหม่ต้องมากกว่า 0');

    // ฐานการคำนวณเงินสดที่จ่ายให้ลูกค้า (ตั้งค่าได้ — ข้อ 9)
    const basis = await getSetting('reyod_cash_basis');
    const grossOut = basis === 'full' ? newPrincipal : newMoney;

    const created = await createContractInTx(
      {
        debtorId: old.debtor_id,
        employeeId: input.employeeId ?? old.employee_id,
        type: input.type ?? old.type,
        principalAmount: newPrincipal,
        installmentAmount: input.installmentAmount ?? old.installment_amount,
        interestPerInst: input.interestPerInst ?? old.interest_per_inst,
        numInstallments: input.numInstallments ?? old.num_installments,
        startDate: input.startDate ?? today(),
        docFee: input.docFee,
        deductFirst: input.deductFirst,
        grossOut,
        // สืบทอดโหมดคิดดอกและอัตราจากสัญญาเดิม (เหตุผลเดียวกับใน reyodPreview)
        interestMode: input.interestMode ?? old.interest_mode ?? 'per_installment',
        interestRateBp: input.interestRateBp ?? old.interest_rate_bp ?? 0,
        // ค่าทำสัญญาของสัญญาใหม่เป็นของพนักงานผู้ทำรียอด (ระบุได้) ไม่งั้นตามสัญญาเดิม
        openedByEmployeeId:
          input.openedByEmployeeId ?? old.opened_by_employee_id ?? old.employee_id ?? null,
        note: input.note ?? `รียอดจากสัญญา ${old.contract_no}`,
      },
      ctx,
    );

    const now = nowISO();
    await run(
      `UPDATE contracts
         SET status = 'closed_reyod', closed_at = :now, principal_remaining = 0, updated_at = :now
       WHERE id = :id`,
      { id: old.id, now },
    );

    // ฐานเต็มยอด (basis='full'): รายจ่ายเงินปล่อยถูกบันทึกเต็มยอดสัญญาใหม่
    // แต่ส่วนของ "ยอดยก" ไม่ใช่เงินสดที่ออกไปจริง — ต้องบันทึกขารับคู่กัน
    // ไม่งั้นเงินสดในบัญชีจะหายเท่ากับยอดยกทุกครั้งที่รียอด
    // (เป็นเงินต้นรับคืน ไม่ใช่รายได้ — รายงานแยกหมวดนี้ออกจากกำไรอยู่แล้ว)
    const carryInDisbursement = grossOut - newMoney;
    if (carryInDisbursement > 0) {
      await run(
        `INSERT INTO income_entries
           (entry_date, category, amount, description, contract_id, debtor_id, created_by, created_at)
         VALUES (:d, :cat, :amt, :desc, :cid, :did, :uid, :now)`,
        {
          d: created.contract.start_date,
          cat: REYOD_CARRY_RETURN_CATEGORY,
          amt: carryInDisbursement,
          desc: `ยอดยกจากสัญญา ${old.contract_no} ที่ชำระด้วยสัญญาใหม่ (ขารับคู่ของเงินปล่อยฐานเต็มยอด)`,
          cid: old.id,
          did: old.debtor_id,
          uid: ctx?.user?.id ?? null,
          now,
        },
      );
    }
    // รับรู้ดอกเบี้ยของสัญญาเดิม เป็นรายได้ ณ วันที่รียอด
    //
    // สัญญาเหมารวม (สเปกข้อ 14/24): ระหว่างสัญญาไม่รับรู้ดอกเลย เงินรับเป็นแค่
    // "รับชำระตามสัญญา" — เมื่อรียอดจึงรับรู้ "ดอกตามสัญญาเดิมทั้งก้อน"
    // (ตัวอย่างสเปก: 2,000+400 ส่งแล้ว 1,000 → รียอด → รับรู้ดอก 400 เต็ม)
    //
    // โหมดดอกต่องวดแบบเดิม: ดอกของงวดที่จ่ายแล้วถูกรับรู้ต่อรายการรับไปแล้ว
    // จึงรับรู้เฉพาะส่วนที่ยังไม่ถึงงวด (out.interest_part) เหมือนเดิม
    //
    // ถ้าไม่รับรู้ตรงนี้ ดอกจะกลายเป็น "เงินต้น" ของสัญญาใหม่เฉย ๆ
    // แล้วหายไปจากรายงานกำไรตลอดกาล (เงินต้นรับคืนไม่นับเป็นรายได้)
    // หักดอกก่อน: ดอกรับรู้ไปแล้ววันเปิดสัญญา (สเปกข้อ 15) — ห้ามรับรู้ซ้ำตอนรียอด
    const recognizeAmt =
      old.interest_mode === 'deduct_upfront'
        ? 0
        : old.interest_mode === 'flat_total'
          ? Math.max(0, old.total_due - old.principal_amount)
          : out.interest_part;
    if (recognizeAmt > 0) {
      await run(
        `INSERT INTO income_entries
           (entry_date, category, amount, description, contract_id, debtor_id, created_by, created_at)
         VALUES (:d, :cat, :amt, :desc, :cid, :did, :uid, :now)`,
        {
          // ใช้วันเริ่มสัญญาใหม่ ไม่ใช่วันนี้ ไม่งั้นการรียอดย้อนหลัง
          // จะแตกเป็นสองวัน คนละงวดบัญชีกับรายการอื่นของการรียอดเดียวกัน
          d: created.contract.start_date,
          cat: REYOD_INTEREST_CATEGORY,
          amt: recognizeAmt,
          desc:
            old.interest_mode === 'flat_total'
              ? `ดอกเบี้ยตามสัญญา ${old.contract_no} รับรู้เมื่อรียอด`
              : `ดอกเบี้ยคงเหลือจากสัญญา ${old.contract_no} ที่ยกไปเป็นยอดตั้งต้นสัญญาใหม่`,
          cid: old.id,
          did: old.debtor_id,
          uid: ctx?.user?.id ?? null,
          now,
        },
      );
    }

    await run(
      `INSERT INTO contract_links
         (from_contract_id, to_contract_id, link_type, carried_principal, carried_interest,
          new_money, created_by, created_at)
       VALUES (:from, :to, 'reyod', :carriedPrincipal, :carriedInterest, :new, :uid, :now)`,
      {
        from: old.id,
        to: created.contract.id,
        carriedPrincipal: out.principal_part,
        carriedInterest: out.interest_part,
        new: newMoney,
        uid: ctx?.user?.id ?? null,
        now,
      },
    );

    await audit({
      userId: ctx?.user?.id,
      action: 'reyod',
      entity: 'contract',
      entityId: old.id,
      before: { status: old.status, principal_remaining: carried },
      after: {
        status: 'closed_reyod',
        new_contract_id: created.contract.id,
        new_contract_no: created.contract.contract_no,
        carried_principal: carried,
        new_money: newMoney,
        new_principal: newPrincipal,
      },
      reason: input.reason ?? null,
      ip: ctx?.ip,
    });

    return {
      old_contract: await getContract(old.id),
      new_contract: created.contract,
      preview: created.preview,
      // ยอดที่ยกไปมีทั้งเงินต้นและดอกเบี้ยเดิมรวมอยู่ จึงเรียกว่ายอดคงเหลือสัญญาเดิม
      carried_outstanding: carried,
      carried_principal_part: out.principal_part,
      carried_interest_part: out.interest_part,
      // ชื่อเดิม เก็บไว้ไม่ให้หน้าจอเก่าพัง
      carried_principal: carried,
      new_money: newMoney,
    };
  });
}

/** ตัวอย่างตัวเลขก่อนยืนยันรียอด (ข้อ 9) */
export async function reyodPreview(input) {
  const old = await getContract(input.fromContractId);
  if (!old) throw new BusinessError('ไม่พบสัญญาเดิม');
  const summary = await contractSummary(old.id);
  const newMoney = assertNonNegative(input.newMoney ?? 0, 'เงินเพิ่มใหม่');
  const out = await contractOutstanding(old);
  const carried = out.carry;
  const basis = await getSetting('reyod_cash_basis');
  const grossOut = basis === 'full' ? carried + newMoney : newMoney;

  // สืบทอดโหมดคิดดอกจากสัญญาเดิม ถ้าไม่ได้ระบุมาใหม่
  //
  // สำคัญมาก: ถ้าไม่สืบทอด สัญญาที่รียอดจากสัญญาโหมดดอกเหมารวม
  // จะถอยกลับไปโหมดเดิมเงียบ ๆ แล้วเอา interest_per_inst ที่กระจายแล้ว
  // (เช่น 16.67 บาท) ไปใช้เป็นดอกต่องวดของสัญญาใหม่ ซึ่งผิดทั้งยอดและเจตนา
  const inheritedMode = input.interestMode ?? old.interest_mode ?? 'per_installment';
  const inheritedRateBp = input.interestRateBp ?? old.interest_rate_bp ?? 0;

  const preview = await previewContract({
    debtorId: old.debtor_id,
    type: input.type ?? old.type,
    principalAmount: carried + newMoney,
    installmentAmount: input.installmentAmount ?? old.installment_amount,
    interestPerInst: input.interestPerInst ?? old.interest_per_inst,
    numInstallments: input.numInstallments ?? old.num_installments,
    startDate: input.startDate ?? today(),
    docFee: input.docFee,
    deductFirst: input.deductFirst,
    grossOut,
    interestMode: inheritedMode,
    interestRateBp: inheritedRateBp,
  });

  return {
    old_contract: old,
    old_summary: summary,
    // ชื่อนี้สำคัญ: ยอดที่ยกไปมีทั้งเงินต้นและดอกเบี้ยเดิมรวมอยู่แล้ว
    // จึงไม่ใช่ "เงินต้นคงเหลือ" ตามที่ผู้ใช้ระบุไว้ชัดเจน
    carried_outstanding: carried,
    outstanding_detail: out,
    // เก็บชื่อเดิมไว้ด้วยเพื่อไม่ให้หน้าจอเก่าพัง
    carried_principal: carried,
    // โหมดเดิมแสดง "เงินต้นที่ตัดแล้ว" ส่วนโหมดเหมารวมแสดง "ชำระมาแล้วทั้งหมด"
    // เพราะสองโหมดยกยอดคนละแบบ ตัวเลขที่มีความหมายจึงต่างกัน
    principal_paid_before:
      out.mode === 'flat_total' ? out.total_paid : old.principal_amount - out.carry,
    new_money: newMoney,
    cash_basis: basis,
    preview,
  };
}

/** ประวัติการรียอดของสัญญา (ข้อ 16) */
export async function contractChain(contractId) {
  const chain = [];
  let cursor = contractId;
  // ย้อนกลับไปหาต้นสาย
  for (;;) {
    const link = await get(
      `SELECT * FROM contract_links WHERE to_contract_id = :id`,
      { id: cursor },
    );
    if (!link) break;
    cursor = link.from_contract_id;
  }
  // เดินหน้าไล่ลูกโซ่
  for (;;) {
    const c = await getContract(cursor);
    if (!c) break;
    chain.push(c);
    const link = await get(
      `SELECT * FROM contract_links WHERE from_contract_id = :id`,
      { id: cursor },
    );
    if (!link) break;
    cursor = link.to_contract_id;
  }
  return chain;
}
