// ระบบรายงาน — SRS ข้อ 11 และ ข้อ 16
import {
  api, el, clear, table, badge, stat, toast, toastError, baht, thaiDate, thaiMonth, todayISO, can, barChart, skCard,
} from '../core.js';

const TABS = [
  { key: 'summary', label: 'ภาพรวม' },
  { key: 'daily', label: 'รายวัน' },
  { key: 'monthly', label: 'รายเดือน' },
  { key: 'yearly', label: 'รายปี' },
  { key: 'employees', label: 'พนักงาน' },
  { key: 'overdue', label: 'ค้างชำระ' },
  { key: 'reyod', label: 'ประวัติรียอด' },
  { key: 'profit', label: 'กำไรขาดทุน', cap: 'profit_view' },
];

export async function renderReports() {
  const wrap = el('div', {});
  const body = el('div', {});
  let active = 'summary';

  const range = {
    period: 'today',
    date: todayISO(),
    month: todayISO().slice(0, 7),
    year: todayISO().slice(0, 4),
    from: todayISO(),
    to: todayISO(),
  };

  const dateInput = el('input', { type: 'date', value: range.date, style: 'width:auto' });
  const monthInput = el('input', { type: 'month', value: range.month, style: 'width:auto' });
  const yearInput = el('input', { type: 'number', value: range.year, style: 'width:6rem' });

  const tabs = el(
    'div',
    { class: 'pill-row' },
    TABS.filter((t) => !t.cap || can(t.cap)).map((t) =>
      el('button', {
        class: `pill ${active === t.key ? 'active' : ''}`,
        onclick: (e) => {
          active = t.key;
          for (const p of tabs.querySelectorAll('.pill')) p.classList.remove('active');
          e.target.classList.add('active');
          load();
        },
      }, t.label),
    ),
  );

  const controls = el('div', { class: 'searchbar no-print' }, dateInput, monthInput, yearInput);
  for (const i of [dateInput, monthInput, yearInput]) i.addEventListener('change', load);

  function query() {
    if (active === 'monthly') return `period=month&month=${monthInput.value}`;
    if (active === 'yearly') return `period=year&year=${yearInput.value}`;
    if (active === 'daily') return `period=month&month=${monthInput.value}`;
    return `period=today&date=${dateInput.value}`;
  }

  async function load() {
    clear(body).append(skCard({ rows: 6, cols: 6 }));
    try {
      clear(body).append(await renderTab(active, query(), { dateInput, monthInput, yearInput }));
    } catch (err) {
      clear(body).append(el('div', { class: 'card' }, el('div', { class: 'empty' }, err.message)));
    }
  }

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h2', {}, 'รายงาน')),
      el('button', { class: 'btn ghost sm no-print', onclick: () => window.print() }, 'พิมพ์'),
    ),
    tabs,
    controls,
    body,
  );
  await load();
  return wrap;
}

async function renderTab(tab, q, inputs) {
  if (tab === 'summary') return summaryTab(q);
  if (tab === 'daily') return dailyTab(q);
  if (tab === 'monthly') return summaryTab(q, 'เดือนนี้');
  if (tab === 'yearly') return yearlyTab(inputs.yearInput.value);
  if (tab === 'employees') return employeeTab(q);
  if (tab === 'overdue') return overdueTab();
  if (tab === 'reyod') return reyodTab(q);
  if (tab === 'profit') return profitTab(q);
  return el('div', {});
}

