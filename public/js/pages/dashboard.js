// Dashboard — SRS ข้อ 5
import {
  api, el, clear, stat, table, badge, baht, thaiDate, todayISO, can, CONTRACT_TYPE,
} from '../core.js';

// โซนที่เลือกดูล่าสุด — จำไว้ระหว่างการรีเฟรชหน้า dashboard ในเซสชันเดียวกัน
let selectedZone = '';

export async function renderDashboard() {
  const date = todayISO();
  const zoneQS = selectedZone ? `&employee_id=${selectedZone}` : '';
  const d = await api.get(`/api/dashboard?date=${date}${zoneQS}`);
  const showProfit = can('profit_view');

  const wrap = el('div', {});

  // ตัวเลือกโซนสำหรับเจ้าของ/ผู้จัดการ (สเปกข้อ 41) — พนักงานเห็นเฉพาะโซนตัวเองอยู่แล้ว
  let zoneSel = null;
  if (can('employees_manage') || can('reports_view') === 'all') {
    try {
      const { items } = await api.get('/api/admin/employees');
      if (items?.length) {
        zoneSel = el('select', { style: 'width:auto' },
          el('option', { value: '' }, 'รวมทุกโซน'),
          items.filter((e) => e.is_active).map((e) =>
            el('option', { value: e.id, selected: String(e.id) === String(selectedZone) },
              `โซน ${e.code} — ${e.full_name}`)),
        );
        zoneSel.addEventListener('change', async () => {
          selectedZone = zoneSel.value;
          // เรนเดอร์หน้าใหม่ทั้งหน้าด้วยค่าโซนที่เลือก
          const parent = wrap.parentElement;
          if (parent) {
            const fresh = await renderDashboard();
            parent.replaceChild(fresh, wrap);
          }
        });
      }
    } catch { /* ไม่ใช่เจ้าของ — ไม่ต้องมีตัวเลือก */ }
  }

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h2', {}, 'ภาพรวมวันนี้'), el('div', { class: 'sub' }, thaiDate(date))),
      zoneSel,
      d.closing
        ? badge('completed', 'ปิดยอดวันนี้แล้ว')
        : can('daily_closing')
          ? el('a', { href: '#/cashbook', class: 'btn ghost sm', style: 'text-decoration:none' }, 'ปิดยอดประจำวัน')
          : null,
    ),
  );

  if (d.pending_approvals > 0) {
    wrap.append(
      el(
        'div',
        { class: 'warn' },
        `มีคำขออนุมัติรอพิจารณา ${d.pending_approvals} รายการ — ดูได้ที่เมนูตั้งค่า`,
      ),
    );
  }

  // แถวเงินทุน
  wrap.append(
    el(
      'div',
      { class: 'grid k4' },
      stat('เงินทุนทั้งหมด', baht(d.capital.total_capital), { tone: 'navy', foot: 'เงินสด + เงินต้นในลูกหนี้' }),
      stat('เงินต้นที่ปล่อยไป', baht(d.capital.principal_issued), { small: true }),
      stat('เงินต้นคงเหลือในลูกหนี้', baht(d.capital.principal_outstanding), { small: true }),
      stat('เงินสดคงเหลือตามระบบ', baht(d.capital.cash_position), {
        small: true,
        tone: d.capital.cash_position < 0 ? 'neg' : 'pos',
      }),
    ),
  );

  // แถววันนี้
  const t = d.today;
  wrap.append(
    el('h3', { style: 'margin:1.2rem 0 .6rem;font-size:1rem' }, 'ผลประกอบการวันนี้'),
    el(
      'div',
      { class: 'grid k4' },
      stat('เงินที่เก็บได้วันนี้', baht(t.cash_from_debtors), { foot: `${t.payment_count} รายการ` }),
      // ดอกเบี้ยที่รับรู้ = ดอกต่อรายการรับ (โหมดเดิม) + ดอกรับรู้ตอนปิด/รียอด (เหมารวม)
      stat('ดอกเบี้ยที่รับรู้', baht(t.interest_income + (t.recognized_interest_income ?? 0) + (t.upfront_interest_income ?? 0)), { small: true }),
      stat('ค่าทำสัญญา (ของพนักงาน)', baht(t.doc_fee_collected ?? 0), { small: true }),
      stat('ค่าใช้จ่าย', baht(t.operating_expense), { small: true }),
      showProfit
        ? stat('กำไรสุทธิ', baht(t.net_profit), {
            tone: t.net_profit >= 0 ? 'pos' : 'neg',
            foot: 'รายได้จริง - ค่าใช้จ่ายดำเนินงาน',
          })
        : null,
      stat('เงินต้นรับคืน', baht(t.principal_back), { small: true, foot: 'เงินทุนหมุนกลับ ไม่ใช่กำไร' }),
      stat('ยอดที่ควรเก็บวันนี้', baht(d.collection_today.expected), { small: true }),
      stat('ยอดค้างวันนี้', baht(d.collection_today.outstanding), {
        small: true,
        tone: d.collection_today.outstanding > 0 ? 'neg' : '',
      }),
    ),
  );

  // สถานะลูกหนี้
  const s = d.debtor_status;
  wrap.append(
    el('h3', { style: 'margin:1.2rem 0 .6rem;font-size:1rem' }, 'สถานะลูกหนี้'),
    el(
      'div',
      { class: 'grid k3' },
      stat('ลูกหนี้ทั้งหมด', s.total, { small: true }),
      stat('ปกติ', s.normal, { small: true }),
      stat('จ่ายเฉพาะดอก', s.interest_only, { small: true }),
      stat('จ่ายบางส่วน', s.partial, { small: true }),
      stat('ค้างชำระ', s.overdue, { small: true, tone: s.overdue ? 'neg' : '' }),
      stat('ครบสัญญา', s.completed, { small: true }),
    ),
  );

  // สถานะละเอียดของลูกหนี้ในวันนี้ (สเปกข้อ 43)
  // หมายเหตุ: รายที่จ่ายเต็มงวดแล้วจะหลุดจากรายการนี้เอง (งวดปิด) จึงไม่มีป้าย "จ่ายแล้ว" ในตารางนี้
  const rowStatus = (r) => {
    if (r.is_holiday > 0) return { kind: 'disabled', label: 'วันหยุด' };
    if (r.free_pay_today > 0) return { kind: 'partial', label: 'จ่ายฟรี' };
    if (r.paid_today > 0) return { kind: 'partial', label: 'จ่ายบางส่วน' };
    if (r.overdue_count > 0) return { kind: 'overdue', label: `ค้าง ${r.overdue_count} งวด` };
    return { kind: 'normal', label: 'ยังไม่เก็บ' };
  };

  // ตัวกรอง (สเปกข้อ 43): ประเภทสัญญา + ค้นหา ชื่อ/รหัส
  const typeFilter = el('select', { style: 'width:auto' },
    el('option', { value: '' }, 'ทุกประเภท'),
    el('option', { value: 'daily24' }, 'รายวัน'),
    el('option', { value: 'monthly' }, 'รายเดือน'),
    el('option', { value: 'floating' }, 'ดอกลอย'));
  const search = el('input', { type: 'search', placeholder: 'ค้นหา ชื่อ / รหัสลูกหนี้', style: 'width:auto' });
  const tableBox = el('div', {});

  const drawRows = () => {
    const tf = typeFilter.value;
    const q = search.value.trim().toLowerCase();
    const filtered = d.due_today.filter((r) =>
      (!tf || r.type === tf) &&
      (!q || r.debtor_name.toLowerCase().includes(q) || (r.debtor_code ?? '').toLowerCase().includes(q)));
    const rows = filtered.map((r) => {
      const st = rowStatus(r);
      return el('tr', {},
        el('td', {}, el('a', { href: `#/debtors/${r.debtor_id}` }, r.debtor_name),
          el('div', { class: 'small muted' }, `${r.debtor_code} · ${r.contract_no}`)),
        el('td', { class: 'small' }, CONTRACT_TYPE[r.type] ?? r.type),
        el('td', { class: 'small' }, r.phone ?? '-'),
        el('td', { class: 'num' }, baht(r.due_remaining)),
        el('td', { class: 'num' }, r.arrears_amount > 0 ? baht(r.arrears_amount) : '-'),
        el('td', {}, badge(st.kind, st.label)),
        el('td', {},
          can('payments_create') && r.is_holiday === 0
            ? el('a', { href: `#/collect/${r.contract_id}`, class: 'btn sm', style: 'text-decoration:none' }, 'รับชำระ')
            : null),
      );
    });
    clear(tableBox).append(
      table(['ลูกหนี้', 'ประเภท', 'เบอร์โทร', { label: 'ยอดที่ควรจ่าย', num: true },
             { label: 'ยอดค้างสะสม', num: true }, 'สถานะ', ''],
        rows, 'วันนี้ไม่มีลูกหนี้ที่ต้องเก็บ'),
    );
  };
  typeFilter.addEventListener('change', drawRows);
  search.addEventListener('input', drawRows);
  drawRows();

  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'rowline' },
        el('h3', { style: 'margin:0' }, `ลูกหนี้ที่ต้องเก็บวันนี้ (${d.due_today.length} ราย)`),
        el('div', { class: 'searchbar no-print', style: 'flex:none;width:auto;gap:.4rem' }, typeFilter, search)),
      tableBox,
    ),
  );

  return wrap;
}
