// ระบบรายรับ-รายจ่ายประจำวัน และการปิดยอด — SRS ข้อ 10
import {
  api, el, clear, table, badge, stat, field, modal, toast, toastError, baht, toSatang,
  thaiDate, todayISO, can, PAYMENT_STATUS, confirmWithReason, readFileAsDataUrl,
} from '../core.js';

export async function renderCashbook() {
  const wrap = el('div', {});
  const dateInput = el('input', { type: 'date', value: todayISO(), style: 'width:auto' });
  const body = el('div', {});

  async function load() {
    clear(body).append(el('div', { class: 'empty' }, 'กำลังโหลด…'));
    const d = await api.get(`/api/cashbook/day?date=${dateInput.value}`);
    clear(body).append(renderDay(d, load));
  }

  dateInput.addEventListener('change', load);

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h2', {}, 'รายรับ-รายจ่ายประจำวัน')),
      el('div', { class: 'btn-row' }, dateInput),
    ),
    body,
  );
  await load();
  return wrap;
}

function renderDay(d, reload) {
  const s = d.summary;
  const box = el('div', {});
  const locked = Boolean(d.closing);

  box.append(
    el(
      'div',
      { class: 'grid k4' },
      stat('เงินรับทั้งหมด', baht(s.total_in), { small: true }),
      stat('เงินจ่ายทั้งหมด', baht(s.total_out), { small: true }),
      stat('เงินสดสุทธิ', baht(s.net_cash), { tone: s.net_cash >= 0 ? 'pos' : 'neg' }),
      stat('เงินทุนหมุนกลับ', baht(s.principal_back), { small: true, foot: 'เงินต้นที่ได้รับคืน' }),
      stat('รายได้จริง', baht(s.real_income), { small: true, foot: 'ดอกเบี้ย + ค่าทำเอกสาร + อื่น ๆ' }),
      stat('ค่าใช้จ่ายดำเนินงาน', baht(s.operating_expense), { small: true }),
      can('profit_view')
        ? stat('กำไรสุทธิ', baht(s.net_profit), { tone: s.net_profit >= 0 ? 'pos' : 'neg' })
        : null,
      stat('เงินปล่อยใหม่', baht(s.disbursed_out), { small: true, foot: 'เงินทุน ไม่ใช่ค่าใช้จ่าย' }),
      s.capital_in || s.capital_out
        ? stat('เงินทุนเจ้าของ', `+${baht(s.capital_in)} / -${baht(s.capital_out)}`, {
            small: true, foot: 'นำเข้า / ถอน — ไม่นับเป็นกำไร',
          })
        : null,
    ),
  );

  if (locked) {
    box.append(
      el(
        'div',
        { class: 'info' },
        `ปิดยอดวันนี้แล้วเมื่อ ${d.closing.closed_at} — ยอดตามระบบ ${baht(d.closing.system_cash)} / เงินสดจริง ${baht(d.closing.actual_cash)} / ส่วนต่าง ${baht(d.closing.difference)}`,
      ),
    );
  }

  // ปุ่มเพิ่มรายการ
  box.append(
    el(
      'div',
      { class: 'btn-row no-print', style: 'margin-bottom:1rem' },
      el('button', { class: 'btn', disabled: locked, onclick: () => openEntryForm('expense', d, reload) }, '+ บันทึกรายจ่าย'),
      el('button', { class: 'btn ghost', disabled: locked, onclick: () => openEntryForm('income', d, reload) }, '+ บันทึกรายรับอื่น'),
      el('button', { class: 'btn ghost', disabled: locked, onclick: () => openCapitalForm(d, reload) }, '± เงินทุนเจ้าของ'),
      can('daily_closing') && !locked
        ? el('button', { class: 'btn gold', onclick: () => openClosing(d, reload) }, 'ปิดยอดประจำวัน')
        : null,
      el('a', {
        href: `/api/cashbook/export?from=${d.date}&to=${d.date}`,
        class: 'btn ghost', style: 'text-decoration:none',
      }, 'ส่งออก Excel'),
    ),
  );

  // เงินรับจากลูกหนี้
  box.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `เงินรับจากลูกหนี้ (${d.payments.length} รายการ)`),
      table(
        ['ใบรับเงิน', 'ลูกหนี้', { label: 'รับจริง', num: true }, { label: 'ดอกเบี้ย', num: true }, { label: 'เงินต้น', num: true }, 'สถานะ', 'ผู้รับเงิน'],
        d.payments.map((p) =>
          el(
            'tr',
            {},
            el('td', { class: 'small' }, p.receipt_no),
            el('td', { class: 'small' }, p.debtor_name),
            el('td', { class: 'num' }, baht(p.amount_paid)),
            el('td', { class: 'num' }, baht(p.interest_amount)),
            el('td', { class: 'num' }, baht(p.principal_amount)),
            el('td', {}, badge(p.status, PAYMENT_STATUS[p.status])),
            el('td', { class: 'small' }, p.received_by_name ?? '-'),
          ),
        ),
        'ยังไม่มีการรับชำระวันนี้',
      ),
    ),
  );

  // รายรับอื่น
  box.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'รายรับอื่น'),
      table(
        ['หมวด', 'รายละเอียด', { label: 'จำนวนเงิน', num: true }, ''],
        d.income.map((i) =>
          el(
            'tr',
            { style: i.is_void ? 'opacity:.5;text-decoration:line-through' : '' },
            el('td', { class: 'small' },
              i.category === 'doc_fee' ? 'ค่าทำเอกสาร'
                : i.category === 'capital' ? 'เงินทุนที่เจ้าของนำเข้า'
                  : i.category),
            el('td', { class: 'small' }, i.description ?? '-'),
            el('td', { class: 'num' }, baht(i.amount)),
            el('td', {}, !i.is_void && !locked
              ? voidButton(`/api/cashbook/income/${i.id}/void`, reload)
              : null),
          ),
        ),
        'ไม่มีรายรับอื่น',
      ),
    ),
  );

  // รายจ่าย
  box.append(
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'รายจ่าย'),
      table(
        ['หมวด', 'รายละเอียด', { label: 'จำนวนเงิน', num: true }, 'ผู้บันทึก', 'หลักฐาน', ''],
        d.expenses.map((e) =>
          el(
            'tr',
            { style: e.is_void ? 'opacity:.5;text-decoration:line-through' : '' },
            el('td', { class: 'small' }, e.category),
            el('td', { class: 'small' }, e.description ?? '-'),
            el('td', { class: 'num' }, baht(e.amount)),
            el('td', { class: 'small' }, e.created_by_name ?? '-'),
            el('td', {}, e.receipt_path
              ? el('a', { href: e.receipt_path, target: '_blank' }, '📎')
              : '-'),
            el('td', {}, !e.is_void && !locked
              ? voidButton(`/api/cashbook/expenses/${e.id}/void`, reload)
              : null),
          ),
        ),
        'ไม่มีรายจ่าย',
      ),
    ),
  );

  return box;
}

