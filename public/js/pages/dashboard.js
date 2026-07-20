// Dashboard — SRS ข้อ 5
import {
  api, el, stat, table, badge, baht, thaiDate, todayISO, can, toast, toastError,
} from '../core.js';

export async function renderDashboard() {
  const date = todayISO();
  const d = await api.get(`/api/dashboard?date=${date}`);
  const showProfit = can('profit_view');

  const wrap = el('div', {});

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h2', {}, 'ภาพรวมวันนี้'), el('div', { class: 'sub' }, thaiDate(date))),
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
      stat('ดอกเบี้ยที่ได้รับ', baht(t.interest_income), { small: true }),
      stat('ค่าทำเอกสาร', baht(t.doc_fee_income), { small: true }),
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

  // ตารางลูกหนี้ที่ต้องเก็บวันนี้ พร้อมปุ่มรับชำระ
  const rows = d.due_today.map((r) =>
    el(
      'tr',
      {},
      el('td', {}, el('a', { href: `#/debtors/${r.debtor_id}` }, r.debtor_name),
        el('div', { class: 'small muted' }, `${r.debtor_code} · ${r.contract_no}`)),
      el('td', { class: 'small' }, r.phone ?? '-'),
      el('td', { class: 'num' }, baht(r.due_remaining)),
      el('td', { class: 'num' }, r.arrears_amount > 0 ? baht(r.arrears_amount) : '-'),
      el('td', {}, r.overdue_count > 0 ? badge('overdue', `ค้าง ${r.overdue_count} งวด`) : badge('normal', 'ปกติ')),
      el(
        'td',
        {},
        can('payments_create')
          ? el('a', { href: `#/collect/${r.contract_id}`, class: 'btn sm', style: 'text-decoration:none' }, 'รับชำระ')
          : null,
      ),
    ),
  );

  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `ลูกหนี้ที่ต้องเก็บวันนี้ (${d.due_today.length} ราย)`),
      table(
        [
          'ลูกหนี้',
          'เบอร์โทร',
          { label: 'ยอดที่ควรจ่าย', num: true },
          { label: 'ยอดค้างสะสม', num: true },
          'สถานะ',
          '',
        ],
        rows,
        'วันนี้ไม่มีลูกหนี้ที่ต้องเก็บ',
      ),
    ),
  );

  return wrap;
}
