// ตั้งค่าระบบ, คำขออนุมัติ, Audit Log และการสำรองข้อมูล — SRS ข้อ 4, 12, 15
import {
  api, state, el, clear, table, badge, field, toast, toastError, baht, toSatang, thaiDate,
} from '../core.js';

export async function renderSettings() {
  const wrap = el('div', {});
  const body = el('div', {});

  async function load() {
    const [{ settings }, approvals, audit, backups] = await Promise.all([
      api.get('/api/admin/settings'),
      api.get('/api/admin/approvals?status=pending'),
      api.get('/api/admin/audit?limit=100'),
      api.get('/api/admin/backups').catch(() => ({ items: [] })),
    ]);
    state.settings = settings;
    clear(body).append(
      settingsCard(settings, load),
      pricingCard(settings, load),
      approvalsCard(approvals.items, load),
      backupCard(backups.items, load),
      auditCard(audit.items),
    );
  }

  wrap.append(el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, 'ตั้งค่าระบบ'))), body);
  await load();
  return wrap;
}

function settingsCard(s, reload) {
  const company = el('input', { value: s.company_name });
  const docFee = el('input', { type: 'number', step: '0.01', value: (Number(s.doc_fee) / 100).toFixed(2) });
  const deductFirst = el('input', { type: 'checkbox', checked: s.deduct_first_installment === '1' });
  const reyodBasis = el(
    'select',
    {},
    el('option', { value: 'new_money', selected: s.reyod_cash_basis === 'new_money' }, 'คำนวณจากเงินเพิ่มใหม่เท่านั้น (แนะนำ)'),
    el('option', { value: 'full', selected: s.reyod_cash_basis === 'full' }, 'คำนวณจากยอดสัญญาใหม่ทั้งก้อน'),
  );
  const timeout = el('input', { type: 'number', value: s.session_timeout_minutes });
  const overdue = el('input', { type: 'number', value: s.overdue_days_threshold });
  const expenseCats = el('textarea', { rows: 6 }, JSON.parse(s.expense_categories).join('\n'));
  const incomeCats = el('textarea', { rows: 3 }, JSON.parse(s.income_categories).join('\n'));

  const save = el(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        try {
          await api.put('/api/admin/settings', {
            settings: {
              company_name: company.value.trim(),
              doc_fee: String(toSatang(docFee.value)),
              deduct_first_installment: deductFirst.checked ? '1' : '0',
              reyod_cash_basis: reyodBasis.value,
              session_timeout_minutes: timeout.value,
              overdue_days_threshold: overdue.value,
              expense_categories: JSON.stringify(
                expenseCats.value.split('\n').map((x) => x.trim()).filter(Boolean),
              ),
              income_categories: JSON.stringify(
                incomeCats.value.split('\n').map((x) => x.trim()).filter(Boolean),
              ),
            },
          });
          toast('บันทึกการตั้งค่าแล้ว', 'ok');
          reload();
        } catch (err) {
          toastError(err);
        }
      },
    },
    'บันทึกการตั้งค่า',
  );

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ค่าตั้งต้นของระบบ'),
    el('div', { class: 'hint' }, 'อัตราค่าธรรมเนียมและกติกาทั้งหมดปรับได้ที่นี่ ไม่ได้ฝังตายในโปรแกรม'),
    field('ชื่อกิจการ', company),
    el(
      'div',
      { class: 'grid k2' },
      field('ค่าทำเอกสาร (บาท)', docFee, 'ค่าเริ่มต้น 100 บาท'),
      field('เกณฑ์ค้างชำระ (งวด)', overdue, 'ค้างกี่งวดจึงนับเป็นลูกหนี้ค้างชำระ'),
      field('Session Timeout (นาที)', timeout),
      field('ฐานคำนวณเงินสดตอนรียอด', reyodBasis),
    ),
    el('label', { class: 'rowline', style: 'margin:.5rem 0' },
      el('span', {}, 'หักงวดแรก ณ วันทำสัญญาโดยอัตโนมัติ'),
      el('span', { style: 'flex:none;width:auto' }, deductFirst)),
    el('div', { class: 'grid k2' },
      field('หมวดค่าใช้จ่าย (บรรทัดละหมวด)', expenseCats),
      field('หมวดรายรับอื่น (บรรทัดละหมวด)', incomeCats)),
    el('div', { class: 'mt' }, save),
  );
}

