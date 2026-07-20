import { all, get, run, insert, tx, nextCounter } from '../db/index.js';
import { nowISO, today, isDateStr, addDays, addMonths } from '../lib/time.js';
import { audit } from '../lib/audit.js';
import { buildSchedule, CONTRACT_TYPES } from './contracts.js';

/**
 * ระบบนำเข้าข้อมูลเริ่มต้นจาก Excel (SRS ข้อ 19)
 *
 * หลักการสำคัญ: ข้อมูลที่นำเข้าคือ "ยอดยกมา" ของสัญญาที่เดินอยู่แล้วก่อนใช้ระบบนี้
 * จึงต้อง **ไม่** สร้างรายการเงินสดย้อนหลัง (ค่าทำเอกสาร เงินปล่อยใหม่ งวดแรก)
 * เพราะเงินก้อนนั้นเคลื่อนไหวไปก่อนแล้ว ถ้าบันทึกซ้ำจะทำให้กำไรและกระแสเงินสดผิด
 *
 * สิ่งที่นำเข้าสร้างให้: ลูกหนี้ + สัญญา + ตารางงวด + ยอดที่ชำระมาแล้ว
 */

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ---- นิยามคอลัมน์ -------------------------------------------------------------

/** ชื่อหัวคอลัมน์ที่ระบบเดาให้อัตโนมัติ (ไทย/อังกฤษ) */
export const FIELDS = {
  debtors: [
    { key: 'debtor_code', label: 'รหัสลูกหนี้', aliases: ['รหัสลูกหนี้', 'รหัส', 'code', 'id'] },
    { key: 'debtor_name', label: 'ชื่อ-นามสกุล', required: true, aliases: ['ชื่อ-นามสกุล', 'ชื่อ', 'ชื่อลูกหนี้', 'ชื่อลูกค้า', 'name', 'fullname'] },
    { key: 'phone', label: 'เบอร์โทร', aliases: ['เบอร์โทร', 'เบอร์', 'โทร', 'โทรศัพท์', 'phone', 'tel', 'mobile'] },
    { key: 'address', label: 'ที่อยู่', aliases: ['ที่อยู่', 'address'] },
    { key: 'area', label: 'พื้นที่/สาย', aliases: ['พื้นที่', 'สาย', 'เส้นทาง', 'โซน', 'กลุ่ม', 'area', 'route'] },
    { key: 'employee_code', label: 'รหัส/ชื่อพนักงานผู้ดูแล', aliases: ['พนักงาน', 'ผู้ดูแล', 'คนเก็บ', 'employee', 'staff'] },
    { key: 'note', label: 'หมายเหตุ', aliases: ['หมายเหตุ', 'note', 'remark'] },
  ],
  contracts: [
    { key: 'debtor_code', label: 'รหัสลูกหนี้', aliases: ['รหัสลูกหนี้', 'รหัส', 'code'] },
    { key: 'debtor_name', label: 'ชื่อ-นามสกุล', required: true, aliases: ['ชื่อ-นามสกุล', 'ชื่อ', 'ชื่อลูกหนี้', 'ชื่อลูกค้า', 'name'] },
    { key: 'phone', label: 'เบอร์โทร', aliases: ['เบอร์โทร', 'เบอร์', 'โทร', 'phone', 'tel'] },
    { key: 'address', label: 'ที่อยู่', aliases: ['ที่อยู่', 'address'] },
    { key: 'employee_code', label: 'พนักงานผู้ดูแล', aliases: ['พนักงาน', 'ผู้ดูแล', 'คนเก็บ', 'employee'] },
    { key: 'contract_no', label: 'เลขที่สัญญา', aliases: ['เลขที่สัญญา', 'เลขสัญญา', 'contract', 'contractno'] },
    { key: 'type', label: 'ประเภทสัญญา', aliases: ['ประเภท', 'ประเภทสัญญา', 'แบบ', 'type'] },
    { key: 'principal_amount', label: 'เงินต้นตามสัญญา', required: true, aliases: ['เงินต้น', 'เงินต้นตามสัญญา', 'ยอดกู้', 'ยอดจัด', 'วงเงิน', 'principal'] },
    { key: 'installment_amount', label: 'ค่างวด', required: true, aliases: ['ค่างวด', 'งวดละ', 'ยอดผ่อน', 'installment'] },
    { key: 'interest_per_inst', label: 'ดอกเบี้ยต่องวด', required: true, aliases: ['ดอกเบี้ย', 'ดอก', 'ดอกเบี้ยต่องวด', 'ดอกต่องวด', 'interest'] },
    { key: 'num_installments', label: 'จำนวนงวด', aliases: ['จำนวนงวด', 'งวด', 'จำนวน', 'periods', 'terms'] },
    { key: 'start_date', label: 'วันเริ่มสัญญา', aliases: ['วันเริ่มสัญญา', 'วันเริ่ม', 'วันที่ทำสัญญา', 'วันทำสัญญา', 'startdate', 'date'] },
    { key: 'principal_remaining', label: 'เงินต้นคงเหลือ (ยอดยกมา)', aliases: ['เงินต้นคงเหลือ', 'คงเหลือ', 'ยอดคงเหลือ', 'ยอดยกมา', 'remaining', 'balance'] },
    { key: 'paid_installments', label: 'จำนวนงวดที่ชำระแล้ว', aliases: ['งวดที่ชำระแล้ว', 'ชำระแล้ว', 'ส่งแล้ว', 'จ่ายแล้ว', 'paid'] },
    { key: 'note', label: 'หมายเหตุ', aliases: ['หมายเหตุ', 'note', 'remark'] },
  ],
};

