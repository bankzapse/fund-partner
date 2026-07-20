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
import { renderSettings } from './pages/settings.js';
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

  const form = el(
    'form',
    {
      class: 'login-card',
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        try {
          const data = await api.post('/api/auth/login', {
            username: username.value,
            password: password.value,
          });
          state.user = data.user;
          state.permissions = data.permissions;
          location.hash = '#/';
          await boot();
        } catch (err) {
          toastError(err);
          button.disabled = false;
        }
      },
    },
    el('h1', {}, 'พันธมิตรเงินทุน'),
    el('p', { class: 'sub' }, 'ระบบบริหารลูกหนี้ สัญญา และรับชำระ'),
    el('div', { class: 'field' }, el('label', {}, 'ชื่อผู้ใช้'), username),
    el('div', { class: 'field' }, el('label', {}, 'รหัสผ่าน'), password),
    button,
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
        field('รหัสผ่านใหม่', next, 'อย่างน้อย 6 ตัวอักษร'),
        el('div', { class: 'btn-row mt' }, save, el('button', { class: 'btn ghost', onclick: close }, 'ยกเลิก')),
      );
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