/**
 * แก้ราคาที่แสดงบนหน้าแนะนำระบบ (หน้า SEO)
 *
 * เก็บเป็น JSON ในตารางการตั้งค่า แล้วเซิร์ฟเวอร์เอาไปเติมลงหน้าเว็บตอนมีคนเปิด
 * จึงไม่ต้องแก้โค้ดและไม่ต้อง deploy ใหม่เมื่อเปลี่ยนราคา
 */
function pricingCard(s, reload) {
  let plans;
  try {
    plans = JSON.parse(s.pricing_plans ?? '[]');
    if (!Array.isArray(plans)) plans = [];
  } catch {
    plans = [];
  }

  const heading = el('input', { value: s.pricing_heading ?? '' });
  const subheading = el('input', { value: s.pricing_subheading ?? '' });
  const note = el('input', { value: s.pricing_note ?? '', placeholder: 'เช่น ราคายังไม่รวมภาษีมูลค่าเพิ่ม' });
  const list = el('div', { class: 'grid k2' });

  const draw = () => {
    clear(list);
    if (!plans.length) {
      list.append(el('div', { class: 'empty' }, 'ยังไม่มีแพ็กเกจ — ส่วนราคาจะถูกซ่อนจากหน้าเว็บทั้งส่วน'));
    }
    plans.forEach((p, i) => {
      const name = el('input', { value: p.name ?? '', oninput: (e) => { p.name = e.target.value; } });
      const price = el('input', { value: p.price ?? '', oninput: (e) => { p.price = e.target.value; } });
      const per = el('input', { value: p.per ?? '', oninput: (e) => { p.per = e.target.value; } });
      const cta = el('input', { value: p.cta ?? '', oninput: (e) => { p.cta = e.target.value; } });
      const features = el('textarea', {
        rows: 4,
        oninput: (e) => { p.features = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); },
      }, (p.features ?? []).join('\n'));
      const best = el('input', {
        type: 'checkbox',
        checked: Boolean(p.best),
        onchange: (e) => {
          // ให้เน้นได้ทีละแพ็กเกจเท่านั้น ถ้าเน้นหมดก็เท่ากับไม่ได้เน้นอะไรเลย
          plans.forEach((q) => { q.best = false; });
          p.best = e.target.checked;
          draw();
        },
      });

      list.append(el(
        'div',
        { class: 'card sub' },
        el('div', { class: 'rowline' },
          el('strong', {}, `แพ็กเกจที่ ${i + 1}`),
          el('button', {
            class: 'btn ghost sm',
            style: 'flex:none;width:auto',
            onclick: () => { plans.splice(i, 1); draw(); },
          }, 'ลบ')),
        field('ชื่อแพ็กเกจ', name),
        el('div', { class: 'grid k2' },
          field('ราคา', price, 'ใส่ข้อความได้ตามต้องการ เช่น ฿790 หรือ ติดต่อเรา'),
          field('ต่อรอบ', per, 'เช่น / เดือน')),
        field('รายการที่ได้ (บรรทัดละข้อ)', features),
        field('ข้อความบนปุ่ม', cta),
        el('label', { class: 'rowline', style: 'margin-top:.4rem' },
          el('span', {}, 'เน้นแพ็กเกจนี้ให้เด่นกว่าเพื่อน'),
          el('span', { style: 'flex:none;width:auto' }, best)),
      ));
    });
  };
  draw();

  const add = el('button', {
    class: 'btn ghost sm',
    onclick: () => {
      plans.push({ name: 'แพ็กเกจใหม่', price: '฿0', per: '/ เดือน', features: [], cta: 'เลือกแพ็กเกจนี้', best: false });
      draw();
    },
  }, '+ เพิ่มแพ็กเกจ');

  const save = el('button', {
    class: 'btn',
    onclick: async () => {
      const empty = plans.find((p) => !String(p.name ?? '').trim());
      if (empty) return toastError(new Error('ทุกแพ็กเกจต้องมีชื่อ'));
      try {
        await api.put('/api/admin/settings', {
          settings: {
            pricing_heading: heading.value.trim(),
            pricing_subheading: subheading.value.trim(),
            pricing_note: note.value.trim(),
            pricing_plans: JSON.stringify(plans),
          },
        });
        toast('บันทึกราคาแล้ว หน้าเว็บจะอัปเดตภายใน 5 นาที', 'ok');
        reload();
      } catch (err) {
        toastError(err);
      }
    },
  }, 'บันทึกราคา');

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ราคาบนหน้าแนะนำระบบ'),
    el('div', { class: 'hint' },
      'ราคาที่แสดงบนหน้าเว็บสาธารณะ ',
      el('a', { href: '/', target: '_blank' }, 'เปิดดูหน้าเว็บ'),
      ' — แก้แล้วกดบันทึก หน้าเว็บจะอัปเดตเองภายใน 5 นาที ไม่ต้องแก้โค้ด'),
    el('div', { class: 'grid k2' },
      field('หัวข้อ', heading),
      field('คำโปรย', subheading)),
    field('หมายเหตุใต้ตาราง', note),
    el('div', { class: 'hint mt' }, 'แพ็กเกจ'),
    list,
    el('div', { class: 'btn-row mt' }, add, save),
  );
}