/** ทำให้ชื่อหัวคอลัมน์เทียบกันได้ (ตัดช่องว่าง เครื่องหมาย และตัวพิมพ์) */
function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[\s_\-.()/:]/g, '')
    .replace(/\(บาท\)|บาท|฿/g, '')
    .trim();
}

/** เดาการจับคู่คอลัมน์จากหัวตาราง */
export function guessMapping(headers, kind) {
  const fields = FIELDS[kind];
  const mapping = {};
  const used = new Set();

  for (const field of fields) {
    const targets = [field.key, field.label, ...field.aliases].map(normalizeHeader);
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      const h = normalizeHeader(headers[i]);
      if (!h) continue;
      // ตรงเป๊ะก่อน แล้วจึงยอมให้เป็นคำที่มีอยู่ในหัวคอลัมน์
      if (targets.includes(h) || targets.some((t) => t.length >= 3 && h.includes(t))) {
        mapping[field.key] = i;
        used.add(i);
        break;
      }
    }
  }
  return mapping;
}

// ---- แปลงค่า ------------------------------------------------------------------

/** แปลงข้อความจำนวนเงินเป็นสตางค์ รองรับ "1,000.50", "฿1,000", "1 000" */
export function parseMoney(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[฿,\s]/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function parseCount(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[,\s]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

/**
 * แปลงวันที่ รองรับ YYYY-MM-DD, DD/MM/YYYY และปี พ.ศ.
 * ปีที่มากกว่า 2400 ถือว่าเป็น พ.ศ. แล้วแปลงเป็น ค.ศ. ให้อัตโนมัติ
 */
export function parseDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;

  const toISO = (y, m, d) => {
    let year = Number(y);
    if (year > 2400) year -= 543; // พ.ศ. -> ค.ศ.
    if (year < 100) year += year > 50 ? 1900 : 2000;
    const mm = String(Number(m)).padStart(2, '0');
    const dd = String(Number(d)).padStart(2, '0');
    const iso = `${year}-${mm}-${dd}`;
    if (!isDateStr(iso)) return NaN;
    const dt = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== Number(d)) return NaN;
    return iso;
  };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return toISO(m[1], m[2], m[3]);

  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) return toISO(m[3], m[2], m[1]); // วัน/เดือน/ปี ตามรูปแบบไทย

  return NaN;
}

// ---- ตรวจสอบข้อมูลทีละแถว ------------------------------------------------------

const TYPE_ALIASES = {
  daily24: ['daily24', 'รายวัน', 'รายวัน24งวด', 'วัน', 'daily', 'day'],
  monthly: ['monthly', 'รายเดือน', 'เดือน', 'month'],
  floating: ['floating', 'ดอกลอย', 'ลอย', 'จ่ายแต่ดอก', 'ดอก'],
};

function parseType(value, fallback = 'daily24') {
  const s = normalizeHeader(value);
  if (!s) return fallback;
  for (const [key, aliases] of Object.entries(TYPE_ALIASES)) {
    if (aliases.some((a) => normalizeHeader(a) === s)) return key;
  }
  for (const [key, aliases] of Object.entries(TYPE_ALIASES)) {
    if (aliases.some((a) => s.includes(normalizeHeader(a)))) return key;
  }
  return null;
}

