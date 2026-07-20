// ระบบลูกหนี้ — SRS ข้อ 6
import {
  api, el, clear, table, badge, stat, field, modal, toast, toastError, baht, thaiDate, can, DEBTOR_STATUS, CONTRACT_STATUS, CONTRACT_TYPE, BEHAVIOUR, PAYMENT_STATUS, readFileAsDataUrl, skTable,
} from '../core.js';

export async function renderDebtors() {
  const wrap = el('div', {});
  const search = el('input', { placeholder: 'ค้นหา ชื่อ / เบอร์โทร / รหัสลูกหนี้ / เลขที่สัญญา', type: 'search' });
  const statusSel = el(
    'select',
    {},
    el('option', { value: '' }, 'ทุกสถานะ'),
    Object.entries(DEBTOR_STATUS).map(([v, l]) => el('option', { value: v }, l)),
  );
  const list = el('div', { class: 'card' });

  async function load() {
    clear(list).append(skTable(6, 6));
    const q = encodeURIComponent(search.value.trim());
    const data = await api.get(`/api/debtors?q=${q}&status=${statusSel.value}`);
    const rows = data.items.map((d) =>
      el(
        'tr',
        {},
        el('td', {},
          el('a', { href: `#/debtors/${d.id}` }, d.full_name),
          el('div', { class: 'small muted' }, d.code)),
        el('td', { class: 'small' }, d.phone ?? '-'),
        el('td', { class: 'small' }, d.employee_name ?? '-'),
        el('td', { class: 'num' }, String(d.active_contracts)),
        el('td', { class: 'num' }, baht(d.principal_outstanding)),
        el('td', {}, badge(d.status, DEBTOR_STATUS[d.status] ?? d.status)),
      ),
    );
    clear(list).append(
      el('h3', {}, `รายชื่อลูกหนี้ (${data.items.length})`),
      table(
        ['ลูกหนี้', 'เบอร์โทร', 'ผู้ดูแล', { label: 'สัญญาที่ใช้งาน', num: true }, { label: 'เงินต้นคงเหลือ', num: true }, 'สถานะ'],
        rows,
        'ไม่พบลูกหนี้',
      ),
    );
  }

  search.addEventListener('input', debounce(load, 300));
  statusSel.addEventListener('change', load);

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h2', {}, 'ลูกหนี้'), el('div', { class: 'sub' }, 'ลูกหนี้ 1 คนมีได้หลายสัญญา ประวัติรวมอยู่ในหน้าเดียว')),
      el(
        'div',
        { class: 'btn-row' },
        el('a', { href: '/api/debtors/export', class: 'btn ghost sm', style: 'text-decoration:none' }, 'ส่งออก Excel'),
        can('debtors_edit') ? el('button', { class: 'btn sm', onclick: () => openDebtorForm(null, load) }, '+ เพิ่มลูกหนี้') : null,
      ),
    ),
    el('div', { class: 'searchbar' }, search, statusSel),
    list,
  );

  await load();
  return wrap;
}

