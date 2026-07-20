// ระบบพนักงานและสิทธิ์ — SRS ข้อ 12
import {
  api, el, clear, table, badge, field, modal, toast, toastError, thaiDate,
} from '../core.js';

const ROLE_LABEL = { owner: 'เจ้าของ', manager: 'ผู้จัดการ', collector: 'พนักงานเก็บเงิน', accountant: 'บัญชี' };

export async function renderEmployees() {
  const wrap = el('div', {});
  const body = el('div', {});

  async function load() {
    const [users, employees] = await Promise.all([
      api.get('/api/admin/users'),
      api.get('/api/admin/employees'),
    ]);

    clear(body).append(
      el(
        'div',
        { class: 'card' },
        el(
          'h3',
          {},
          el('span', {}, 'ผู้ใช้งานระบบ'),
          el('button', { class: 'btn sm', onclick: () => openUserForm(null, employees.items, load) }, '+ เพิ่มผู้ใช้'),
        ),
        table(
          ['ชื่อผู้ใช้', 'ชื่อ-นามสกุล', 'ตำแหน่ง', 'สถานะ', 'เข้าใช้ล่าสุด', ''],
          users.items.map((u) =>
            el(
              'tr',
              {},
              el('td', { class: 'small mono' }, u.username),
              el('td', {}, u.full_name),
              el('td', {}, badge('completed', ROLE_LABEL[u.role] ?? u.role)),
              el('td', {}, u.is_active ? badge('normal', 'เปิดใช้งาน') : badge('disabled', 'ปิดใช้งาน')),
              el('td', { class: 'small' }, u.last_login_at ?? '-'),
              el('td', {}, el('button', {
                class: 'btn ghost sm',
                onclick: () => openUserForm(u, employees.items, load),
              }, 'แก้ไข')),
            ),
          ),
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el(
          'h3',
          {},
          el('span', {}, 'พนักงาน / พื้นที่'),
          el('button', { class: 'btn sm', onclick: () => openEmployeeForm(null, users.items, load) }, '+ เพิ่มพนักงาน'),
        ),
        el('div', { class: 'hint' }, 'พนักงานเก็บเงินจะเห็นเฉพาะลูกหนี้ที่ผูกกับตนเอง'),
        table(
          ['รหัส', 'ชื่อ-นามสกุล', 'เบอร์โทร', 'พื้นที่', 'ผู้บังคับบัญชา', 'ผูกกับผู้ใช้', 'สถานะ', ''],
          employees.items.map((e) =>
            el(
              'tr',
              {},
              el('td', { class: 'small mono' }, e.code),
              el('td', {}, e.full_name),
              el('td', { class: 'small' }, e.phone ?? '-'),
              el('td', { class: 'small' }, e.area ?? '-'),
              el('td', { class: 'small' }, e.supervisor_name ?? '-'),
              el('td', { class: 'small' }, e.username ?? '-'),
              el('td', {}, e.is_active ? badge('normal', 'ทำงาน') : badge('disabled', 'พ้นสภาพ')),
              el('td', {}, el('button', {
                class: 'btn ghost sm',
                onclick: () => openEmployeeForm(e, users.items, load),
              }, 'แก้ไข')),
            ),
          ),
        ),
      ),
      permissionMatrixCard(),
    );
  }

  wrap.append(
    el('div', { class: 'page-head' }, el('div', {}, el('h2', {}, 'พนักงานและสิทธิ์การใช้งาน'))),
    body,
  );
  await load();
  return wrap;
}

/** ตารางสิทธิ์อ้างอิงตาม SRS ข้อ 12 */
function permissionMatrixCard() {
  const rows = [
    ['Dashboard', 'ทั้งหมด', 'ทั้งหมด', 'เฉพาะงานตน', 'ข้อมูลบัญชี'],
    ['ดูลูกหนี้', 'ทั้งหมด', 'ทั้งหมด', 'เฉพาะที่ดูแล', 'ดูได้'],
    ['สร้างสัญญา', 'ได้', 'ได้', 'ไม่ได้', 'ไม่ได้'],
    ['รียอด', 'ได้', 'ได้/รออนุมัติ', 'ไม่ได้', 'ไม่ได้'],
    ['รับชำระ', 'ได้', 'ได้', 'ได้', 'ไม่ได้'],
    ['ยกเลิกรายการรับเงิน', 'ได้', 'รออนุมัติ', 'ไม่ได้', 'ไม่ได้'],
    ['รายรับ-รายจ่าย', 'ทั้งหมด', 'จำกัด', 'ไม่ได้', 'ได้'],
    ['ดูผลกำไร', 'ได้', 'จำกัด', 'ไม่ได้', 'ได้'],
    ['จัดการพนักงาน', 'ได้', 'ไม่ได้', 'ไม่ได้', 'ไม่ได้'],
    ['ตั้งค่าระบบ', 'ได้', 'ไม่ได้', 'ไม่ได้', 'ไม่ได้'],
  ];
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'ตารางสิทธิ์มาตรฐาน'),
    el('div', { class: 'hint' }, 'กำหนดสิทธิ์ย่อยรายบุคคลเพิ่มเติมได้ในหน้าแก้ไขผู้ใช้'),
    table(
      ['ฟังก์ชัน', 'เจ้าของ', 'ผู้จัดการ', 'พนักงานเก็บเงิน', 'บัญชี'],
      rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: i ? 'small' : '' }, c)))),
    ),
  );
}