/** ตรวจสอบและแปลงข้อมูลหนึ่งแถว คืน { data, errors } */
function validateRow(raw, kind, options) {
  const errors = [];
  const d = {};
  const pick = (k) => (raw[k] === undefined ? '' : String(raw[k]).trim());

  d.debtor_name = pick('debtor_name');
  if (!d.debtor_name) errors.push('ไม่มีชื่อลูกหนี้');

  d.debtor_code = pick('debtor_code') || null;
  d.phone = pick('phone') || null;
  d.address = pick('address') || null;
  d.area = pick('area') || null;
  d.employee_code = pick('employee_code') || null;
  d.note = pick('note') || null;

  if (kind === 'debtors') return { data: d, errors };

  // ---- สัญญา ----
  d.contract_no = pick('contract_no') || null;

  d.type = parseType(pick('type'), options.defaultType);
  if (d.type === null) {
    errors.push(`ประเภทสัญญา "${pick('type')}" ไม่รู้จัก (ใช้ได้: รายวัน / รายเดือน / ดอกลอย)`);
    d.type = options.defaultType;
  }

  d.principal_amount = parseMoney(pick('principal_amount'));
  if (d.principal_amount === null) errors.push('ไม่มีเงินต้น');
  else if (Number.isNaN(d.principal_amount)) errors.push('เงินต้นไม่ใช่ตัวเลข');
  else if (d.principal_amount <= 0) errors.push('เงินต้นต้องมากกว่า 0');

  d.interest_per_inst = parseMoney(pick('interest_per_inst'));
  if (d.interest_per_inst === null) d.interest_per_inst = 0;
  else if (Number.isNaN(d.interest_per_inst)) errors.push('ดอกเบี้ยต่องวดไม่ใช่ตัวเลข');
  else if (d.interest_per_inst < 0) errors.push('ดอกเบี้ยต้องไม่ติดลบ');

  d.installment_amount = parseMoney(pick('installment_amount'));
  if (d.type === 'floating') {
    d.installment_amount = d.interest_per_inst;
  } else if (d.installment_amount === null) {
    errors.push('ไม่มีค่างวด');
  } else if (Number.isNaN(d.installment_amount)) {
    errors.push('ค่างวดไม่ใช่ตัวเลข');
  } else if (d.installment_amount <= 0) {
    errors.push('ค่างวดต้องมากกว่า 0');
  } else if (d.installment_amount <= d.interest_per_inst) {
    errors.push('ค่างวดต้องมากกว่าดอกเบี้ยต่องวด มิฉะนั้นเงินต้นจะไม่ลดเลย');
  }

  d.num_installments = parseCount(pick('num_installments'));
  if (d.num_installments === null) {
    d.num_installments = d.type === 'daily24' ? 24 : options.defaultPeriods;
  } else if (Number.isNaN(d.num_installments) || d.num_installments < 1 || d.num_installments > 600) {
    errors.push('จำนวนงวดไม่ถูกต้อง (1-600)');
    d.num_installments = 24;
  }

  const startDate = parseDate(pick('start_date'));
  if (startDate === null) d.start_date = options.defaultStartDate;
  else if (Number.isNaN(startDate)) {
    errors.push(`วันเริ่มสัญญา "${pick('start_date')}" อ่านไม่ออก (ใช้ YYYY-MM-DD หรือ วว/ดด/ปปปป)`);
    d.start_date = options.defaultStartDate;
  } else d.start_date = startDate;

  // ยอดยกมา — ถ้าไม่ระบุถือว่ายังไม่ได้ผ่อนเลย
  const remaining = parseMoney(pick('principal_remaining'));
  if (remaining === null) d.principal_remaining = d.principal_amount;
  else if (Number.isNaN(remaining)) {
    errors.push('เงินต้นคงเหลือไม่ใช่ตัวเลข');
    d.principal_remaining = d.principal_amount;
  } else if (remaining < 0) {
    errors.push('เงินต้นคงเหลือต้องไม่ติดลบ');
    d.principal_remaining = 0;
  } else if (d.principal_amount && remaining > d.principal_amount) {
    errors.push('เงินต้นคงเหลือมากกว่าเงินต้นตามสัญญา');
    d.principal_remaining = d.principal_amount;
  } else d.principal_remaining = remaining;

  const paid = parseCount(pick('paid_installments'));
  if (paid === null) d.paid_installments = null;
  else if (Number.isNaN(paid) || paid < 0) {
    errors.push('จำนวนงวดที่ชำระแล้วไม่ถูกต้อง');
    d.paid_installments = 0;
  } else if (paid > d.num_installments) {
    errors.push('งวดที่ชำระแล้วมากกว่าจำนวนงวดทั้งหมด');
    d.paid_installments = d.num_installments;
  } else d.paid_installments = paid;

  return { data: d, errors };
}

