// ระบบรับชำระเงิน — SRS ข้อ 8 (ออกแบบให้กดจากมือถือได้เร็ว)
import {
  api, el, clear, table, badge, stat, field, toast, toastError, baht, toSatang,
  thaiDate, todayISO, PAYMENT_STATUS, CONTRACT_TYPE, readFileAsDataUrl,
} from '../core.js';

export async function renderCollect({ contractId } = {}) {
  const wrap = el('div', {});
  const panel = el('div', {});

  const search = el('input', { type: 'search', placeholder: 'ค้นหา ชื่อ / เบอร์โทร / เลขที่สัญญา' });
  const results = el('div', {});

  async function doSearch() {
    const q = search.value.trim();
    if (!q) return clear(results);
    const { items } = await api.get(`/api/contracts?q=${encodeURIComponent(q)}&status=active`);
    clear(results).append(
      table(
        ['เลขที่สัญญา', 'ลูกหนี้', { label: 'เงินต้นคงเหลือ', num: true }, ''],
        items.map((c) =>
          el(
            'tr',
            {},
            el('td', { class: 'small' }, c.contract_no),
            el('td', {}, c.debtor_name, el('div', { class: 'small muted' }, c.debtor_phone ?? '')),
            el('td', { class: 'num' }, baht(c.principal_remaining)),
            el('td', {}, el('button', { class: 'btn sm', onclick: () => open(c.id) }, 'เลือก')),
          ),
        ),
        'ไม่พบสัญญาที่ยังใช้งาน',
      ),
    );
  }

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 300); });

  async function open(id) {
    location.hash = `#/collect/${id}`;
  }

  wrap.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, 'รับชำระเงิน'),
      el('div', { class: 'sub' }, 'บันทึกตามยอดที่ลูกค้าจ่ายจริง ไม่บังคับให้จ่ายเต็มงวด'))),
  );

  if (contractId) {
    panel.append(await paymentPanel(Number(contractId)));
    wrap.append(
      panel,
      el('div', { class: 'card no-print' }, el('h3', {}, 'ค้นหาสัญญาอื่น'), search, results),
    );
  } else {
    wrap.append(el('div', { class: 'card' }, el('h3', {}, 'ค้นหาลูกหนี้'), search, results));
  }
  return wrap;
}

