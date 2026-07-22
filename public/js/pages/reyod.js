// ระบบรียอด / ทำสัญญาใหม่ — SRS ข้อ 9
import {
  api, state, el, clear, table, badge, stat, field, toast, toastError, baht, toSatang,
  thaiDate, todayISO, CONTRACT_TYPE, CONTRACT_STATUS,
} from '../core.js';

export async function renderReyod({ contractId } = {}) {
  const wrap = el('div', {});
  wrap.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, 'รียอด / ทำสัญญาใหม่'),
      el('div', { class: 'sub' }, 'ปิดสัญญาเดิมและยกยอดคงเหลือเข้าสัญญาใหม่ โดยไม่ลบประวัติเดิม'))),
  );

  if (!contractId) {
    const search = el('input', { type: 'search', placeholder: 'ค้นหา เลขที่สัญญา / ชื่อลูกหนี้' });
    const results = el('div', {});
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const { items } = await api.get(
          `/api/contracts?q=${encodeURIComponent(search.value.trim())}&status=active`,
        );
        clear(results).append(
          table(
            ['เลขที่สัญญา', 'ลูกหนี้', { label: 'ยอดคงเหลือ', num: true }, ''],
            items.map((c) =>
              el(
                'tr',
                {},
                el('td', { class: 'small' }, c.contract_no),
                el('td', {}, c.debtor_name),
                el('td', { class: 'num' }, baht(c.outstanding ?? c.principal_remaining)),
                el('td', {}, el('a', {
                  href: `#/reyod/${c.id}`, class: 'btn sm', style: 'text-decoration:none',
                }, 'เลือก')),
              ),
            ),
            'ไม่พบสัญญาที่ยังใช้งาน',
          ),
        );
      }, 300);
    });
    wrap.append(el('div', { class: 'card' }, el('h3', {}, 'เลือกสัญญาเดิม'), search, results));
    return wrap;
  }

  wrap.append(await reyodForm(Number(contractId)));
  return wrap;
}