// ---- ขั้นตรวจก่อนนำเข้า (dry run) ------------------------------------------------

const DEFAULT_OPTIONS = {
  defaultType: 'daily24',
  defaultPeriods: 24,
  defaultStartDate: null, // ถ้าไม่ระบุจะใช้วันนี้
};

function withDefaults(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    defaultStartDate: options.defaultStartDate || today(),
  };
}

/**
 * ตรวจสอบข้อมูลทั้งไฟล์โดยไม่บันทึกอะไร
 * คืนผลรายแถวพร้อมข้อผิดพลาด เพื่อให้ผู้ใช้แก้ไฟล์ก่อนนำเข้าจริง
 */
export async function dryRun({ rows, mapping, kind, options }) {
  const opts = withDefaults(options);
  const results = [];
  const seenCodes = new Set();
  const seenContractNos = new Set();

  let okCount = 0;
  let errorCount = 0;
  let newDebtors = 0;
  let existingDebtors = 0;
  let totalPrincipal = 0;
  let totalRemaining = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = {};
    for (const [field, colIdx] of Object.entries(mapping)) {
      if (colIdx === null || colIdx === undefined || colIdx === '') continue;
      raw[field] = rows[i][Number(colIdx)] ?? '';
    }

    // ข้ามแถวว่างทั้งแถว
    if (Object.values(raw).every((v) => String(v ?? '').trim() === '')) continue;

    const { data, errors } = validateRow(raw, kind, opts);

    // ตรวจซ้ำภายในไฟล์เอง
    if (data.debtor_code) {
      if (seenCodes.has(data.debtor_code)) errors.push(`รหัสลูกหนี้ ${data.debtor_code} ซ้ำในไฟล์`);
      seenCodes.add(data.debtor_code);
    }
    if (data.contract_no) {
      if (seenContractNos.has(data.contract_no)) {
        errors.push(`เลขที่สัญญา ${data.contract_no} ซ้ำในไฟล์`);
      }
      seenContractNos.add(data.contract_no);
    }

    // ตรวจซ้ำกับข้อมูลที่มีอยู่แล้ว
    let existing = null;
    if (data.debtor_code) {
      existing = await get(`SELECT id, full_name FROM debtors WHERE code = :c`, {
        c: data.debtor_code,
      });
    }
    if (!existing && data.phone) {
      existing = await get(
        `SELECT id, full_name FROM debtors WHERE phone = :p AND full_name = :n`,
        { p: data.phone, n: data.debtor_name },
      );
    }
    if (existing) existingDebtors++;
    else newDebtors++;

    if (data.contract_no) {
      const dup = await get(`SELECT id FROM contracts WHERE contract_no = :no`, {
        no: data.contract_no,
      });
      if (dup) errors.push(`เลขที่สัญญา ${data.contract_no} มีอยู่ในระบบแล้ว`);
    }

    if (data.employee_code) {
      const emp = await findEmployee(data.employee_code);
      if (!emp) errors.push(`ไม่พบพนักงาน "${data.employee_code}" (จะนำเข้าโดยไม่ระบุผู้ดูแล)`);
    }

    if (errors.length) errorCount++;
    else {
      okCount++;
      if (kind === 'contracts') {
        totalPrincipal += data.principal_amount ?? 0;
        totalRemaining += data.principal_remaining ?? 0;
      }
    }

    results.push({
      row_number: i + 1,
      data,
      errors,
      existing_debtor: existing ? { id: existing.id, name: existing.full_name } : null,
    });
  }

  return {
    kind,
    total_rows: results.length,
    ok_count: okCount,
    error_count: errorCount,
    new_debtors: newDebtors,
    existing_debtors: existingDebtors,
    total_principal: totalPrincipal,
    total_remaining: totalRemaining,
    rows: results,
  };
}

async function findEmployee(codeOrName) {
  return await get(
    `SELECT * FROM employees WHERE code = :v OR full_name = :v LIMIT 1`,
    { v: String(codeOrName).trim() },
  );
}