function voidButton(url, reload) {
  return el('button', {
    class: 'btn danger sm no-print',
    onclick: () =>
      confirmWithReason('ยกเลิกรายการ', 'ระบบจะไม่ลบข้อมูล แต่เปลี่ยนสถานะเป็นยกเลิกและเก็บ Audit Log', async (reason) => {
        await api.post(url, { reason });
        toast('ยกเลิกรายการแล้ว', 'ok');
        reload();
      }),
  }, 'ยกเลิก');
}

function openEntryForm(kind, d, reload) {
  const isExpense = kind === 'expense';
  modal(isExpense ? 'บันทึกรายจ่าย' : 'บันทึกรายรับอื่น', (close) => {
    const cats = isExpense ? d.categories.expense : d.categories.income;
    const catSel = el('select', {}, cats.map((c) => el('option', { value: c }, c)));
    const amount = el('input', { type: 'number', inputmode: 'decimal', step: '0.01' });
    const desc = el('input', { placeholder: 'รายละเอียด' });
    const receipt = el('input', { type: 'file', accept: 'image/*' });
    const empSel = el('select', {}, el('option', { value: '' }, 'ไม่ระบุพนักงาน'));

    if (isExpense) {
      api.get('/api/admin/employees').then(({ items }) => {
        for (const e of items) empSel.append(el('option', { value: e.id }, `${e.code} ${e.full_name}`));
      });
    }

    const save = el(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          try {
            const payload = {
              entry_date: d.date,
              category: catSel.value,
              amount: toSatang(amount.value),
              description: desc.value.trim() || null,
            };
            if (isExpense) {
              payload.employee_id = empSel.value ? Number(empSel.value) : null;
              if (receipt.files[0]) payload.receipt_data_url = await readFileAsDataUrl(receipt.files[0]);
              await api.post('/api/cashbook/expenses', payload);
            } else {
              await api.post('/api/cashbook/income', payload);
            }
            toast('บันทึกแล้ว', 'ok');
            close();
            reload();
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
      field('หมวด', catSel),
      field('จำนวนเงิน (บาท)', amount),
      field('รายละเอียด', desc),
      isExpense ? field('พนักงานที่เกี่ยวข้อง', empSel) : null,
      isExpense ? field('แนบรูปใบเสร็จ', receipt) : null,
      el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}

/** ปิดยอดประจำวัน + เปรียบเทียบเงินสดจริงกับระบบ (ข้อ 10.3) */
function openClosing(d, reload) {
  modal('ปิดยอดประจำวัน', (close) => {
    const actual = el('input', { type: 'number', step: '0.01', inputmode: 'decimal', value: (d.summary.net_cash / 100).toFixed(2) });
    const note = el('textarea', { rows: 2 });
    const diff = el('div', { class: 'kv total' });

    const updateDiff = () => {
      const v = toSatang(actual.value) - d.summary.net_cash;
      clear(diff).append(
        el('span', { class: 'k' }, 'ส่วนต่าง'),
        el('span', { class: 'v', style: v === 0 ? '' : `color:var(--${v > 0 ? 'green' : 'red'})` }, `${baht(v)} บาท`),
      );
    };
    actual.addEventListener('input', updateDiff);
    updateDiff();

    const save = el(
      'button',
      {
        class: 'btn gold',
        onclick: async () => {
          try {
            await api.post('/api/cashbook/closing', {
              date: d.date,
              actual_cash: toSatang(actual.value),
              note: note.value.trim() || null,
            });
            toast('ปิดยอดประจำวันแล้ว', 'ok');
            close();
            reload();
          } catch (err) {
            toastError(err);
          }
        },
      },
      'ยืนยันปิดยอด',
    );

    return el(
      'div',
      {},
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินรับทั้งหมด'), el('span', { class: 'v' }, baht(d.summary.total_in))),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินจ่ายทั้งหมด'), el('span', { class: 'v' }, baht(d.summary.total_out))),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'เงินสดสุทธิตามระบบ'), el('span', { class: 'v' }, baht(d.summary.net_cash))),
      field('เงินสดจริงที่นับได้ (บาท)', actual),
      diff,
      field('หมายเหตุ', note),
      el('div', { class: 'warn mt' }, 'เมื่อปิดยอดแล้ว การแก้ไขรายการของวันนี้ต้องได้รับอนุมัติจากเจ้าของ'),
      el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}


/** นำเงินทุนเข้า/ถอนทุน — เป็นการเคลื่อนไหวของทุน ไม่ใช่รายได้หรือค่าใช้จ่าย */
function openCapitalForm(d, reload) {
  modal('เงินทุนเจ้าของ', (close) => {
    const dir = el(
      'select',
      {},
      el('option', { value: 'in' }, 'นำเงินทุนเข้า'),
      el('option', { value: 'out' }, 'ถอนเงินทุน / เงินปันผล'),
    );
    const amount = el('input', { type: 'number', inputmode: 'decimal', step: '0.01' });
    const desc = el('input', { placeholder: 'รายละเอียด' });

    const save = el(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          try {
            const payload = {
              entry_date: d.date,
              amount: toSatang(amount.value),
              description: desc.value.trim() || null,
            };
            if (dir.value === 'in') {
              await api.post('/api/cashbook/income', { ...payload, category: d.capital_in_category });
            } else {
              await api.post('/api/cashbook/expenses', { ...payload, category: d.capital_out_category });
            }
            toast('บันทึกแล้ว', 'ok');
            close();
            reload();
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
      el('div', { class: 'info' }, 'รายการนี้กระทบเงินสดและเงินทุน แต่ไม่นับเป็นรายได้หรือค่าใช้จ่ายในการคำนวณกำไร'),
      field('ประเภท', dir),
      field('จำนวนเงิน (บาท)', amount),
      field('รายละเอียด', desc),
      el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}