function openUserForm(user, employees, onDone) {
  modal(user ? `แก้ไขผู้ใช้ ${user.username}` : 'เพิ่มผู้ใช้', (close) => {
    const username = el('input', { value: user?.username ?? '', disabled: Boolean(user) });
    const fullName = el('input', { value: user?.full_name ?? '' });
    const password = el('input', { type: 'password', placeholder: user ? 'เว้นว่างหากไม่เปลี่ยน' : '' });
    const roleSel = el(
      'select',
      {},
      Object.entries(ROLE_LABEL).map(([v, l]) => el('option', { value: v, selected: user?.role === v }, l)),
    );
    const active = el('input', { type: 'checkbox', checked: user ? Boolean(user.is_active) : true });

    const save = el(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          const body = {
            full_name: fullName.value.trim(),
            role: roleSel.value,
            is_active: active.checked,
          };
          if (password.value) body.password = password.value;
          try {
            if (user) await api.put(`/api/admin/users/${user.id}`, body);
            else await api.post('/api/admin/users', { ...body, username: username.value.trim(), password: password.value });
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
      field('ชื่อผู้ใช้ *', username),
      field('ชื่อ-นามสกุล *', fullName),
      field(user ? 'รหัสผ่านใหม่' : 'รหัสผ่าน *', password, 'อย่างน้อย 6 ตัวอักษร'),
      field('ตำแหน่ง *', roleSel),
      el('label', { class: 'rowline', style: 'margin:.5rem 0' },
        el('span', {}, 'เปิดใช้งาน'), el('span', { style: 'flex:none;width:auto' }, active)),
      el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}

function openEmployeeForm(employee, users, onDone) {
  modal(employee ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน', (close) => {
    const code = el('input', { value: employee?.code ?? '', placeholder: 'เว้นว่างให้ระบบสร้างให้' });
    const fullName = el('input', { value: employee?.full_name ?? '' });
    const phone = el('input', { value: employee?.phone ?? '', inputmode: 'tel' });
    const area = el('input', { value: employee?.area ?? '' });
    const userSel = el(
      'select',
      {},
      el('option', { value: '' }, 'ไม่ผูกกับผู้ใช้'),
      users.map((u) => el('option', { value: u.id, selected: employee?.user_id === u.id }, `${u.username} (${ROLE_LABEL[u.role]})`)),
    );
    const active = el('input', { type: 'checkbox', checked: employee ? Boolean(employee.is_active) : true });

    const save = el(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          const body = {
            code: code.value.trim() || undefined,
            full_name: fullName.value.trim(),
            phone: phone.value.trim() || null,
            area: area.value.trim() || null,
            user_id: userSel.value ? Number(userSel.value) : null,
            is_active: active.checked,
          };
          try {
            if (employee) await api.put(`/api/admin/employees/${employee.id}`, body);
            else await api.post('/api/admin/employees', body);
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
      field('รหัสพนักงาน', code),
      field('ชื่อ-นามสกุล *', fullName),
      field('เบอร์โทร', phone),
      field('พื้นที่ / เส้นทาง', area),
      field('ผูกกับผู้ใช้ระบบ', userSel, 'จำเป็นสำหรับพนักงานเก็บเงิน เพื่อจำกัดให้เห็นเฉพาะลูกหนี้ของตน'),
      el('label', { class: 'rowline', style: 'margin:.5rem 0' },
        el('span', {}, 'สถานะทำงาน'), el('span', { style: 'flex:none;width:auto' }, active)),
      el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
    );
  });
}
