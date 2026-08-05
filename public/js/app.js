// ตัวควบคุมหน้าจอหลัก: เข้าสู่ระบบ, เมนู, และการสลับหน้า (SRS ข้อ 4)
import { api, state, el, clear, toast, toastError, can, skeleton } from './core.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderDebtors, renderDebtorDetail } from './pages/debtors.js';
import { renderContracts, renderContractDetail, renderNewContract } from './pages/contracts.js';
import { renderCollect } from './pages/collect.js';
import { renderReyod } from './pages/reyod.js';
import { renderCashbook } from './pages/cashbook.js';
import { renderReports } from './pages/reports.js';
import { renderEmployees } from './pages/employees.js';
import { renderSettings, renderPricingAdmin } from './pages/settings.js';
import { renderImport } from './pages/import.js';

const app = document.getElementById('app');

/** เมนูตาม SRS ข้อ 4 — ผูกกับสิทธิ์การใช้งานข้อ 12 */
const MENU = [
  { path: '/', label: 'ภาพรวม', cap: 'dashboard', render: renderDashboard, tab: true, skel: 'dashboard' },
  { path: '/debtors', label: 'ลูกหนี้', cap: 'debtors_view', render: renderDebtors, tab: true },
  { path: '/collect', label: 'รับชำระ', cap: 'payments_create', render: renderCollect, tab: true, skel: 'detail' },
  { path: '/contracts', label: 'สัญญา', cap: 'debtors_view', render: renderContracts, tab: true },
  { path: '/reyod', label: 'รียอด', cap: 'reyod', render: renderReyod },
  { path: '/cashbook', label: 'รายรับ-รายจ่าย', cap: 'cashbook', render: renderCashbook, skel: 'dashboard' },
  { path: '/reports', label: 'รายงาน', cap: 'reports_view', render: renderReports, skel: 'dashboard' },
  { path: '/employees', label: 'พนักงาน', cap: 'employees_manage', render: renderEmployees },
  { path: '/import', label: 'นำเข้าข้อมูล', cap: 'settings_manage', render: renderImport, skel: 'form' },
  { path: '/settings', label: 'ตั้งค่า', cap: 'settings_manage', render: renderSettings, skel: 'form' },
];

const ROUTES = [
  ...MENU,
  // หน้าแก้ราคาบนหน้าแนะนำระบบ — ไม่อยู่ในเมนูโดยตั้งใจ (อยู่นอกขอบเขต SRS)
  // เข้าได้ที่ #/pricing สำหรับผู้ขายระบบเท่านั้น
  { path: '/pricing', cap: 'settings_manage', render: renderPricingAdmin, skel: 'form' },
  { path: '/debtors/:id', cap: 'debtors_view', render: renderDebtorDetail, skel: 'detail' },
  { path: '/contracts/new', cap: 'contracts_create', render: renderNewContract, skel: 'form' },
  { path: '/contracts/:id', cap: 'debtors_view', render: renderContractDetail, skel: 'detail' },
  { path: '/collect/:contractId', cap: 'payments_create', render: renderCollect, skel: 'detail' },
  { path: '/reyod/:contractId', cap: 'reyod', render: renderReyod, skel: 'detail' },
];

function matchRoute(path) {
  const parts = path.split('/').filter(Boolean);
  let best = null;
  for (const route of ROUTES) {
    const rp = route.path.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) { ok = false; break; }
    }
    // เส้นทางแบบตายตัวชนะเส้นทางที่มีพารามิเตอร์ (เช่น /contracts/new)
    if (ok && (!best || !route.path.includes(':'))) best = { route, params };
    if (ok && !route.path.includes(':')) break;
  }
  return best;
}

// ---- หน้าเข้าสู่ระบบ --------------------------------------------------------

