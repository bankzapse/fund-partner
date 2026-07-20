// แกนกลางของหน้าเว็บ: เรียก API, สร้าง DOM, จัดรูปแบบเงิน/วันที่, กล่องข้อความ

export const state = {
  user: null,
  permissions: {},
  settings: {},
};

// ---- API --------------------------------------------------------------------

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  // 401 จากหน้าอื่นแปลว่า session หมดอายุ ให้เด้งกลับไปเข้าสู่ระบบ
  // แต่ 401 จากการ "เข้าสู่ระบบ" เองแปลว่ารหัสผ่านผิด ต้องปล่อยข้อความจริงผ่านไป
  const isLoginRequest = url === '/api/auth/login';
  if (res.status === 401 && !isLoginRequest) {
    state.user = null;
    location.hash = '#/login';
    throw Object.assign(new Error('กรุณาเข้าสู่ระบบอีกครั้ง'), { status: 401 });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw Object.assign(new Error(data.error || 'เกิดข้อผิดพลาด'), { status: res.status });
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
};

// ---- เงิน (ระบบสื่อสารกันด้วยหน่วยสตางค์) -----------------------------------

/** สตางค์ -> ข้อความบาท เช่น 85000 -> "850.00" */
export function baht(satang) {
  const n = Number(satang ?? 0) / 100;
  return n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** สตางค์ -> ข้อความบาทแบบสั้น (ไม่มีทศนิยมถ้าลงตัว) */
export function bahtShort(satang) {
  const n = Number(satang ?? 0) / 100;
  return n.toLocaleString('th-TH', { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });
}

/** ข้อความบาทจากผู้ใช้ -> สตางค์ */
export function toSatang(input) {
  if (input === '' || input === null || input === undefined) return 0;
  const n = Number(String(input).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// ---- วันที่ -----------------------------------------------------------------

export function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

/** YYYY-MM-DD -> 20/07/2569 */
export function thaiDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${Number(y) + 543}`;
}

export function thaiMonth(ym) {
  const names = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const [y, m] = ym.split('-').map(Number);
  return `${names[m - 1]} ${String(y + 543).slice(2)}`;
}

// ---- คำแปลสถานะ -------------------------------------------------------------

export const PAYMENT_STATUS = {
  full: 'ชำระเต็มงวด',
  interest_only: 'จ่ายเฉพาะดอก',
  partial: 'จ่ายบางส่วน',
  unpaid: 'ไม่ชำระ',
};

export const CONTRACT_STATUS = {
  active: 'กำลังผ่อน',
  completed: 'ครบสัญญา',
  closed_reyod: 'ปิดด้วยการรียอด',
  cancelled: 'ยกเลิก',
};

export const DEBTOR_STATUS = {
  normal: 'ปกติ',
  overdue: 'ค้างชำระ',
  closed: 'ปิดบัญชี',
  disabled: 'งดใช้งาน',
};

export const BEHAVIOUR = {
  normal: 'ปกติ',
  interest_only: 'จ่ายเฉพาะดอก',
  partial: 'จ่ายบางส่วน',
  overdue: 'ค้างชำระ',
  completed: 'ครบสัญญา',
  reyod: 'รียอดแล้ว',
  cancelled: 'ยกเลิก',
};

export const CONTRACT_TYPE = {
  daily24: 'รายวัน 24 งวด',
  monthly: 'รายเดือน',
  floating: 'ดอกลอย',
};

export const INSTALLMENT_STATUS = {
  pending: 'ยังไม่ชำระ',
  paid: 'ชำระครบ',
  partial: 'บางส่วน',
  interest_only: 'เฉพาะดอก',
};

// ---- DOM helper -------------------------------------------------------------

/**
 * สร้าง element แบบสั้น: el('div', {class:'card'}, 'ข้อความ', el('b', {}, 'ตัวหนา'))
 * ข้อความทั้งหมดถูกใส่ผ่าน textContent จึงปลอดภัยจาก HTML injection
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = Boolean(v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function badge(kind, label) {
  return el('span', { class: `badge ${kind}` }, label);
}

export function stat(label, value, opts = {}) {
  return el(
    'div',
    { class: `stat ${opts.tone ?? ''}` },
    el('div', { class: 'label' }, label),
    el('div', { class: `value ${opts.small ? 'sm' : ''}` }, value),
    opts.foot ? el('div', { class: 'foot' }, opts.foot) : null,
  );
}

export function field(label, input, note) {
  return el('div', { class: 'field' }, el('label', {}, label), input, note ? el('div', { class: 'note' }, note) : null);
}

export function money(satang) {
  return el('span', { class: 'mono' }, baht(satang));
}

/** ตารางที่เลื่อนแนวนอนได้บนมือถือ */
export function table(headers, rows, emptyText = 'ไม่มีข้อมูล') {
  if (!rows.length) return el('div', { class: 'empty' }, emptyText);
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, headers.map((h) =>
        el('th', { class: h.num ? 'num' : '' }, h.label ?? h)))),
      el('tbody', {}, rows),
    ),
  );
}

// ---- Toast / Modal ----------------------------------------------------------

export function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}` }, message);
  document.getElementById('toast-root').append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 5200 : 2800);
}

export function toastError(err) {
  toast(err?.message ?? String(err), 'err');
}