/** แผงรับชำระของสัญญาหนึ่งฉบับ */
async function paymentPanel(contractId) {
  const ctx = await api.get(`/api/payments/context/${contractId}`);
  const s = ctx.summary;
  const c = s.contract;
  const box = el('div', {});

  const amount = el('input', {
    type: 'number', inputmode: 'decimal', step: '0.01', min: '0',
    style: 'font-size:1.4rem;font-weight:700;text-align:right',
  });
  const paidDate = el('input', { type: 'date', value: todayISO() });
  const note = el('input', { placeholder: 'หมายเหตุ (ถ้ามี)' });
  const extraToPrincipal = el('input', { type: 'checkbox' });
  const proof = el('input', { type: 'file', accept: 'image/*' });
  const result = el('div', {});
  const submit = el('button', { class: 'btn block', disabled: true }, 'บันทึกการรับชำระ');

  const due = s.current_installment;

  async function preview() {
    const satang = toSatang(amount.value);
    if (amount.value === '') {
      clear(result);
      submit.disabled = true;
      return;
    }
    try {
      const { preview: p } = await api.post('/api/payments/preview', {
        contract_id: contractId,
        amount_paid: satang,
        extra_to_principal: extraToPrincipal.checked,
      });
      submit.disabled = false;
      clear(result).append(
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ยอดจ่ายจริง'), el('span', { class: 'v' }, baht(p.amount_paid))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ตัดดอกเบี้ย'), el('span', { class: 'v' }, baht(p.interest_amount))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ตัดเงินต้น'), el('span', { class: 'v' }, baht(p.principal_amount))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินต้นคงเหลือหลังบันทึก'), el('span', { class: 'v' }, baht(p.principal_remaining_after))),
        el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'สถานะที่จะบันทึก'),
          el('span', { class: 'v' }, badge(p.status, PAYMENT_STATUS[p.status]))),
      );
    } catch (err) {
      submit.disabled = true;
      clear(result).append(el('div', { class: 'warn' }, err.message));
    }
  }

  amount.addEventListener('input', preview);
  extraToPrincipal.addEventListener('change', preview);

  const quickButtons = el(
    'div',
    { class: 'quick' },
    el('button', {
      class: 'btn', onclick: () => { amount.value = ((due?.due_remaining ?? 0) / 100).toFixed(2); preview(); },
    }, 'จ่ายเต็ม'),
    el('button', {
      class: 'btn gold', onclick: () => { amount.value = ((due?.interest_remaining ?? 0) / 100).toFixed(2); preview(); },
    }, 'เฉพาะดอก'),
    el('button', {
      class: 'btn ghost', onclick: () => { amount.value = ''; amount.focus(); clear(result); submit.disabled = true; },
    }, 'กรอกยอดเอง'),
    el('button', {
      class: 'btn danger', onclick: () => { amount.value = '0'; preview(); },
    }, 'ไม่จ่าย'),
  );

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      let proofDataUrl = null;
      if (proof.files[0]) proofDataUrl = await readFileAsDataUrl(proof.files[0]);
      const res = await api.post('/api/payments', {
        contract_id: contractId,
        amount_paid: toSatang(amount.value),
        paid_date: paidDate.value,
        note: note.value.trim() || null,
        extra_to_principal: extraToPrincipal.checked,
        proof_data_url: proofDataUrl,
      });
      toast(`บันทึกแล้ว ${res.payment.receipt_no}`, 'ok');
      showReceipt(res.payment);
      clear(box).append(await paymentPanel(contractId));
    } catch (err) {
      toastError(err);
      submit.disabled = false;
    }
  });

  box.append(
    el(
      'div',
      { class: 'card' },
      el(
        'h3',
        {},
        el('span', {}, `${c.debtor_name} · ${c.contract_no}`),
        el('span', { class: 'small muted' }, CONTRACT_TYPE[c.type]),
      ),
      ctx.day_closed ? el('div', { class: 'warn' }, 'วันนี้ปิดยอดประจำวันแล้ว การบันทึกเพิ่มต้องได้รับอนุมัติจากเจ้าของ') : null,
      s.is_closed ? el('div', { class: 'warn' }, 'สัญญานี้ปิดหรือรียอดแล้ว ไม่สามารถรับชำระเพิ่มได้') : null,
      el(
        'div',
        { class: 'grid k4' },
        stat('ยอดที่ควรจ่าย', baht(due?.due_remaining ?? 0), {
          tone: 'gold',
          foot: due ? `งวดที่ ${due.seq} ครบกำหนด ${thaiDate(due.due_date)}` : 'ชำระครบทุกงวดแล้ว',
        }),
        stat('ดอกเบี้ยที่ควรตัด', baht(due?.interest_remaining ?? 0), { small: true }),
        stat('เงินต้นที่ควรตัด', baht(due?.principal_remaining_this ?? 0), { small: true }),
        stat('เงินต้นคงเหลือ', baht(s.principal_remaining), { small: true }),
      ),
      s.arrears_amount > 0
        ? el('div', { class: 'warn mt' }, `ค้างชำระ ${s.arrears_installments} งวด รวม ${baht(s.arrears_amount)} บาท`)
        : null,
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'ยอดที่ลูกค้าจ่ายจริง'),
      quickButtons,
      el('div', { class: 'mt' }, field('จำนวนเงิน (บาท)', amount)),
      el('div', { class: 'grid k2' }, field('วันที่รับเงิน', paidDate), field('หมายเหตุ', note)),
      c.type === 'floating' || s.principal_remaining > 0
        ? el('label', { class: 'rowline', style: 'margin:.2rem 0 .6rem' },
            el('span', { class: 'small' }, 'ส่วนที่เกินจากงวดปัจจุบันให้ตัดเงินต้น (ชำระต้น/ปิดก่อนกำหนด)'),
            el('span', { style: 'flex:none;width:auto' }, extraToPrincipal))
        : null,
      field('แนบรูปใบรับเงิน (ถ้ามี)', proof),
      result,
      el('div', { class: 'mt' }, submit),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'รายการล่าสุดของสัญญานี้'),
      table(
        ['วันที่', 'ใบรับเงิน', { label: 'จ่ายจริง', num: true }, { label: 'ดอก', num: true }, { label: 'ต้น', num: true }, 'สถานะ'],
        ctx.recent.map((p) =>
          el(
            'tr',
            {},
            el('td', { class: 'small nowrap' }, thaiDate(p.paid_date)),
            el('td', { class: 'small' }, p.receipt_no),
            el('td', { class: 'num' }, baht(p.amount_paid)),
            el('td', { class: 'num' }, baht(p.interest_amount)),
            el('td', { class: 'num' }, baht(p.principal_amount)),
            el('td', {}, badge(p.status, PAYMENT_STATUS[p.status])),
          ),
        ),
        'ยังไม่มีการชำระ',
      ),
      el('div', { class: 'mt' },
        el('a', { href: `#/contracts/${contractId}`, class: 'btn ghost sm', style: 'text-decoration:none' }, 'ดูสัญญาฉบับเต็ม')),
    ),
  );

  if (s.is_closed) submit.disabled = true;
  return box;
}

/** ใบรับชำระสำหรับพิมพ์หรือถ่ายภาพส่งลูกค้า (SRS ข้อ 16) */
function showReceipt(p) {
  import('../core.js').then(({ modal }) => {
    modal('ใบรับชำระ', (close) =>
      el(
        'div',
        {},
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เลขที่'), el('span', { class: 'v' }, p.receipt_no)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'วันที่'), el('span', { class: 'v' }, thaiDate(p.paid_date))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ลูกหนี้'), el('span', { class: 'v' }, p.debtor_name)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'สัญญา'), el('span', { class: 'v' }, p.contract_no)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ดอกเบี้ย'), el('span', { class: 'v' }, baht(p.interest_amount))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินต้น'), el('span', { class: 'v' }, baht(p.principal_amount))),
        el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'รับเงินทั้งสิ้น'), el('span', { class: 'v' }, `${baht(p.amount_paid)} บาท`)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ผู้รับเงิน'), el('span', { class: 'v' }, p.received_by_name ?? '-')),
        el(
          'div',
          { class: 'btn-row mt no-print' },
          el('button', { class: 'btn', onclick: () => window.print() }, 'พิมพ์'),
          el('button', { class: 'btn ghost', onclick: close }, 'ปิด'),
        ),
      ),
    );
  });
}
