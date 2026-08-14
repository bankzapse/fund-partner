// เมนูถอนเงิน (สเปกข้อ 33-40) — ถอนดอกเบี้ย / ถอนรายได้ดอกลอย / ประวัติการถอน
import {
  api, el, clear, table, badge, stat, field, toast, toastError, baht, toSatang,
  thaiDate, todayISO,
} from '../core.js';

export async function renderWithdraw() {
  const wrap = el('div', {});
  const body = el('div', {});

  async function load() {
    const d = await api.get('/api/withdraw');
    clear(body).append(
      balanceCard(d),
      zoneCard(d),
      formCard(d, load),
      historyCard(d.history, load),
    );
  }

  wrap.append(
    el('div', { class: 'page-head' }, el('div', {},
      el('h2', {}, 'ถอนเงิน'),
      el('div', { class: 'sub' },
        'ถอนได้เฉพาะดอกเบี้ยที่รับรู้แล้ว — สัญญาเหมารวมที่ยังไม่ปิด/ไม่รียอด ยังถอนไม่ได้'))),
    body,
  );
  await load();
  return wrap;
}

/** ยอดรวมทั้งกิจการ (ข้อ 34: รับรู้สะสม − ถอนสะสม = คงเหลือ) */
function balanceCard(d) {
  const c = d.total.contract_interest;
  const f = d.total.floating_interest;
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ยอดรวมทั้งกิจการ'),
    el('div', { class: 'grid k3' },
      stat('ดอกเบี้ยรับรู้สะสม', baht(c.recognized), { small: true }),
      stat('ถอนออกใช้สะสม', baht(c.withdrawn), { small: true }),
      stat('ดอกเบี้ยคงเหลือ', baht(c.remaining), { tone: c.remaining >= 0 ? 'pos' : 'neg' }),
    ),
    el('div', { class: 'grid k3 mt' },
      stat('รายได้ดอกลอยสะสม', baht(f.recognized), { small: true }),
      stat('ถอนดอกลอยสะสม', baht(f.withdrawn), { small: true }),
      stat('ดอกลอยคงเหลือ', baht(f.remaining), { tone: f.remaining >= 0 ? 'pos' : 'neg' }),
    ),
  );
}

/** แยกรายโซน/พนักงาน (ข้อ 36) */
function zoneCard(d) {
  const rows = (d.zones ?? []).filter(
    (z) => z.balance.contract_interest.recognized > 0 || z.balance.floating_interest.recognized > 0,
  );
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'แยกตามโซน / พนักงาน'),
    table(
      ['โซน', { label: 'ดอกรับรู้', num: true }, { label: 'ถอนแล้ว', num: true }, { label: 'ดอกคงเหลือ', num: true },
       { label: 'ดอกลอยรับรู้', num: true }, { label: 'ดอกลอยคงเหลือ', num: true }],
      rows.map((z) =>
        el(
          'tr',
          {},
          el('td', {}, `${z.employee.full_name} (${z.employee.code})`),
          el('td', { class: 'num' }, baht(z.balance.contract_interest.recognized)),
          el('td', { class: 'num' }, baht(z.balance.contract_interest.withdrawn)),
          el('td', { class: 'num' }, baht(z.balance.contract_interest.remaining)),
          el('td', { class: 'num' }, baht(z.balance.floating_interest.recognized)),
          el('td', { class: 'num' }, baht(z.balance.floating_interest.remaining)),
        ),
      ),
      'ยังไม่มีดอกเบี้ยที่รับรู้ในโซนใด',
    ),
    el('div', { class: 'hint' },
      'การถอนที่ไม่ระบุโซนจะตัดจากยอดรวมทั้งกิจการ ไม่กระทบยอดรายโซน'),
  );
}