/** เปิดกล่องโต้ตอบ; render(close) ต้องคืน element เนื้อหา */
export function modal(title, render) {
  const root = document.getElementById('modal-root');
  const close = () => clear(root);
  const back = el('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } });
  const box = el('div', { class: 'modal' }, el('h3', {}, title));
  box.append(render(close));
  back.append(box);
  clear(root).append(back);
  return close;
}

/** ยืนยันการทำรายการพร้อมช่องกรอกเหตุผล (ใช้กับการยกเลิกตาม SRS ข้อ 15) */
export function confirmWithReason(title, message, onConfirm, { requireReason = true } = {}) {
  modal(title, (close) => {
    const reason = el('textarea', { rows: 2, placeholder: 'เหตุผล (บันทึกลง Audit Log)' });
    const submit = el(
      'button',
      {
        class: 'btn danger',
        onclick: async () => {
          if (requireReason && !reason.value.trim()) return toast('กรุณาระบุเหตุผล', 'err');
          submit.disabled = true;
          try {
            await onConfirm(reason.value.trim());
            close();
          } catch (err) {
            toastError(err);
            submit.disabled = false;
          }
        },
      },
      'ยืนยัน',
    );
    return el(
      'div',
      {},
      el('p', { class: 'muted small' }, message),
      requireReason ? field('เหตุผล', reason) : null,
      el('div', { class: 'btn-row mt' }, submit, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}

// ---- สิทธิ์ -----------------------------------------------------------------

export function can(capability) {
  const lvl = state.permissions[capability];
  return lvl !== undefined && lvl !== 'no';
}

export function permLevel(capability) {
  return state.permissions[capability] ?? 'no';
}

/** อ่านไฟล์แนบเป็น data URL เพื่อส่งขึ้น API */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

// ---- โครงร่างระหว่างโหลด (shimmer) ----------------------------------------
//
// แสดงโครงที่มีรูปร่างใกล้เคียงเนื้อหาจริง ผู้ใช้จะรับรู้ว่าหน้ากำลังมา
// และตำแหน่งไม่กระโดดเมื่อข้อมูลมาถึง

/** แถบ shimmer หนึ่งชิ้น */
export function sk(className = '', style = '') {
  return el('span', { class: `sk ${className}`, style, 'aria-hidden': 'true' });
}

/** กล่องตัวเลขสรุประหว่างโหลด */
export function skStat() {
  return el('div', { class: 'sk-stat' }, sk('sk-label'), sk('sk-value'));
}

/** ตารางระหว่างโหลด */
export function skTable(rows = 6, cols = 5) {
  return el(
    'div',
    { class: 'table-wrap' },
    Array.from({ length: rows }, () =>
      el(
        'div',
        { class: 'sk-row' },
        Array.from({ length: cols }, (_, i) =>
          sk('', `flex:${i === 0 ? 2.4 : 1}`),
        ),
      ),
    ),
  );
}

/** การ์ดที่มีหัวข้อและตารางอยู่ข้างใน */
export function skCard({ rows = 5, cols = 5 } = {}) {
  return el('div', { class: 'sk-card' }, sk('sk-title'), skTable(rows, cols));
}

/**
 * โครงร่างทั้งหน้า เลือกรูปแบบให้ใกล้เคียงหน้าปลายทาง
 * kind: 'dashboard' | 'table' | 'detail' | 'form'
 */
export function skeleton(kind = 'table') {
  const head = el(
    'div',
    { class: 'page-head' },
    el('div', {}, sk('', 'height:24px;width:170px'), sk('', 'height:11px;width:250px;margin-top:8px')),
    sk('sk-btn'),
  );

  if (kind === 'dashboard') {
    return el(
      'div',
      {},
      head,
      el('div', { class: 'grid k4' }, Array.from({ length: 4 }, skStat)),
      sk('', 'height:14px;width:150px;margin:1.3rem 0 .7rem'),
      el('div', { class: 'grid k4' }, Array.from({ length: 8 }, skStat)),
      skCard({ rows: 6, cols: 6 }),
    );
  }
  if (kind === 'detail') {
    return el(
      'div',
      {},
      head,
      el('div', { class: 'grid k4' }, Array.from({ length: 8 }, skStat)),
      skCard({ rows: 8, cols: 7 }),
      skCard({ rows: 4, cols: 7 }),
    );
  }
  if (kind === 'form') {
    return el(
      'div',
      {},
      head,
      el(
        'div',
        { class: 'sk-card' },
        ...Array.from({ length: 6 }, () =>
          el('div', { style: 'margin-bottom:.85rem' }, sk('sk-label'), sk('', 'height:38px;margin-top:6px')),
        ),
      ),
      skCard({ rows: 3, cols: 2 }),
    );
  }
  return el(
    'div',
    {},
    head,
    el('div', { class: 'searchbar' }, sk('', 'height:38px;flex:1'), sk('', 'height:38px;width:150px')),
    skCard({ rows: 8, cols: 6 }),
  );
}

/** กราฟแท่งเงินเข้า/เงินออกแบบง่าย ไม่พึ่งไลบรารีภายนอก */
export function barChart(items, { inKey = 'total_in', outKey = 'total_out', labelKey = 'date' } = {}) {
  const max = Math.max(1, ...items.map((i) => Math.max(i[inKey], i[outKey])));
  const bars = items.map((i) =>
    el(
      'div',
      { class: 'bar', title: `${i[labelKey]}\nเข้า ${baht(i[inKey])} / ออก ${baht(i[outKey])}` },
      el('div', { class: 'seg in', style: `height:${(i[inKey] / max) * 100}px` }),
      el('div', { class: 'seg out', style: `height:${(i[outKey] / max) * 100}px` }),
    ),
  );
  return el(
    'div',
    {},
    el('div', { class: 'bars' }, bars),
    el(
      'div',
      { class: 'legend' },
      el('span', {}, el('i', { style: 'background:var(--green)' }), 'เงินเข้า'),
      el('span', {}, el('i', { style: 'background:var(--red)' }), 'เงินออก'),
    ),
  );
}