async function summaryTab(q, label = 'ช่วงที่เลือก') {
  const d = await api.get(`/api/reports/summary?${q}`);
  const f = d.finance;
  const box = el('div', {});

  box.append(
    el('div', { class: 'hint' }, `${thaiDate(d.from)} ถึง ${thaiDate(d.to)}`),
    el(
      'div',
      { class: 'grid k4' },
      stat('เงินรับทั้งหมด', baht(f.total_in), { small: true }),
      stat('เงินจ่ายทั้งหมด', baht(f.total_out), { small: true }),
      stat('เงินสดสุทธิ', baht(f.net_cash), { tone: f.net_cash >= 0 ? 'pos' : 'neg' }),
      stat('กำไรสุทธิ', baht(f.net_profit), { tone: f.net_profit >= 0 ? 'pos' : 'neg' }),
      stat('ดอกเบี้ยรับ', baht(f.interest_income), { small: true }),
      stat('ค่าทำเอกสาร', baht(f.doc_fee_income), { small: true }),
      stat('รายได้อื่น', baht(f.other_income), { small: true }),
      stat('ค่าใช้จ่ายดำเนินงาน', baht(f.operating_expense), { small: true }),
      stat('เงินต้นที่ปล่อย', baht(f.principal_issued), { small: true }),
      stat('เงินต้นรับคืน', baht(f.principal_back), { small: true }),
      stat('เงินต้นคงเหลือในลูกหนี้', baht(f.principal_outstanding), { small: true }),
      stat('สัญญาที่ยังใช้งาน', String(f.active_contracts), { small: true }),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'ผลการเก็บเงิน'),
      el('div', { class: 'grid k3' },
        stat('ยอดที่ควรเก็บ', baht(d.collection.expected), { small: true }),
        stat('ยอดเก็บจริง', baht(d.collection.collected), { small: true }),
        stat('ยอดค้าง', baht(d.collection.outstanding), { small: true, tone: d.collection.outstanding > 0 ? 'neg' : '' })),
      el('div', { class: 'grid k4 mt' },
        stat('ชำระเต็มงวด', String(f.full_count), { small: true }),
        stat('จ่ายเฉพาะดอก', String(f.interest_only_count), { small: true }),
        stat('จ่ายบางส่วน', String(f.partial_count), { small: true }),
        stat('รายการทั้งหมด', String(f.payment_count), { small: true })),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'จำนวนลูกหนี้ตามสถานะ'),
      el('div', { class: 'grid k3' },
        stat('ทั้งหมด', String(d.debtor_status.total), { small: true }),
        stat('ปกติ', String(d.debtor_status.normal), { small: true }),
        stat('จ่ายเฉพาะดอก', String(d.debtor_status.interest_only), { small: true }),
        stat('จ่ายบางส่วน', String(d.debtor_status.partial), { small: true }),
        stat('ค้างชำระ', String(d.debtor_status.overdue), { small: true }),
        stat('ครบสัญญา', String(d.debtor_status.completed), { small: true })),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'รายได้และค่าใช้จ่ายแยกประเภท'),
      el('div', { class: 'grid k2' },
        el('div', {},
          el('div', { class: 'hint' }, 'รายได้'),
          table(['ประเภท', { label: 'จำนวนเงิน', num: true }],
            d.breakdown.income.map((r) => el('tr', {}, el('td', { class: 'small' }, r.category), el('td', { class: 'num' }, baht(r.amount)))))),
        el('div', {},
          el('div', { class: 'hint' }, 'ค่าใช้จ่าย'),
          table(['ประเภท', { label: 'จำนวนเงิน', num: true }],
            d.breakdown.expenses.map((r) => el('tr', {}, el('td', { class: 'small' }, r.category), el('td', { class: 'num' }, baht(r.amount))))))),
    ),
    el('div', { class: 'btn-row no-print' },
      el('a', { href: `/api/reports/summary.csv?${q}`, class: 'btn ghost sm', style: 'text-decoration:none' }, 'ส่งออก Excel')),
  );
  return box;
}

async function dailyTab(q) {
  const { items } = await api.get(`/api/reports/daily-series?${q}`);
  return el(
    'div',
    {},
    el('div', { class: 'card' }, el('h3', {}, 'กราฟเงินเข้า-เงินออกรายวัน'), barChart(items)),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'สรุปรายวัน'),
      table(
        ['วันที่', { label: 'เงินเข้า', num: true }, { label: 'เงินออก', num: true }, { label: 'เงินสดสุทธิ', num: true }, { label: 'รายได้จริง', num: true }, { label: 'กำไรสุทธิ', num: true }, { label: 'เงินต้นรับคืน', num: true }],
        items.map((r) =>
          el(
            'tr',
            {},
            el('td', { class: 'small nowrap' }, thaiDate(r.date)),
            el('td', { class: 'num' }, baht(r.total_in)),
            el('td', { class: 'num' }, baht(r.total_out)),
            el('td', { class: 'num' }, baht(r.net_cash)),
            el('td', { class: 'num' }, baht(r.real_income)),
            el('td', { class: 'num' }, baht(r.net_profit)),
            el('td', { class: 'num' }, baht(r.principal_back)),
          ),
        ),
      ),
    ),
  );
}

