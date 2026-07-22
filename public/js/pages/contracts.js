// ระบบสัญญา — SRS ข้อ 7 (สร้างสัญญาใหม่) และการดูสัญญาย้อนหลัง
import {
  api, state, el, clear, table, badge, stat, field, toast, toastError, baht, toSatang,
  thaiDate, todayISO, can, CONTRACT_STATUS, CONTRACT_TYPE, PAYMENT_STATUS, INSTALLMENT_STATUS,
  BEHAVIOUR, confirmWithReason,
} from '../core.js';

export async function renderContracts() {
  const wrap = el('div', {});
  const search = el('input', { type: 'search', placeholder: 'ค้นหา เลขที่สัญญา / ชื่อ / เบอร์โทร' });
  const statusSel = el(
    'select',
    {},
    el('option', { value: '' }, 'ทุกสถานะ'),
    Object.entries(CONTRACT_STATUS).map(([v, l]) => el('option', { value: v }, l)),
  );
  const list = el('div', { class: 'card' });

  async function load() {
    const data = await api.get(
      `/api/contracts?q=${encodeURIComponent(search.value.trim())}&status=${statusSel.value}`,
    );
    clear(list).append(
      el('h3', {}, `สัญญา (${data.items.length})`),
      table(
        ['เลขที่สัญญา', 'ลูกหนี้', 'ประเภท', 'วันเริ่ม', { label: 'เงินต้น', num: true }, { label: 'คงเหลือ', num: true }, 'สถานะ'],
        data.items.map((c) =>
          el(
            'tr',
            {},
            el('td', {}, el('a', { href: `#/contracts/${c.id}` }, c.contract_no)),
            el('td', {}, el('a', { href: `#/debtors/${c.debtor_id}` }, c.debtor_name),
              el('div', { class: 'small muted' }, c.debtor_code)),
            el('td', { class: 'small' }, CONTRACT_TYPE[c.type]),
            el('td', { class: 'small nowrap' }, thaiDate(c.start_date)),
            el('td', { class: 'num' }, baht(c.principal_amount)),
            el('td', { class: 'num' }, baht(c.principal_remaining)),
            el('td', {}, badge(c.status, CONTRACT_STATUS[c.status])),
          ),
        ),
        'ไม่พบสัญญา',
      ),
    );
  }

  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  statusSel.addEventListener('change', load);

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h2', {}, 'สัญญา')),
      can('contracts_create')
        ? el('a', { href: '#/contracts/new', class: 'btn sm', style: 'text-decoration:none' }, '+ สร้างสัญญาใหม่')
        : null,
    ),
    el('div', { class: 'searchbar' }, search, statusSel),
    list,
  );
  await load();
  return wrap;
}

// ---- สร้างสัญญาใหม่ (ข้อ 7) -------------------------------------------------