// ---- นำเข้าจริง ---------------------------------------------------------------

/**
 * นำเข้าข้อมูลจริง — ทำใน transaction เดียว ถ้ามีแถวใดพังจะย้อนกลับทั้งหมด
 * แถวที่มีข้อผิดพลาดจะถูกข้าม (ไม่ทำให้ทั้งไฟล์ล้มเหลว)
 */
export async function commitImport({ rows, mapping, kind, options }, ctx) {
  const preview = await dryRun({ rows, mapping, kind, options });
  const opts = withDefaults(options);

  return await tx(async () => {
    const summary = {
      kind,
      debtors_created: 0,
      debtors_reused: 0,
      contracts_created: 0,
      skipped: 0,
      errors: [],
    };

    for (const row of preview.rows) {
      if (row.errors.length) {
        summary.skipped++;
        summary.errors.push({ row_number: row.row_number, errors: row.errors });
        continue;
      }

      const d = row.data;
      const employee = d.employee_code ? await findEmployee(d.employee_code) : null;

      // 1) ลูกหนี้ — ใช้ของเดิมถ้ามี
      let debtorId = row.existing_debtor?.id ?? null;
      if (!debtorId) {
        const code = d.debtor_code || (await nextFreeCode());
        debtorId = await insert(
          `INSERT INTO debtors (code, full_name, phone, address, note, employee_id, area, status, created_at, updated_at)
           VALUES (:code, :name, :phone, :addr, :note, :emp, :area, 'normal', :now, :now)`,
          {
            code,
            name: d.debtor_name,
            phone: d.phone,
            addr: d.address,
            note: d.note,
            emp: employee?.id ?? null,
            area: d.area,
            now: nowISO(),
          },
        );
        summary.debtors_created++;
      } else {
        summary.debtors_reused++;
      }

      if (kind === 'debtors') continue;

      // 2) สัญญา + ตารางงวด (ยอดยกมา ไม่สร้างรายการเงินสดย้อนหลัง)
      await createImportedContract({ data: d, debtorId, employeeId: employee?.id ?? null }, ctx);
      summary.contracts_created++;
    }

    await audit({
      userId: ctx?.user?.id,
      action: 'import',
      entity: 'import',
      entityId: nowISO(),
      after: summary,
      reason: options?.reason ?? `นำเข้าข้อมูลจากไฟล์ (${kind})`,
      ip: ctx?.ip,
    });

    return summary;
  });
}

async function nextFreeCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = `D${String(await nextCounter('debtor')).padStart(5, '0')}`;
    if (!(await get(`SELECT id FROM debtors WHERE code = :c`, { c: code }))) return code;
  }
  throw new ImportError('ออกรหัสลูกหนี้อัตโนมัติไม่สำเร็จ');
}

/**
 * สร้างสัญญาจากข้อมูลนำเข้า
 *
 * ต่างจากการสร้างสัญญาปกติตรงที่ **ไม่** สร้าง
 *   - รายรับค่าทำเอกสาร
 *   - รายจ่ายเงินปล่อยใหม่
 *   - รายการรับชำระงวดแรก
 * เพราะเงินเหล่านั้นเคลื่อนไหวไปแล้วก่อนเริ่มใช้ระบบ
 * บันทึกซ้ำจะทำให้รายงานกำไรและกระแสเงินสดของงวดปัจจุบันผิด
 */