function approvalsCard(items, reload) {
  const KIND = { void_payment: 'ยกเลิกรายการรับเงิน', reyod: 'รียอดสัญญา', edit_closed_day: 'แก้ไขวันที่ปิดยอดแล้ว' };
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, `คำขออนุมัติที่รอพิจารณา (${items.length})`),
    table(
      ['เวลา', 'ประเภท', 'ผู้ขอ', 'รายละเอียด', ''],
      items.map((a) =>
        el(
          'tr',
          {},
          el('td', { class: 'small nowrap' }, a.requested_at),
          el('td', { class: 'small' }, KIND[a.kind] ?? a.kind),
          el('td', { class: 'small' }, a.requested_by_name ?? '-'),
          el('td', { class: 'small mono' }, a.payload),
          el(
            'td',
            {},
            el(
              'div',
              { class: 'btn-row' },
              el('button', {
                class: 'btn sm',
                onclick: async () => {
                  try {
                    await api.post(`/api/admin/approvals/${a.id}/decide`, { approve: true });
                    toast('อนุมัติแล้ว', 'ok');
                    reload();
                  } catch (err) { toastError(err); }
                },
              }, 'อนุมัติ'),
              el('button', {
                class: 'btn danger sm',
                onclick: async () => {
                  try {
                    await api.post(`/api/admin/approvals/${a.id}/decide`, { approve: false });
                    toast('ปฏิเสธคำขอแล้ว', 'ok');
                    reload();
                  } catch (err) { toastError(err); }
                },
              }, 'ปฏิเสธ'),
            ),
          ),
        ),
      ),
      'ไม่มีคำขอรอพิจารณา',
    ),
  );
}

function backupCard(items, reload) {
  return el(
    'div',
    { class: 'card' },
    el(
      'h3',
      {},
      el('span', {}, 'สำรองข้อมูล'),
      el('button', {
        class: 'btn sm',
        onclick: async () => {
          try {
            const res = await api.post('/api/admin/backup');
            toast(`สำรองข้อมูลแล้ว: ${res.file}`, 'ok');
            reload();
          } catch (err) { toastError(err); }
        },
      }, 'สำรองข้อมูลตอนนี้'),
    ),
    el('div', { class: 'hint' }, 'ไฟล์สำรองถูกเก็บไว้ในโฟลเดอร์ backups/ ของเซิร์ฟเวอร์'),
    table(
      ['ไฟล์สำรอง'],
      items.slice(0, 10).map((f) => el('tr', {}, el('td', { class: 'small mono' }, f))),
      'ยังไม่มีไฟล์สำรอง',
    ),
  );
}

function auditCard(items) {
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ประวัติการแก้ไขล่าสุด (Audit Log)'),
    table(
      ['เวลา', 'ผู้ใช้', 'การกระทำ', 'ประเภทข้อมูล', 'รหัส', 'เหตุผล'],
      items.map((a) =>
        el(
          'tr',
          {},
          el('td', { class: 'small nowrap' }, a.created_at),
          el('td', { class: 'small' }, a.user_name ?? '-'),
          el('td', { class: 'small' }, a.action),
          el('td', { class: 'small' }, a.entity),
          el('td', { class: 'small mono' }, a.entity_id ?? '-'),
          el('td', { class: 'small' }, a.reason ?? '-'),
        ),
      ),
      'ยังไม่มีประวัติ',
    ),
  );
}