async function yearlyTab(year) {
  const { items } = await api.get(`/api/reports/monthly-series?year=${year}`);
  const totals = items.reduce(
    (a, m) => ({
      real_income: a.real_income + m.real_income,
      operating_expense: a.operating_expense + m.operating_expense,
      net_profit: a.net_profit + m.net_profit,
      principal_issued: a.principal_issued + m.principal_issued,
      principal_back: a.principal_back + m.principal_back,
    }),
    { real_income: 0, operating_expense: 0, net_profit: 0, principal_issued: 0, principal_back: 0 },
  );

  return el(
    'div',
    {},
    el('div', { class: 'grid k4' },
      stat('รายได้จริงทั้งปี', baht(totals.real_income), { small: true }),
      stat('ค่าใช้จ่ายทั้งปี', baht(totals.operating_expense), { small: true }),
      stat('กำไรสุทธิทั้งปี', baht(totals.net_profit), { tone: totals.net_profit >= 0 ? 'pos' : 'neg' }),
      stat('เงินต้นที่ปล่อยทั้งปี', baht(totals.principal_issued), { small: true })),
    el('div', { class: 'card' }, el('h3', {}, 'กราฟรายเดือน'), barChart(items, { labelKey: 'month' })),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `สรุป 12 เดือน ปี ${Number(year) + 543}`),
      table(
        ['เดือน', { label: 'เงินเข้า', num: true }, { label: 'เงินออก', num: true }, { label: 'รายได้จริง', num: true }, { label: 'ค่าใช้จ่าย', num: true }, { label: 'กำไรสุทธิ', num: true }, { label: 'เงินต้นคงเหลือ', num: true }],
        items.map((m) =>
          el(
            'tr',
            {},
            el('td', { class: 'small nowrap' }, thaiMonth(m.month)),
            el('td', { class: 'num' }, baht(m.total_in)),
            el('td', { class: 'num' }, baht(m.total_out)),
            el('td', { class: 'num' }, baht(m.real_income)),
            el('td', { class: 'num' }, baht(m.operating_expense)),
            el('td', { class: 'num' }, baht(m.net_profit)),
            el('td', { class: 'num' }, baht(m.principal_outstanding)),
          ),
        ),
      ),
    ),
  );
}

async function employeeTab(q) {
  const { items } = await api.get(`/api/reports/employees?${q}`);
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'รายงานพนักงาน'),
    table(
      ['พนักงาน', 'พื้นที่', { label: 'ลูกหนี้ที่ดูแล', num: true }, { label: 'ยอดที่ควรเก็บ', num: true }, { label: 'ยอดเก็บจริง', num: true }, { label: 'ยอดค้าง', num: true }, { label: 'ดอกเบี้ยที่เก็บได้', num: true }, { label: 'ค่าใช้จ่าย', num: true }, { label: 'คอมมิชชั่น', num: true }],
      items.map((e) =>
        el(
          'tr',
          {},
          el('td', {}, e.full_name, el('div', { class: 'small muted' }, e.code)),
          el('td', { class: 'small' }, e.area ?? '-'),
          el('td', { class: 'num' }, String(e.debtor_count)),
          el('td', { class: 'num' }, baht(e.expected)),
          el('td', { class: 'num' }, baht(e.collected)),
          el('td', { class: 'num' }, baht(e.outstanding)),
          el('td', { class: 'num' }, baht(e.interest_collected)),
          el('td', { class: 'num' }, baht(e.expenses)),
          el('td', { class: 'num' }, baht(e.commission)),
        ),
      ),
      'ยังไม่มีข้อมูลพนักงาน',
    ),
  );
}

async function overdueTab() {
  const d = await api.get('/api/reports/overdue?min_days=1');
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `ลูกหนี้ค้างชำระ (${d.overdue.length} ราย)`),
      table(
        ['ลูกหนี้', 'สัญญา', { label: 'งวดที่ค้าง', num: true }, { label: 'ยอดค้าง', num: true }, { label: 'เงินต้นคงเหลือ', num: true }, 'ค้างตั้งแต่', 'ผู้ดูแล'],
        d.overdue.map((r) =>
          el(
            'tr',
            {},
            el('td', {}, r.debtor_name, el('div', { class: 'small muted' }, r.phone ?? '')),
            el('td', {}, el('a', { href: `#/contracts/${r.contract_id}` }, r.contract_no)),
            el('td', { class: 'num' }, String(r.overdue_installments)),
            el('td', { class: 'num' }, baht(r.arrears_amount)),
            el('td', { class: 'num' }, baht(r.principal_remaining)),
            el('td', { class: 'small nowrap' }, thaiDate(r.oldest_due)),
            el('td', { class: 'small' }, r.employee_name ?? '-'),
          ),
        ),
        'ไม่มีลูกหนี้ค้างชำระ',
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `ลูกหนี้ที่จ่ายเฉพาะดอกหลายครั้ง (${d.interest_only.length} ราย)`),
      table(
        ['ลูกหนี้', 'สัญญา', { label: 'จำนวนครั้ง', num: true }, { label: 'เงินต้นคงเหลือ', num: true }, 'ชำระล่าสุด'],
        d.interest_only.map((r) =>
          el(
            'tr',
            {},
            el('td', {}, r.debtor_name),
            el('td', {}, el('a', { href: `#/contracts/${r.contract_id}` }, r.contract_no)),
            el('td', { class: 'num' }, String(r.interest_only_count)),
            el('td', { class: 'num' }, baht(r.principal_remaining)),
            el('td', { class: 'small nowrap' }, thaiDate(r.last_paid)),
          ),
        ),
        'ไม่มีข้อมูล',
      ),
    ),
  );
}