async function createImportedContract({ data: d, debtorId, employeeId }, ctx) {
  const now = nowISO();
  const contractNo = d.contract_no || (await nextFreeContractNo(d.start_date));

  const schedule = buildSchedule({
    type: d.type,
    startDate: d.start_date,
    numInstallments: d.num_installments,
    installmentAmount: d.installment_amount,
    interestPerInst: d.interest_per_inst,
    principalAmount: d.principal_amount,
  });

  // ชำระครบแล้วทั้งเงินต้นและทุกงวด -> ปิดสัญญา
  const fullyPaid = d.principal_remaining === 0;

  const contractId = await insert(
    `INSERT INTO contracts
       (contract_no, debtor_id, employee_id, type, principal_amount, installment_amount,
        interest_per_inst, num_installments, period_unit, start_date, doc_fee,
        first_inst_deducted, cash_disbursed, principal_remaining, status, note,
        created_by, created_at, updated_at)
     VALUES
       (:no, :debtor, :emp, :type, :principal, :inst, :interest, :n, :unit, :start, 0,
        0, 0, :remaining, :status, :note, :uid, :now, :now)`,
    {
      no: contractNo,
      debtor: debtorId,
      emp: employeeId,
      type: d.type,
      principal: d.principal_amount,
      inst: d.installment_amount,
      interest: d.interest_per_inst,
      n: d.num_installments,
      unit: CONTRACT_TYPES[d.type].unit,
      start: d.start_date,
      remaining: d.principal_remaining,
      status: fullyPaid ? 'completed' : 'active',
      note: [d.note, 'นำเข้าจากไฟล์ (ยอดยกมา)'].filter(Boolean).join(' · '),
      uid: ctx?.user?.id ?? null,
      now,
    },
  );

  // เงินต้นที่ชำระมาแล้วตามยอดยกมา
  let principalSettled = d.principal_amount - d.principal_remaining;

  // ถ้าระบุจำนวนงวดที่ชำระแล้ว ให้ปิดงวดต้น ๆ ตามนั้น มิฉะนั้นไล่ปิดตามเงินต้นที่หายไป
  const paidTarget = d.paid_installments;

  for (let i = 0; i < schedule.length; i++) {
    const row = schedule[i];
    let interestPaid = 0;
    let principalPaid = 0;
    let status = 'pending';

    const withinPaidCount = paidTarget !== null && i < paidTarget;

    if (withinPaidCount) {
      interestPaid = row.interest_due;
      principalPaid = Math.min(row.principal_due, Math.max(0, principalSettled));
      principalSettled -= principalPaid;
      status = principalPaid >= row.principal_due ? 'paid' : 'partial';
      if (row.principal_due === 0) status = 'paid';
    } else if (paidTarget === null && principalSettled > 0 && row.principal_due > 0) {
      principalPaid = Math.min(row.principal_due, principalSettled);
      principalSettled -= principalPaid;
      interestPaid = principalPaid >= row.principal_due ? row.interest_due : 0;
      status = principalPaid >= row.principal_due ? 'paid' : 'partial';
    }

    await run(
      `INSERT INTO installments
         (contract_id, seq, due_date, due_amount, interest_due, principal_due,
          interest_paid, principal_paid, status)
       VALUES (:cid, :seq, :due, :amt, :i, :p, :ip, :pp, :status)`,
      {
        cid: contractId,
        seq: row.seq,
        due: row.due_date,
        amt: row.due_amount,
        i: row.interest_due,
        p: row.principal_due,
        ip: interestPaid,
        pp: principalPaid,
        status,
      },
    );
  }

  await audit({
    userId: ctx?.user?.id,
    action: 'import',
    entity: 'contract',
    entityId: contractId,
    after: { contract_no: contractNo, imported: true, principal_remaining: d.principal_remaining },
    ip: ctx?.ip,
  });

  return contractId;
}

async function nextFreeContractNo(dateStr) {
  const ym = dateStr.slice(0, 7).replace('-', '');
  for (let attempt = 0; attempt < 200; attempt++) {
    const n = await nextCounter(`contract:${ym}`);
    const no = `CT-${ym}-${String(n).padStart(4, '0')}`;
    if (!(await get(`SELECT id FROM contracts WHERE contract_no = :no`, { no }))) return no;
  }
  throw new ImportError('ออกเลขที่สัญญาอัตโนมัติไม่สำเร็จ');
}

/** ไฟล์ตัวอย่างสำหรับกรอกข้อมูล (ส่งออกเป็น CSV ที่ Excel เปิดได้) */
export function templateRows(kind) {
  const fields = FIELDS[kind];
  const header = fields.map((f) => f.label);
  const sample =
    kind === 'debtors'
      ? [['L001', 'สมชาย ใจดี', '0811111111', 'กรุงเทพฯ', 'สายเหนือ', 'E001', '']]
      : [
          ['L001', 'สมชาย ใจดี', '0811111111', 'กรุงเทพฯ', 'E001', '', 'รายวัน', '1000', '50', '20', '24', '2026-06-01', '700', '10', ''],
          ['L002', 'สมหญิง ขยัน', '0822222222', 'นนทบุรี', 'E002', '', 'ดอกลอย', '5000', '', '250', '12', '2026-05-15', '5000', '', 'จ่ายแต่ดอก'],
        ];
  return [header, ...sample];
}
