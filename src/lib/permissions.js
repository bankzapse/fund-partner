// ตารางสิทธิ์ตาม SRS ข้อ 12
// ค่าที่เป็นไปได้: 'all' ทั้งหมด | 'yes' ได้ | 'own' เฉพาะงานตน | 'view' ดูได้
//                  'limited' จำกัด | 'approval' ได้แต่รออนุมัติ | 'no' ไม่ได้

export const ROLES = {
  owner: 'เจ้าของ',
  manager: 'ผู้จัดการ',
  collector: 'พนักงานเก็บเงิน',
  accountant: 'บัญชี',
};

export const MATRIX = {
  //                       owner      manager     collector   accountant
  dashboard:            { owner: 'all', manager: 'all',      collector: 'own',   accountant: 'limited' },
  debtors_view:         { owner: 'all', manager: 'all',      collector: 'own',   accountant: 'view' },
  debtors_edit:         { owner: 'yes', manager: 'yes',      collector: 'no',    accountant: 'no' },
  contracts_create:     { owner: 'yes', manager: 'yes',      collector: 'no',    accountant: 'no' },
  reyod:                { owner: 'yes', manager: 'approval', collector: 'no',    accountant: 'no' },
  payments_create:      { owner: 'yes', manager: 'yes',      collector: 'yes',   accountant: 'no' },
  payments_void:        { owner: 'yes', manager: 'approval', collector: 'no',    accountant: 'no' },
  cashbook:             { owner: 'all', manager: 'limited',  collector: 'no',    accountant: 'yes' },
  daily_closing:        { owner: 'yes', manager: 'limited',  collector: 'no',    accountant: 'yes' },
  profit_view:          { owner: 'yes', manager: 'limited',  collector: 'no',    accountant: 'yes' },
  employees_manage:     { owner: 'yes', manager: 'no',       collector: 'no',    accountant: 'no' },
  settings_manage:      { owner: 'yes', manager: 'no',       collector: 'no',    accountant: 'no' },
  reports_view:         { owner: 'all', manager: 'all',      collector: 'own',   accountant: 'yes' },
  approvals_decide:     { owner: 'yes', manager: 'no',       collector: 'no',    accountant: 'no' },
  audit_view:           { owner: 'yes', manager: 'limited',  collector: 'no',    accountant: 'view' },
};

const DENIED = new Set(['no']);
const NEEDS_APPROVAL = new Set(['approval']);

/**
 * ระดับสิทธิ์ของผู้ใช้ต่อความสามารถหนึ่ง ๆ
 * รองรับสิทธิ์ย่อยรายบุคคล (users.extra_perms) ตาม SRS ข้อ 12
 */
export function levelOf(user, capability) {
  if (!user) return 'no';
  const extra = parseExtra(user.extra_perms);
  if (Object.hasOwn(extra, capability)) return extra[capability];
  const row = MATRIX[capability];
  if (!row) return 'no';
  return row[user.role] ?? 'no';
}

export function can(user, capability) {
  return !DENIED.has(levelOf(user, capability));
}

/** ทำได้ทันทีหรือไม่ (ถ้า 'approval' แปลว่าต้องส่งคำขออนุมัติก่อน) */
export function canDirectly(user, capability) {
  const lvl = levelOf(user, capability);
  return !DENIED.has(lvl) && !NEEDS_APPROVAL.has(lvl);
}

export function needsApproval(user, capability) {
  return NEEDS_APPROVAL.has(levelOf(user, capability));
}

/** เห็นข้อมูลได้เฉพาะลูกหนี้ที่ตนดูแลหรือไม่ (ข้อ 12: พนักงานเก็บเงิน) */
export function scopedToOwn(user, capability) {
  return levelOf(user, capability) === 'own';
}

function parseExtra(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** สรุปสิทธิ์ทั้งหมดของผู้ใช้ ส่งให้ frontend ใช้ซ่อน/แสดงเมนู */
export function permissionSummary(user) {
  const out = {};
  for (const cap of Object.keys(MATRIX)) out[cap] = levelOf(user, cap);
  return out;
}

export class PermissionError extends Error {
  constructor(message = 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้') {
    super(message);
    this.status = 403;
  }
}

export function requireCap(user, capability) {
  if (!can(user, capability)) throw new PermissionError();
}