export async function renderNewContract() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const preselect = params.get('debtor');

  const [{ items: debtors }, { items: employees }] = await Promise.all([
    api.get('/api/debtors?limit=500'),
    api.get('/api/admin/employees'),
  ]);

  const debtorSel = el(
    'select',
    {},
    el('option', { value: '' }, '— เลือกลูกหนี้ —'),
    debtors.map((d) =>
      el('option', { value: d.id, selected: String(d.id) === preselect }, `${d.code} · ${d.full_name}`),
    ),
  );
  const typeSel = el(
    'select',
    {},
    Object.entries(CONTRACT_TYPE).map(([v, l]) => el('option', { value: v }, l)),
  );
  const empSel = el(
    'select',
    {},
    el('option', { value: '' }, 'ตามที่ตั้งไว้ในข้อมูลลูกหนี้'),
    employees.map((e) => el('option', { value: e.id }, `${e.code} ${e.full_name}`)),
  );

  const principal = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: '1000' });
  const installment = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: '50' });
  const interest = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: '20' });
  const periods = el('input', { type: 'number', inputmode: 'numeric', value: '24' });
  // โหมดคิดดอกเบี้ย — เหมารวมต่อสัญญาเป็นค่าตั้งต้นของเงินกู้รายวัน
  const modeSel = el(
    'select',
    {},
    el('option', { value: 'flat_total' }, 'เหมารวมต่อสัญญา (กรอกเป็น %)'),
    el('option', { value: 'per_installment' }, 'กำหนดดอกเป็นบาทต่องวด'),
  );
  const ratePct = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: '20' });
  const startDate = el('input', { type: 'date', value: todayISO() });
  const docFee = el('input', {
    type: 'number', step: '0.01', inputmode: 'decimal',
    value: (Number(state.settings.doc_fee ?? 10000) / 100).toFixed(2),
  });
  const deductFirst = el('input', { type: 'checkbox', checked: state.settings.deduct_first_installment === '1' });
  const note = el('textarea', { rows: 2 });

  const rateRow = el(
    'div',
    {},
    field('ดอกเบี้ยต่อสัญญา (%) *', ratePct,
      'คิดครั้งเดียวจากเงินต้น เช่น กู้ 2,000 ดอก 20% = ดอก 400 ยอดหนี้รวม 2,400'),
  );
  const legacyRow = el(
    'div',
    { class: 'grid k2' },
    field('ค่างวด (บาท) *', installment, 'ดอกลอยจะเท่ากับดอกเบี้ยต่อรอบ'),
    field('ดอกเบี้ยต่องวด (บาท) *', interest),
  );

  const previewBox = el('div', { class: 'card' });
  const submit = el('button', { class: 'btn block', disabled: true }, 'ยืนยันสร้างสัญญา');

  function body() {
    return {
      debtor_id: debtorSel.value ? Number(debtorSel.value) : null,
      employee_id: empSel.value ? Number(empSel.value) : null,
      type: typeSel.value,
      principal_amount: toSatang(principal.value),
      installment_amount: toSatang(installment.value),
      interest_per_inst: toSatang(interest.value),
      num_installments: Number(periods.value || 0),
      interest_mode: modeSel.value,
      // ส่งอัตราเป็นจำนวนเต็มหน่วยหนึ่งในหมื่น (20.5% = 2050)
      // ห้ามส่งเป็นทศนิยม เพราะฝั่งเซิร์ฟเวอร์ตัดเศษทิ้งแล้วดอกจะน้อยกว่าที่ตกลงไว้
      interest_rate_bp: Math.round(Number(ratePct.value || 0) * 100),
      start_date: startDate.value,
      doc_fee: toSatang(docFee.value),
      deduct_first: deductFirst.checked,
      note: note.value.trim() || null,
    };
  }

  /** ซ่อน/แสดงช่องให้ตรงกับโหมดที่เลือก จะได้ไม่กรอกช่องที่ระบบไม่ได้ใช้ */
  function syncMode() {
    // ดอกลอยยังไม่รองรับโหมดเหมารวม จึงบังคับกลับเป็นโหมดเดิม
    const floating = typeSel.value === 'floating';
    if (floating && modeSel.value === 'flat_total') modeSel.value = 'per_installment';
    modeSel.disabled = floating;

    const flat = modeSel.value === 'flat_total';
    rateRow.style.display = flat ? '' : 'none';
    legacyRow.style.display = flat ? 'none' : '';
  }

  async function refresh() {
    syncMode();
    // ดอกลอย: ค่างวด = ดอกเบี้ยต่อรอบ
    installment.disabled = typeSel.value === 'floating';
    if (typeSel.value === 'floating') installment.value = interest.value;

    if (!debtorSel.value) {
      clear(previewBox).append(el('div', { class: 'empty' }, 'เลือกลูกหนี้เพื่อดูตัวอย่างการคำนวณ'));
      submit.disabled = true;
      return;
    }
    try {
      const { preview } = await api.post('/api/contracts/preview', body());
      submit.disabled = false;
      clear(previewBox).append(
        el('h3', {}, 'ตรวจสอบก่อนยืนยัน'),
        ...preview.warnings.map((w) => el('div', { class: 'warn' }, w)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินต้นตามสัญญา'), el('span', { class: 'v' }, baht(preview.principalAmount))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'หักค่าทำเอกสาร'), el('span', { class: 'v' }, `- ${baht(preview.doc_fee)}`)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'หักงวดแรก'), el('span', { class: 'v' }, `- ${baht(preview.first_installment)}`)),
        el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'เงินที่ลูกค้าได้รับจริง'),
          el('span', { class: 'v' }, `${baht(preview.cash_to_customer)} บาท`)),
        el('div', { class: 'kv mt' }, el('span', { class: 'k' }, 'รวมต้องชำระทั้งสัญญา'), el('span', { class: 'v' }, baht(preview.totals.total_due))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'รวมดอกเบี้ยทั้งสัญญา'), el('span', { class: 'v' }, baht(preview.totals.total_interest))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'รวมตัดเงินต้นตามตาราง'), el('span', { class: 'v' }, baht(preview.totals.total_principal_scheduled))),
        el('div', { class: 'hint mt' }, `งวดแรกครบกำหนด ${thaiDate(preview.schedule[0].due_date)} · งวดสุดท้าย ${thaiDate(preview.schedule.at(-1).due_date)}`),
      );
    } catch (err) {
      submit.disabled = true;
      clear(previewBox).append(el('div', { class: 'warn' }, err.message));
    }
  }

  for (const input of [debtorSel, typeSel, modeSel, ratePct, principal, installment, interest, periods, startDate, docFee, deductFirst]) {
    input.addEventListener('change', refresh);
    input.addEventListener('input', refresh);
  }

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const res = await api.post('/api/contracts', body());
      toast(`สร้างสัญญา ${res.contract.contract_no} แล้ว`, 'ok');
      location.hash = `#/contracts/${res.contract.id}`;
    } catch (err) {
      toastError(err);
      submit.disabled = false;
    }
  });

  const wrap = el(
    'div',
    {},
    el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, 'สร้างสัญญาใหม่'),
      el('div', { class: 'sub' }, 'ระบบหักค่าทำเอกสารและงวดแรกให้อัตโนมัติ'))),
    el(
      'div',
      { class: 'card' },
      field('ลูกหนี้ *', debtorSel),
      field('ประเภทสัญญา *', typeSel),
      field('วิธีคิดดอกเบี้ย *', modeSel),
      el(
        'div',
        { class: 'grid k2' },
        field('เงินต้น (บาท) *', principal),
        field('จำนวนงวด *', periods),
      ),
      // ช่องของโหมดเหมารวม — กรอกอัตราเดียว ระบบคำนวณยอดรวมและค่างวดให้
      rateRow,
      // ช่องของโหมดเดิม — กรอกค่างวดกับดอกต่องวดเอง
      legacyRow,
      el(
        'div',
        { class: 'grid k2' },
        field('วันเริ่มสัญญา *', startDate),
        field('ค่าทำเอกสาร (บาท)', docFee),
      ),
      field('พนักงานผู้ดูแล', empSel),
      el('label', { class: 'rowline', style: 'margin:.5rem 0' },
        el('span', {}, 'หักงวดแรก ณ วันทำสัญญา'),
        el('span', { style: 'flex:none;width:auto' }, deductFirst)),
      field('หมายเหตุ', note),
    ),
    previewBox,
    submit,
  );

  await refresh();
  return wrap;
}