async function reyodTab(q) {
  const { items } = await api.get(`/api/reports/reyod?${q}`);
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ประวัติการรียอดและความเชื่อมโยงของสัญญา'),
    table(
      // แยกเงินต้นกับดอกเบี้ยเดิมที่ยกไป ไม่งั้นสองคอลัมน์แรกบวกกันแล้ว
      // ไม่เท่ายอดสัญญาใหม่ ผู้อ่านจะเห็นยอดโตขึ้นเองโดยไม่มีที่มา
      ['วันที่', 'ลูกหนี้', 'สัญญาเดิม', 'สัญญาใหม่',
        { label: 'เงินต้นที่ยกไป', num: true },
        { label: 'ดอกเดิมที่ยกไป', num: true },
        { label: 'เงินเพิ่มใหม่', num: true },
        { label: 'ยอดสัญญาใหม่', num: true }, 'ผู้ทำรายการ'],
      items.map((r) =>
        el(
          'tr',
          {},
          el('td', { class: 'small nowrap' }, thaiDate(r.created_at?.slice(0, 10))),
          el('td', { class: 'small' }, r.debtor_name),
          el('td', {}, el('a', { href: `#/contracts/${r.from_contract_id}` }, r.from_no)),
          el('td', {}, el('a', { href: `#/contracts/${r.to_contract_id}` }, r.to_no)),
          el('td', { class: 'num' }, baht(r.carried_principal)),
          el('td', { class: 'num' }, baht(r.carried_interest ?? 0)),
          el('td', { class: 'num' }, baht(r.new_money)),
          el('td', { class: 'num' }, baht(r.new_principal)),
          el('td', { class: 'small' }, r.created_by_name ?? '-'),
        ),
      ),
      'ยังไม่มีการรียอดในช่วงเวลานี้',
    ),
  );
}

async function profitTab(q) {
  const d = await api.get(`/api/reports/profit-loss?${q}`);
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `งบกำไรขาดทุน ${thaiDate(d.from)} — ${thaiDate(d.to)}`),
      el('div', { class: 'hint' }, 'รายได้'),
      ...d.revenue.map((r) =>
        el('div', { class: 'kv' }, el('span', { class: 'k' }, r.label), el('span', { class: 'v' }, baht(r.amount)))),
      el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'รวมรายได้'), el('span', { class: 'v' }, baht(d.total_revenue))),
      el('div', { class: 'hint mt' }, 'ค่าใช้จ่ายดำเนินงาน'),
      ...(d.expenses.length
        ? d.expenses.map((r) =>
            el('div', { class: 'kv' }, el('span', { class: 'k' }, r.category), el('span', { class: 'v' }, baht(r.amount))))
        : [el('div', { class: 'kv' }, el('span', { class: 'k muted' }, 'ไม่มีค่าใช้จ่าย'), el('span', { class: 'v' }, '0.00'))]),
      el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'รวมค่าใช้จ่าย'), el('span', { class: 'v' }, baht(d.total_expense))),
      el('div', { class: 'kv total' },
        el('span', { class: 'k' }, 'กำไรสุทธิ'),
        el('span', { class: 'v', style: `color:var(--${d.net_profit >= 0 ? 'green' : 'red'})` }, `${baht(d.net_profit)} บาท`)),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'การหมุนเวียนเงินทุน (ไม่นับเป็นรายได้/ค่าใช้จ่าย)'),
      el('div', { class: 'grid k4' },
        stat('เงินต้นที่ปล่อย', baht(d.capital_flow.principal_issued), { small: true }),
        stat('เงินสดจ่ายให้ลูกค้า', baht(d.capital_flow.cash_disbursed), { small: true }),
        stat('เงินต้นรับคืน', baht(d.capital_flow.principal_back), { small: true }),
        stat('เงินต้นคงเหลือ', baht(d.capital_flow.principal_outstanding), { small: true })),
      el('div', { class: 'info mt' }, d.capital_flow.note),
    ),
  );
}