/** ฟอร์มถอน (ข้อ 35) */
function formCard(d, onDone) {
  const source = el('select', {},
    el('option', { value: 'contract_interest' }, 'ดอกเบี้ยตามสัญญา'),
    el('option', { value: 'floating_interest' }, 'รายได้ดอกลอย'),
  );
  const amount = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0' });
  const date = el('input', { type: 'date', value: todayISO() });
  const zone = el('select', {},
    el('option', { value: '' }, 'ไม่ระบุ (ตัดจากยอดรวม)'),
    (d.zones ?? []).map((z) =>
      el('option', { value: z.employee.id }, `${z.employee.full_name} (${z.employee.code})`)),
  );
  const method = el('select', {},
    el('option', { value: 'cash' }, 'เงินสด'),
    el('option', { value: 'transfer' }, 'โอน'),
  );
  const note = el('input', { placeholder: 'หมายเหตุ (ถ้ามี)' });
  const submit = el('button', { class: 'btn' }, 'บันทึกการถอน');

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      await api.post('/api/withdraw', {
        source: source.value,
        amount: toSatang(amount.value),
        withdraw_date: date.value,
        employee_id: zone.value ? Number(zone.value) : null,
        method: method.value,
        note: note.value.trim() || null,
      });
      toast('บันทึกการถอนแล้ว', 'ok');
      onDone();
    } catch (err) {
      // ข้อ 38: ถอนเกินคงเหลือ — เจ้าของยืนยันเป็นรายการปรับปรุงพิเศษพร้อมเหตุผลได้
      if (String(err.message).includes('มากกว่า') && String(err.message).includes('คงเหลือ')) {
        const reason = prompt(err.message + '\n\nถ้าต้องการบันทึกเป็นรายการปรับปรุงพิเศษ กรอกเหตุผล:');
        if (reason && reason.trim()) {
          try {
            await api.post('/api/withdraw', {
              source: source.value,
              amount: toSatang(amount.value),
              withdraw_date: date.value,
              employee_id: zone.value ? Number(zone.value) : null,
              method: method.value,
              note: note.value.trim() || null,
              owner_override: true,
              reason: reason.trim(),
            });
            toast('บันทึกรายการปรับปรุงพิเศษแล้ว', 'ok');
            onDone();
          } catch (e2) { toastError(e2); }
        }
      } else {
        toastError(err);
      }
      submit.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'บันทึกการถอน'),
    el('div', { class: 'grid k2' },
      field('แหล่งเงิน *', source, 'ดอกลอยแยกจากดอกตามสัญญา ห้ามปนกัน'),
      field('จำนวนเงิน (บาท) *', amount)),
    el('div', { class: 'grid k2' },
      field('วันที่ถอน', date),
      field('โซน / พนักงาน', zone)),
    el('div', { class: 'grid k2' },
      field('วิธีรับเงิน', method),
      field('หมายเหตุ', note)),
    el('div', { class: 'mt' }, submit),
  );
}

/** ประวัติการถอน + ยกเลิก (ข้อ 40: ไม่ลบถาวร ยอดคืนอัตโนมัติ) */
function historyCard(items, onDone) {
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ประวัติการถอน'),
    table(
      ['วันที่', 'ประเภท', { label: 'จำนวน', num: true }, 'โซน', 'รายละเอียด', 'ผู้บันทึก', 'สถานะ', ''],
      (items ?? []).map((x) =>
        el(
          'tr',
          { style: x.is_void ? 'opacity:.5;text-decoration:line-through' : '' },
          el('td', { class: 'small nowrap' }, thaiDate(x.entry_date)),
          el('td', { class: 'small' }, x.category),
          el('td', { class: 'num' }, baht(x.amount)),
          el('td', { class: 'small' }, x.employee_name ? `${x.employee_name} (${x.employee_code})` : 'ยอดรวม'),
          el('td', { class: 'small' }, x.description ?? '-'),
          el('td', { class: 'small' }, x.created_by_name ?? '-'),
          el('td', {}, x.is_void ? badge('void', 'ยกเลิกแล้ว') : badge('normal', 'ปกติ')),
          el('td', {},
            !x.is_void
              ? el('button', {
                  class: 'btn ghost sm',
                  onclick: async () => {
                    const reason = prompt('เหตุผลการยกเลิกรายการถอนนี้ (ยอดจะคืนเข้าดอกเบี้ยคงเหลืออัตโนมัติ):');
                    if (!reason || !reason.trim()) return;
                    try {
                      await api.post(`/api/cashbook/expenses/${x.id}/void`, { reason: reason.trim() });
                      toast('ยกเลิกรายการถอนแล้ว ยอดคืนเข้าคงเหลือ', 'ok');
                      onDone();
                    } catch (err) { toastError(err); }
                  },
                }, 'ยกเลิก')
              : null),
        ),
      ),
      'ยังไม่มีการถอน',
    ),
  );
}