async function reyodForm(fromContractId) {
  const box = el('div', {});
  const newMoney = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', value: '0' });
  const typeSel = el('select', {}, Object.entries(CONTRACT_TYPE).map(([v, l]) => el('option', { value: v }, l)));
  const installment = el('input', { type: 'number', inputmode: 'decimal', step: '0.01' });
  // สัญญาโหมดดอกเหมารวมใช้อัตรา % ไม่ใช่ค่างวดกับดอกต่องวด
  const ratePct = el('input', { type: 'number', inputmode: 'decimal', step: '0.01' });
  let flatMode = false;
  const interest = el('input', { type: 'number', inputmode: 'decimal', step: '0.01' });
  const periods = el('input', { type: 'number', inputmode: 'numeric' });
  const startDate = el('input', { type: 'date', value: todayISO() });
  const docFee = el('input', {
    type: 'number', step: '0.01',
    value: (Number(state.settings.doc_fee ?? 10000) / 100).toFixed(2),
  });
  const note = el('textarea', { rows: 2 });
  const info = el('div', { class: 'card' });
  const result = el('div', { class: 'card' });
  const submit = el('button', { class: 'btn block', disabled: true }, 'ยืนยันรียอด');

  function body() {
    return {
      from_contract_id: fromContractId,
      new_money: toSatang(newMoney.value),
      type: typeSel.value,
      interest_mode: flatMode ? 'flat_total' : 'per_installment',
      interest_rate_bp: flatMode ? Math.round(Number(ratePct.value || 0) * 100) : undefined,
      installment_amount: toSatang(installment.value),
      interest_per_inst: toSatang(interest.value),
      num_installments: Number(periods.value || 0),
      start_date: startDate.value,
      doc_fee: toSatang(docFee.value),
      note: note.value.trim() || null,
    };
  }

  // เติมค่าตั้งต้นจากสัญญาเดิม
  const rateRow = el('div', {}, field('ดอกเบี้ยต่อสัญญา (%)', ratePct,
    'คิดจากยอดตั้งต้นของสัญญาใหม่ทั้งก้อน'));
  const legacyRow = el('div', { class: 'grid k2' },
    field('ค่างวด (บาท)', installment),
    field('ดอกเบี้ยต่องวด (บาท)', interest));

  const first = await api.post('/api/contracts/reyod/preview', { from_contract_id: fromContractId, new_money: 0 });
  const old = first.preview.old_contract;
  typeSel.value = old.type;
  installment.value = (old.installment_amount / 100).toFixed(2);
  interest.value = (old.interest_per_inst / 100).toFixed(2);
  periods.value = String(old.num_installments);
  // สืบทอดโหมดจากสัญญาเดิม แล้วซ่อนช่องที่ระบบไม่ได้ใช้ในโหมดนั้น
  flatMode = old.interest_mode === 'flat_total';
  ratePct.value = ((old.interest_rate_bp ?? 0) / 100).toFixed(2);
  rateRow.style.display = flatMode ? '' : 'none';
  legacyRow.style.display = flatMode ? 'none' : '';

  async function refresh() {
    installment.disabled = typeSel.value === 'floating';
    if (typeSel.value === 'floating') installment.value = interest.value;
    try {
      const { preview } = await api.post('/api/contracts/reyod/preview', body());
      submit.disabled = false;

      clear(info).append(
        el('h3', {}, `สัญญาเดิม ${preview.old_contract.contract_no}`),
        el('div', { class: 'grid k4' },
          stat('เงินต้นตามสัญญาเดิม', baht(preview.old_contract.principal_amount), { small: true }),
          stat(
            preview.outstanding_detail?.mode === 'flat_total' ? 'ชำระมาแล้วทั้งหมด' : 'เงินต้นที่ตัดแล้ว',
            baht(preview.principal_paid_before), { small: true },
          ),
          stat('ยอดคงเหลือสัญญาเดิม', baht(preview.carried_outstanding ?? preview.carried_principal), { small: true, tone: 'gold' }),
          stat('ยอดค้างสะสม', baht(preview.old_summary.arrears_amount), {
            small: true, tone: preview.old_summary.arrears_amount > 0 ? 'neg' : '',
          })),
        el('div', { class: 'hint mt' },
          `ลูกหนี้: ${preview.old_contract.debtor_name} · ดอกเบี้ยที่รับไปแล้ว ${baht(preview.old_summary.total_interest_received)} บาท`),
        // ยอดที่ยกไปจะกลายเป็นฐานคิดดอกของสัญญาใหม่ ผู้ใช้ควรเห็นว่าในนั้นมีดอกเดิมเท่าไร
        preview.outstanding_detail?.interest_part > 0
          ? el('div', { class: 'warn mt' },
              `ยอดคงเหลือ ${baht(preview.carried_outstanding)} บาท ประกอบด้วยเงินต้น ` +
              `${baht(preview.outstanding_detail.principal_part)} บาท และดอกเบี้ยเดิมที่ยังไม่ได้รับ ` +
              `${baht(preview.outstanding_detail.interest_part)} บาท — ดอกของสัญญาใหม่จะคิดจากยอดนี้ทั้งก้อน`)
          : null,
      );

      clear(result).append(
        el('h3', {}, 'ตรวจสอบก่อนยืนยัน'),
        ...preview.preview.warnings.map((w) => el('div', { class: 'warn' }, w)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'ยอดคงเหลือสัญญาเดิม (ยกเข้าสัญญาใหม่)'),
          el('span', { class: 'v' }, baht(preview.carried_outstanding ?? preview.carried_principal))),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินเพิ่มใหม่'), el('span', { class: 'v' }, `+ ${baht(preview.new_money)}`)),
        el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'ยอดสัญญาใหม่'),
          el('span', { class: 'v' }, `${baht(preview.preview.principalAmount)} บาท`)),
        el('div', { class: 'kv mt' }, el('span', { class: 'k' }, 'หักค่าทำเอกสาร'), el('span', { class: 'v' }, `- ${baht(preview.preview.doc_fee)}`)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'หักงวดแรก'), el('span', { class: 'v' }, `- ${baht(preview.preview.first_installment)}`)),
        el('div', { class: 'kv total' }, el('span', { class: 'k' }, 'เงินสดที่ลูกค้าได้รับจริง'),
          el('span', { class: 'v' }, `${baht(preview.preview.cash_to_customer)} บาท`)),
        el(
          'div',
          { class: 'info mt' },
          preview.cash_basis === 'new_money'
            ? 'คำนวณเงินสดจาก "เงินเพิ่มใหม่" เท่านั้น เพื่อไม่ให้แสดงว่าจ่ายเงินสดซ้ำในส่วนเงินต้นเดิม (ปรับได้ที่หน้าตั้งค่า)'
            : 'คำนวณเงินสดจากยอดสัญญาใหม่ทั้งก้อน (ตั้งค่าไว้แบบ "ยอดเต็ม")',
        ),
      );
    } catch (err) {
      submit.disabled = true;
      clear(result).append(el('div', { class: 'warn' }, err.message));
    }
  }

  for (const input of [newMoney, typeSel, ratePct, installment, interest, periods, startDate, docFee]) {
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
  }

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const res = await api.post('/api/contracts/reyod', body());
      if (res.pending_approval) {
        toast('ส่งคำขอรียอดให้เจ้าของอนุมัติแล้ว', 'ok');
        location.hash = '#/contracts';
        return;
      }
      toast(`สร้างสัญญาใหม่ ${res.new_contract.contract_no} แล้ว`, 'ok');
      location.hash = `#/contracts/${res.new_contract.id}`;
    } catch (err) {
      toastError(err);
      submit.disabled = false;
    }
  });

  box.append(
    info,
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'เงื่อนไขสัญญาใหม่'),
      field('เงินเพิ่มใหม่ (บาท)', newMoney, 'ใส่ 0 หากรียอดโดยไม่เพิ่มเงิน'),
      field('ประเภทสัญญา', typeSel),
      el(
        'div',
        { class: 'grid k2' },
        field('จำนวนงวด', periods),
      ),
      rateRow,
      legacyRow,
      el(
        'div',
        { class: 'grid k2' },
        field('วันเริ่มสัญญา', startDate),
        field('ค่าทำเอกสาร (บาท)', docFee),
      ),
      field('หมายเหตุ', note),
    ),
    result,
    submit,
  );

  await refresh();
  return box;
}