function renderLogin() {
  const username = el('input', { autocomplete: 'username', placeholder: 'ชื่อผู้ใช้' });
  const password = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'รหัสผ่าน' });
  const button = el('button', { class: 'btn block', type: 'submit' }, 'เข้าสู่ระบบ');

  // ช่องรหัสยืนยัน 2 ชั้น — ซ่อนไว้ก่อน จะโผล่เมื่อเซิร์ฟเวอร์แจ้งว่าบัญชีเปิด 2FA
  const totp = el('input', {
    inputmode: 'numeric', autocomplete: 'one-time-code',
    placeholder: 'รหัส 6 หลัก หรือรหัสสำรอง',
  });
  const totpField = el('div', { class: 'field', style: 'display:none' },
    el('label', {}, 'รหัสยืนยัน 2 ชั้น'), totp);
  let needTwoFactor = false;
  // สลับปุ่มเป็นสถานะกำลังโหลด — สปินเนอร์หมุน + เปลี่ยนข้อความ
  // ปิดปุ่มไว้ด้วย กันกดซ้ำระหว่างรอ
  const setLoading = (on) => {
    button.disabled = on;
    button.classList.toggle('loading', on);
    clear(button);
    if (on) {
      button.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'กำลังเข้าสู่ระบบ…');
    } else {
      button.textContent = 'เข้าสู่ระบบ';
    }
  };
  // ข้อความแจ้งเตือนแบบค้างไว้ ไม่ใช้ toast ที่หายไปเอง เพราะกรณีถูกล็อก
  // ผู้ใช้ต้องอ่านได้ว่าต้องรออีกกี่นาที
  const notice = el('div', { class: 'warn', style: 'display:none' });

  const form = el(
    'form',
    {
      class: 'login-card',
      onsubmit: async (e) => {
        e.preventDefault();
        setLoading(true);
        notice.style.display = 'none';
        try {
          const data = await api.post('/api/auth/login', {
            username: username.value,
            password: password.value,
            token: needTwoFactor ? totp.value.trim() : undefined,
          });
          state.user = data.user;
          state.permissions = data.permissions;
          location.hash = '#/';
          await boot();
        } catch (err) {
          if (err.status === 401 && err.data?.two_factor_required) {
            // รหัสผ่านถูกแล้ว แต่ต้องกรอกรหัส 2 ชั้น — โผล่ช่องรหัสให้กรอก
            if (!needTwoFactor) {
              needTwoFactor = true;
              totpField.style.display = '';
              totp.focus();
            } else {
              // เคยโผล่แล้วแต่รหัสยังผิด
              notice.textContent = 'รหัสยืนยัน 2 ชั้นไม่ถูกต้อง กรุณาลองใหม่';
              notice.style.display = '';
              totp.value = '';
              totp.focus();
            }
          } else if (err.status === 429) {
            notice.textContent = err.message;
            notice.style.display = '';
            password.value = '';
          } else {
            toastError(err);
          }
          setLoading(false);
        }
      },
    },
    // จัดชื่อระบบเป็นกลุ่มเดียวกับสัญลักษณ์ เพื่อให้จัดกึ่งกลางได้สวยและเว้นระยะสม่ำเสมอ
    el(
      'div',
      { class: 'login-brand' },
      el('div', { class: 'login-mark' }, '฿'),
      el('h1', {}, 'พันธมิตรเงินทุน'),
      el('p', { class: 'sub' }, 'ระบบบริหารลูกหนี้ สัญญา และรับชำระ'),
    ),
    notice,
    el('div', { class: 'field' }, el('label', {}, 'ชื่อผู้ใช้'), username),
    el('div', { class: 'field' }, el('label', {}, 'รหัสผ่าน'), password),
    totpField,
    button,
    // เตือนไว้ตรงนี้เพราะเคยมีคนกรอกรหัสพนักงาน (E0001) แทนชื่อผู้ใช้
    el('p', { class: 'login-foot' }, 'ใช้ชื่อผู้ใช้ที่เจ้าของกิจการตั้งให้ ไม่ใช่รหัสพนักงาน'),
  );

  clear(app);
  app.className = '';
  app.append(el('div', { class: 'login-wrap' }, form));
  username.focus();
}

// ---- โครงหน้าหลัก ----------------------------------------------------------