// ---- รายละเอียดสัญญา --------------------------------------------------------

export async function renderContractDetail({ id }) {
  const d = await api.get(`/api/contracts/${id}`);
  const c = d.contract;
  const s = d.summary;
  const wrap = el('div', {});

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h2', {}, c.contract_no),
        el('div', { class: 'sub' },
          el('a', { href: `#/debtors/${c.debtor_id}` }, c.debtor_name),
          ` · ${CONTRACT_TYPE[c.type]} · เริ่ม ${thaiDate(c.start_date)}`),
      ),
      el(
        'div',
        { class: 'btn-row' },
        badge(c.status, CONTRACT_STATUS[c.status]),
        c.status === 'active' && can('payments_create')
          ? el('a', { href: `#/collect/${c.id}`, class: 'btn sm', style: 'text-decoration:none' }, 'รับชำระ')
          : null,
        c.status === 'active' && can('reyod')
          ? el('a', { href: `#/reyod/${c.id}`, class: 'btn ghost sm', style: 'text-decoration:none' }, 'รียอด')
          : null,
        el('a', { href: `/api/contracts/${c.id}/schedule.csv`, class: 'btn ghost sm', style: 'text-decoration:none' }, 'ส่งออกตารางงวด'),
        el('button', { class: 'btn ghost sm no-print', onclick: () => window.print() }, 'พิมพ์'),
      ),
    ),
    el(
      'div',
      { class: 'grid k4' },
      stat('เงินต้นตามสัญญา', baht(c.principal_amount), { small: true }),
      stat('เงินต้นคงเหลือ', baht(c.principal_remaining), { small: true, tone: 'gold' }),
      stat('ค่างวด', baht(c.installment_amount), { small: true, foot: `ดอก ${baht(c.interest_per_inst)}` }),
      stat('เงินที่ลูกค้าได้รับจริง', baht(c.cash_disbursed), { small: true }),
      stat('งวดเต็มที่ชำระแล้ว', `${s.paid_full_installments} / ${s.installments_total}`, { small: true }),
      stat('วันที่จ่ายเฉพาะดอก', String(s.interest_only_days), { small: true }),
      stat('ยอดค้างสะสม', baht(s.arrears_amount), { small: true, tone: s.arrears_amount > 0 ? 'neg' : '' }),
      stat('รับดอกเบี้ยไปแล้ว', baht(s.total_interest_received), { small: true }),
    ),
  );

  // สายสัญญา (รียอด)
  if (d.chain.length > 1) {
    wrap.append(
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'ความเชื่อมโยงของสัญญา (ประวัติการรียอด)'),
        el(
          'div',
          { class: 'pill-row' },
          d.chain.map((x) =>
            el('a', {
              href: `#/contracts/${x.id}`,
              class: `pill ${x.id === c.id ? 'active' : ''}`,
              style: 'text-decoration:none',
            }, `${x.contract_no} (${CONTRACT_STATUS[x.status]})`),
          ),
        ),
      ),
    );
  }

  // ตารางงวด
  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'ตารางชำระ'),
      table(
        ['งวด', 'ครบกำหนด', { label: 'ยอดที่ควรจ่าย', num: true }, { label: 'ดอก', num: true }, { label: 'ต้น', num: true }, { label: 'ชำระแล้ว', num: true }, 'สถานะ'],
        d.installments.map((i) =>
          el(
            'tr',
            {},
            el('td', { class: 'num' }, String(i.seq)),
            el('td', { class: 'small nowrap' }, thaiDate(i.due_date)),
            el('td', { class: 'num' }, baht(i.due_amount)),
            el('td', { class: 'num' }, baht(i.interest_due)),
            el('td', { class: 'num' }, baht(i.principal_due)),
            el('td', { class: 'num' }, baht(i.interest_paid + i.principal_paid)),
            el('td', {}, badge(i.status, INSTALLMENT_STATUS[i.status])),
          ),
        ),
      ),
    ),
  );

  // ประวัติการรับชำระ + ปุ่มยกเลิก
  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'ประวัติการรับชำระ'),
      table(
        ['วันที่', 'ใบรับเงิน', { label: 'ควรจ่าย', num: true }, { label: 'จ่ายจริง', num: true }, { label: 'ดอก', num: true }, { label: 'ต้น', num: true }, 'สถานะ', 'ผู้รับเงิน', ''],
        d.payments.map((p) =>
          el(
            'tr',
            { style: p.is_void ? 'opacity:.5' : '' },
            el('td', { class: 'small nowrap' }, thaiDate(p.paid_date)),
            el('td', { class: 'small' }, p.receipt_no),
            el('td', { class: 'num' }, baht(p.due_amount)),
            el('td', { class: 'num' }, baht(p.amount_paid)),
            el('td', { class: 'num' }, baht(p.interest_amount)),
            el('td', { class: 'num' }, baht(p.principal_amount)),
            el('td', {}, p.is_void ? badge('void', 'ยกเลิกแล้ว') : badge(p.status, PAYMENT_STATUS[p.status])),
            el('td', { class: 'small' }, p.received_by_name ?? '-'),
            el(
              'td',
              {},
              !p.is_void && can('payments_void')
                ? el('button', {
                    class: 'btn danger sm no-print',
                    onclick: () =>
                      confirmWithReason(
                        'ยกเลิกรายการรับเงิน',
                        `ใบรับเงิน ${p.receipt_no} จำนวน ${baht(p.amount_paid)} บาท — ระบบจะย้อนยอดกลับและเก็บประวัติไว้ (ไม่ลบถาวร)`,
                        async (reason) => {
                          const res = await api.post(`/api/payments/${p.id}/void`, { reason });
                          toast(res.pending_approval ? 'ส่งคำขออนุมัติให้เจ้าของแล้ว' : 'ยกเลิกรายการแล้ว', 'ok');
                          location.reload();
                        },
                      ),
                  }, 'ยกเลิก')
                : p.is_void
                  ? el('span', { class: 'small muted' }, p.void_reason ?? '')
                  : null,
            ),
          ),
        ),
      ),
    ),
  );

  // Audit log
  if (d.audit.length && can('audit_view')) {
    wrap.append(
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'ประวัติการแก้ไข (Audit Log)'),
        table(
          ['เวลา', 'ผู้ทำรายการ', 'การกระทำ', 'เหตุผล'],
          d.audit.map((a) =>
            el(
              'tr',
              {},
              el('td', { class: 'small nowrap' }, a.created_at),
              el('td', { class: 'small' }, a.user_name ?? '-'),
              el('td', { class: 'small' }, a.action),
              el('td', { class: 'small' }, a.reason ?? '-'),
            ),
          ),
        ),
      ),
    );
  }

  return wrap;
}