/** ประวัติรวมของลูกหนี้: สัญญา การชำระ รียอด เอกสาร (ข้อ 6) */
export async function renderDebtorDetail({ id }) {
  const d = await api.get(`/api/debtors/${id}`);
  const wrap = el('div', {});
  const outstanding = d.contracts
    .filter((c) => c.status === 'active')
    .reduce((s, c) => s + c.principal_remaining, 0);

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h2', {}, d.debtor.full_name),
        el('div', { class: 'sub' }, `${d.debtor.code} · ${d.debtor.phone ?? 'ไม่มีเบอร์โทร'} · ผู้ดูแล: ${d.debtor.employee_name ?? '-'}`),
      ),
      el(
        'div',
        { class: 'btn-row' },
        badge(d.debtor.status, DEBTOR_STATUS[d.debtor.status]),
        can('debtors_edit')
          ? el('button', { class: 'btn ghost sm', onclick: () => openDebtorForm(d.debtor, () => location.reload()) }, 'แก้ไข')
          : null,
        can('contracts_create')
          ? el('a', { href: `#/contracts/new?debtor=${d.debtor.id}`, class: 'btn sm', style: 'text-decoration:none' }, '+ สร้างสัญญา')
          : null,
      ),
    ),
    el(
      'div',
      { class: 'grid k3' },
      stat('สัญญาทั้งหมด', String(d.contracts.length), { small: true }),
      stat('เงินต้นคงเหลือรวม', baht(outstanding), { small: true }),
      stat('ที่อยู่', d.debtor.address ?? '-', { small: true }),
    ),
  );

  // สัญญาทั้งหมด
  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'สัญญาทั้งหมด'),
      table(
        ['เลขที่สัญญา', 'ประเภท', 'วันเริ่ม', { label: 'เงินต้น', num: true }, { label: 'คงเหลือ', num: true }, 'สถานะ', ''],
        d.contracts.map((c) =>
          el(
            'tr',
            {},
            el('td', {}, el('a', { href: `#/contracts/${c.id}` }, c.contract_no)),
            el('td', { class: 'small' }, CONTRACT_TYPE[c.type]),
            el('td', { class: 'small' }, thaiDate(c.start_date)),
            el('td', { class: 'num' }, baht(c.principal_amount)),
            el('td', { class: 'num' }, baht(c.principal_remaining)),
            el('td', {}, badge(c.status, CONTRACT_STATUS[c.status]),
              c.status === 'active' && c.behaviour !== 'normal'
                ? el('div', {}, badge(c.behaviour, BEHAVIOUR[c.behaviour]))
                : null),
            el(
              'td',
              {},
              c.status === 'active' && can('payments_create')
                ? el('a', { href: `#/collect/${c.id}`, class: 'btn sm', style: 'text-decoration:none' }, 'รับชำระ')
                : null,
            ),
          ),
        ),
        'ยังไม่มีสัญญา',
      ),
    ),
  );

  // ประวัติการชำระรวมทุกสัญญา
  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'ประวัติการรับชำระ'),
      table(
        ['วันที่', 'ใบรับเงิน', 'สัญญา', { label: 'จ่ายจริง', num: true }, { label: 'ดอก', num: true }, { label: 'ต้น', num: true }, 'สถานะ'],
        d.payments.map((p) =>
          el(
            'tr',
            { style: p.is_void ? 'opacity:.5;text-decoration:line-through' : '' },
            el('td', { class: 'small nowrap' }, thaiDate(p.paid_date)),
            el('td', { class: 'small' }, p.receipt_no),
            el('td', { class: 'small' }, p.contract_no),
            el('td', { class: 'num' }, baht(p.amount_paid)),
            el('td', { class: 'num' }, baht(p.interest_amount)),
            el('td', { class: 'num' }, baht(p.principal_amount)),
            el('td', {}, p.is_void ? badge('void', 'ยกเลิก') : badge(p.status, PAYMENT_STATUS[p.status])),
          ),
        ),
        'ยังไม่มีประวัติการชำระ',
      ),
    ),
  );

  // เอกสารแนบ
  const docList = el('div', { class: 'grid k3' });
  const renderDocs = (docs) => {
    clear(docList).append(
      docs.length
        ? docs.map((doc) =>
            el(
              'a',
              { href: doc.file_path, target: '_blank', class: 'stat', style: 'text-decoration:none' },
              el('div', { class: 'label' }, doc.kind),
              el('div', { class: 'value sm' }, '📎 เปิดไฟล์'),
              el('div', { class: 'foot' }, thaiDate(doc.created_at?.slice(0, 10))),
            ),
          )
        : el('div', { class: 'empty' }, 'ยังไม่มีเอกสารแนบ'),
    );
  };
  renderDocs(d.documents);

  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*,application/pdf',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        await api.post(`/api/debtors/${id}/documents`, {
          data_url: dataUrl,
          file_name: file.name,
          kind: kindSel.value,
        });
        toast('แนบเอกสารแล้ว', 'ok');
        const fresh = await api.get(`/api/debtors/${id}`);
        renderDocs(fresh.documents);
      } catch (err) {
        toastError(err);
      }
      e.target.value = '';
    },
  });
  const kindSel = el(
    'select',
    {},
    el('option', { value: 'photo' }, 'รูปถ่าย'),
    el('option', { value: 'id_card' }, 'สำเนาบัตรประชาชน'),
    el('option', { value: 'document' }, 'เอกสารประกอบ'),
    el('option', { value: 'other' }, 'อื่น ๆ'),
  );

  wrap.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'เอกสารประกอบ'),
      docList,
      can('debtors_edit')
        ? el('div', { class: 'searchbar mt no-print' }, kindSel, fileInput)
        : null,
    ),
  );

  return wrap;
}

function openDebtorForm(debtor, onDone) {
  modal(debtor ? 'แก้ไขลูกหนี้' : 'เพิ่มลูกหนี้', (close) => {
    const name = el('input', { value: debtor?.full_name ?? '' });
    const phone = el('input', { value: debtor?.phone ?? '', inputmode: 'tel' });
    const address = el('textarea', { rows: 2 }, debtor?.address ?? '');
    const area = el('input', { value: debtor?.area ?? '' });
    const note = el('textarea', { rows: 2 }, debtor?.note ?? '');
    const empSel = el('select', {}, el('option', { value: '' }, 'ยังไม่ระบุ'));
    const statusSel = el(
      'select',
      {},
      Object.entries(DEBTOR_STATUS).map(([v, l]) =>
        el('option', { value: v, selected: debtor?.status === v }, l),
      ),
    );

    api.get('/api/admin/employees').then(({ items }) => {
      for (const e of items) {
        empSel.append(el('option', { value: e.id, selected: debtor?.employee_id === e.id }, `${e.code} ${e.full_name}`));
      }
    });

    const save = el(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          const body = {
            full_name: name.value.trim(),
            phone: phone.value.trim() || null,
            address: address.value.trim() || null,
            area: area.value.trim() || null,
            note: note.value.trim() || null,
            employee_id: empSel.value ? Number(empSel.value) : null,
            status: statusSel.value,
          };
          try {
            if (debtor) await api.put(`/api/debtors/${debtor.id}`, body);
            else await api.post('/api/debtors', body);
            toast('บันทึกแล้ว', 'ok');
            close();
            onDone();
          } catch (err) {
            toastError(err);
          }
        },
      },
      'บันทึก',
    );

    return el(
      'div',
      {},
      field('ชื่อ-นามสกุล *', name),
      field('เบอร์โทร', phone),
      field('ที่อยู่', address),
      field('พนักงานผู้ดูแล', empSel),
      field('พื้นที่ / เส้นทาง / กลุ่ม', area),
      field('สถานะ', statusSel),
      field('หมายเหตุ', note),
      el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