function shell() {
  const visible = MENU.filter((m) => can(m.cap));
  const current = location.hash.slice(1) || '/';

  const sidenav = el(
    'nav',
    { class: 'sidenav' },
    visible.map((m) =>
      el('a', { href: `#${m.path}`, class: current === m.path ? 'active' : '' }, m.label),
    ),
  );

  // มือถือ: แสดง 4 เมนูหลัก + ปุ่ม "เพิ่มเติม"
  const tabs = visible.filter((m) => m.tab).slice(0, 4);
  const rest = visible.filter((m) => !tabs.includes(m));
  const tabbar = el(
    'nav',
    { class: 'tabbar' },
    tabs.map((m) =>
      el('a', { href: `#${m.path}`, class: current === m.path ? 'active' : '' }, m.label),
    ),
    el(
      'a',
      {
        href: '#',
        onclick: (e) => {
          e.preventDefault();
          openMoreMenu(rest);
        },
      },
      'เพิ่มเติม',
    ),
  );

  const main = el('main', {});
  const bar = el(
    'header',
    { class: 'topbar' },
    el('h1', {}, 'พันธมิตรเงินทุน'),
    el('div', { class: 'spacer' }),
    el(
      'div',
      { class: 'who' },
      el('b', {}, state.user.full_name),
      el('span', {}, roleLabel(state.user.role)),
    ),
    el('button', { onclick: logout }, 'ออก'),
  );

  clear(app);
  app.className = '';
  app.append(el('div', { class: 'shell' }, bar, el('div', { class: 'layout' }, sidenav, main), tabbar));
  return main;
}

function openMoreMenu(items) {
  import('./core.js').then(({ modal }) => {
    modal('เมนูเพิ่มเติม', (close) =>
      el(
        'div',
        {},
        items.map((m) =>
          el(
            'a',
            {
              href: `#${m.path}`,
              class: 'btn ghost block',
              style: 'margin-bottom:.4rem;text-decoration:none',
              onclick: close,
            },
            m.label,
          ),
        ),
        el(
          'button',
          { class: 'btn ghost block mt', onclick: () => { close(); openChangePassword(); } },
          'เปลี่ยนรหัสผ่าน',
        ),
        el(
          'button',
          { class: 'btn ghost block', style: 'margin-top:.4rem', onclick: () => { close(); openTwoFactor(); } },
          state.user?.two_factor_enabled ? 'ยืนยันตัวตน 2 ชั้น (เปิดอยู่)' : 'ตั้งค่ายืนยันตัวตน 2 ชั้น',
        ),
      ),
    );
  });
}

function openChangePassword() {
  import('./core.js').then(({ modal, field, toast: t }) => {
    modal('เปลี่ยนรหัสผ่าน', (close) => {
      const cur = el('input', { type: 'password' });
      const next = el('input', { type: 'password' });
      const save = el(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            try {
              await api.post('/api/auth/change-password', {
                current_password: cur.value,
                new_password: next.value,
              });
              t('เปลี่ยนรหัสผ่านแล้ว', 'ok');
              close();
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
        field('รหัสผ่านเดิม', cur),
        field('รหัสผ่านใหม่', next, 'อย่างน้อย 8 ตัวอักษร'),
        el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
      );
    });
  });
}

// จัดการยืนยันตัวตนสองชั้น (2FA) ของบัญชีตัวเอง — เปิด/ปิด แบบทีละขั้น
function openTwoFactor() {
  import('./core.js').then(({ modal, field, toast: t }) => {
    modal('ยืนยันตัวตนสองชั้น (2FA)', (close) => {
      const box = el('div', {});

      const renderRecovery = (codes) => {
        clear(box);
        box.append(
          el('p', { class: 'twofa-ok' }, '✅ เปิดใช้ 2FA สำเร็จ'),
          el('p', {}, 'เก็บ "รหัสสำรอง" ต่อไปนี้ไว้ในที่ปลอดภัย ใช้เข้าระบบได้ตอนทำมือถือหาย (แต่ละรหัสใช้ได้ครั้งเดียว):'),
          el('div', { class: 'recovery-grid' }, codes.map((c) => el('code', {}, c))),
          el('p', { class: 'warn' }, '⚠️ รหัสสำรองจะแสดงเพียงครั้งเดียว โปรดบันทึกไว้ตอนนี้'),
          el('div', { class: 'btn-row mt' }, el('button', { class: 'btn', onclick: close }, 'บันทึกแล้ว ปิดหน้าต่าง')),
        );
      };

      const renderSetup = (info) => {
        clear(box);
        const code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'รหัส 6 หลักจากแอป' });
        box.append(
          el('p', {}, '1) เปิดแอป Authenticator (เช่น Google Authenticator) แล้วเพิ่มบัญชีด้วยการกรอกคีย์นี้:'),
          el('div', { class: 'totp-secret' }, info.secret),
          el('p', { class: 'muted small' }, 'ประเภท: ตามเวลา (Time-based) · 6 หลัก · เปลี่ยนทุก 30 วินาที'),
          el('p', {}, '2) กรอกรหัส 6 หลักที่แอปแสดง เพื่อยืนยันว่าเพิ่มถูกต้อง:'),
          field('รหัสยืนยัน', code),
          el('div', { class: 'btn-row mt' },
            el('button', { class: 'btn', onclick: async () => {
              try {
                const r = await api.post('/api/auth/2fa/enable', { token: code.value.trim() });
                state.user.two_factor_enabled = true;
                renderRecovery(r.recovery_codes);
              } catch (err) { toastError(err); }
            } }, 'ยืนยันเปิดใช้'),
            el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก'),
          ),
        );
        code.focus();
      };

      const render = () => {
        clear(box);
        if (state.user?.two_factor_enabled) {
          const pw = el('input', { type: 'password' });
          box.append(
            el('p', { class: 'twofa-ok' }, '🔒 เปิดใช้ยืนยันตัวตนสองชั้นอยู่'),
            el('p', { class: 'muted small' }, 'การเข้าสู่ระบบต้องใช้รหัสจากแอป Authenticator เพิ่มจากรหัสผ่าน'),
            field('ยืนยันรหัสผ่านเพื่อปิด 2FA', pw),
            el('div', { class: 'btn-row mt' },
              el('button', { class: 'btn danger', onclick: async () => {
                try {
                  await api.post('/api/auth/2fa/disable', { password: pw.value });
                  state.user.two_factor_enabled = false;
                  t('ปิด 2FA แล้ว', 'ok');
                  render();
                } catch (err) { toastError(err); }
              } }, 'ปิด 2FA'),
              el('button', { class: 'btn ghost', onclick: close }, 'ปิดหน้าต่าง'),
            ),
          );
          return;
        }
        box.append(
          el('p', {}, 'เพิ่มความปลอดภัยอีกชั้น เวลาเข้าสู่ระบบต้องกรอกรหัสจากแอป Authenticator ในมือถือคุณ'),
          el('div', { class: 'btn-row mt' },
            el('button', { class: 'btn', onclick: async () => {
              try { renderSetup(await api.post('/api/auth/2fa/setup')); }
              catch (err) { toastError(err); }
            } }, 'เริ่มตั้งค่า 2FA'),
            el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก'),
          ),
        );
      };

      render();
      return box;
    });
  });
}

function roleLabel(role) {
  return { owner: 'เจ้าของ', manager: 'ผู้จัดการ', collector: 'พนักงานเก็บเงิน', accountant: 'บัญชี' }[role] ?? role;
}

async function logout() {
  try {
    await api.post('/api/auth/logout');
  } catch { /* ไม่ต้องแจ้งเตือน */ }
  state.user = null;
  location.hash = '#/login';
  renderLogin();
}

// ---- Router -----------------------------------------------------------------

async function route() {
  if (!state.user) return renderLogin();
  const path = location.hash.slice(1) || '/';
  if (path === '/login') { location.hash = '#/'; return; }

  const match = matchRoute(path);
  const main = shell();

  if (!match) {
    main.append(el('div', { class: 'card' }, el('div', { class: 'empty' }, 'ไม่พบหน้าที่ต้องการ')));
    return;
  }
  if (!can(match.route.cap)) {
    main.append(el('div', { class: 'card' }, el('div', { class: 'empty' }, 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้')));
    return;
  }

  main.append(skeleton(match.route.skel ?? 'table'));
  try {
    const view = await match.route.render(match.params ?? {});
    clear(main).append(view);
  } catch (err) {
    clear(main).append(el('div', { class: 'card' }, el('div', { class: 'empty' }, err.message)));
    toastError(err);
  }
}

async function boot() {
  try {
    const session = await api.get('/api/auth/session');
    if (!session.user) return renderLogin();
    state.user = session.user;
    state.permissions = session.permissions;
    const s = await api.get('/api/admin/settings');
    state.settings = s.settings;
    await route();
  } catch (err) {
    console.error(err);
    renderLogin();
  }
}

window.addEventListener('hashchange', route);
boot();
