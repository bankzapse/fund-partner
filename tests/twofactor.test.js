// ทดสอบยืนยันตัวตนสองชั้น (2FA) ครบวงจร: ตั้งค่า เปิดใช้ เข้าสู่ระบบ รหัสสำรอง ปิด และแอดมินรีเซ็ต
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { get, run, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { totpAt } from '../src/lib/totp.js';
import { nowISO } from '../src/lib/time.js';

let server, base;
const sess = {};

async function api(role, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(sess[role] ? { Cookie: `fp_session=${sess[role]}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
  return { status: res.status, body: json, text, setCookie: res.headers.get('set-cookie') };
}

async function login(username, password, token) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, token }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  const s = cookie.match(/fp_session=([^;]*)/)?.[1] ?? null;
  const body = await res.json().catch(() => null);
  return { status: res.status, body, session: s };
}

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const now = nowISO();
  for (const [u, role] of [['owner', 'owner'], ['staff', 'collector']]) {
    await run(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (:u, :h, :u, :r, 1, :now, :now)`,
      { u, h: hashPassword('Passw0rd#1'), r: role, now },
    );
  }
  const o = await login('owner', 'Passw0rd#1');
  sess.owner = o.session;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

// ตั้งค่า+เปิดใช้ 2FA ให้ผู้ใช้ที่ล็อกอินอยู่ คืน secret ที่ได้
async function enrollTwoFactor(role) {
  const setup = await api(role, 'POST', '/api/auth/2fa/setup');
  assert.equal(setup.status, 200);
  const secret = setup.body.secret;
  const enable = await api(role, 'POST', '/api/auth/2fa/enable', { token: totpAt(secret) });
  assert.equal(enable.status, 200, 'เปิดใช้ด้วยรหัสที่ถูกต้องต้องสำเร็จ');
  return { secret, recovery: enable.body.recovery_codes };
}

describe('2FA: ตั้งค่าและเปิดใช้', () => {
  test('setup คืน secret + otpauth uri', async () => {
    const r = await api('owner', 'POST', '/api/auth/2fa/setup');
    assert.equal(r.status, 200);
    assert.match(r.body.secret, /^[A-Z2-7]+$/, 'secret เป็น Base32');
    assert.match(r.body.otpauth_uri, /^otpauth:\/\/totp\//);
    assert.match(r.body.otpauth_uri, /secret=/);
  });

  test('เปิดใช้ด้วยรหัสผิดไม่ได้ และได้รหัสสำรอง 10 ชุดเมื่อรหัสถูก', async () => {
    await api('owner', 'POST', '/api/auth/2fa/setup');
    const bad = await api('owner', 'POST', '/api/auth/2fa/enable', { token: '000000' });
    assert.equal(bad.status, 400, 'รหัสผิดต้องเปิดใช้ไม่ได้');

    const { recovery } = await enrollTwoFactor('owner');
    assert.equal(recovery.length, 10, 'ต้องได้รหัสสำรอง 10 ชุด');
  });
});

describe('2FA: บังคับตอนเข้าสู่ระบบ', () => {
  test('เปิด 2FA แล้ว: รหัสผ่านถูกแต่ไม่ใส่รหัส -> ขอรหัส 2 ชั้น (ไม่ใช่ล็อกอินสำเร็จ)', async () => {
    // staff เปิด 2FA
    const s = await login('staff', 'Passw0rd#1');
    sess.staff = s.session;
    const { secret } = await enrollTwoFactor('staff');

    const noToken = await login('staff', 'Passw0rd#1');
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.two_factor_required, true, 'ต้องบอกว่าต้องใช้ 2FA');
    assert.equal(noToken.session, null, 'ต้องยังไม่ออก session');

    const withToken = await login('staff', 'Passw0rd#1', totpAt(secret));
    assert.equal(withToken.status, 200, 'ใส่รหัสถูกต้องเข้าได้');
    assert.ok(withToken.session, 'ต้องได้ session');
    assert.equal(withToken.body.user.two_factor_enabled, true);
  });

  test('รหัส 2FA ผิดเข้าไม่ได้', async () => {
    const r = await login('staff', 'Passw0rd#1', '123456');
    assert.equal(r.status, 401);
    assert.equal(r.body.two_factor_required, true);
    assert.equal(r.session, null);
  });

  test('รหัสผ่านผิด (แม้ใส่ 2FA ถูก) ก็เข้าไม่ได้', async () => {
    // ต้องใช้ secret ของ staff — ดึงจากฐานเพื่อสร้างรหัสที่ถูก
    const row = await get(`SELECT totp_secret FROM users WHERE username = 'staff'`);
    const r = await login('staff', 'ผิดแน่นอน', totpAt(row.totp_secret));
    assert.equal(r.status, 401);
    assert.notEqual(r.body.two_factor_required, true, 'รหัสผ่านผิดต้องไม่หลุดว่าถึงชั้น 2FA');
  });
});

describe('2FA: รหัสสำรอง', () => {
  test('ใช้รหัสสำรองเข้าได้ และใช้ซ้ำไม่ได้ (ใช้แล้วทิ้ง)', async () => {
    // ผู้ใช้ใหม่สำหรับเทสต์นี้โดยเฉพาะ
    await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
               VALUES ('rec', :h, 'rec', 'collector', 1, :now, :now)`,
      { h: hashPassword('Passw0rd#1'), now: nowISO() });
    const r = await login('rec', 'Passw0rd#1');
    sess.rec = r.session;
    const { recovery } = await enrollTwoFactor('rec');
    const code = recovery[0];

    const first = await login('rec', 'Passw0rd#1', code);
    assert.equal(first.status, 200, 'รหัสสำรองที่ถูกต้องต้องเข้าได้');

    const second = await login('rec', 'Passw0rd#1', code);
    assert.equal(second.status, 401, 'รหัสสำรองเดิมใช้ซ้ำไม่ได้');
  });
});

describe('2FA: ปิดและแอดมินรีเซ็ต', () => {
  test('ปิด 2FA ต้องใส่รหัสผ่านถูก', async () => {
    await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
               VALUES ('offr', :h, 'offr', 'collector', 1, :now, :now)`,
      { h: hashPassword('Passw0rd#1'), now: nowISO() });
    const r = await login('offr', 'Passw0rd#1');
    sess.offr = r.session;
    const { secret } = await enrollTwoFactor('offr');

    const badPw = await api('offr', 'POST', '/api/auth/2fa/disable', { password: 'ผิด' });
    assert.equal(badPw.status, 400, 'รหัสผ่านผิดปิดไม่ได้');

    const ok = await api('offr', 'POST', '/api/auth/2fa/disable', { password: 'Passw0rd#1' });
    assert.equal(ok.status, 200);
    // ปิดแล้วเข้าได้ด้วยรหัสผ่านอย่างเดียว
    const after = await login('offr', 'Passw0rd#1');
    assert.equal(after.status, 200);
    void secret;
  });

  test('เจ้าของรีเซ็ต 2FA ให้พนักงานที่ทำมือถือหายได้ แต่พนักงานทั่วไปทำไม่ได้', async () => {
    await run(`INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
               VALUES ('lost', :h, 'lost', 'collector', 1, :now, :now)`,
      { h: hashPassword('Passw0rd#1'), now: nowISO() });
    const r = await login('lost', 'Passw0rd#1');
    sess.lost = r.session;
    await enrollTwoFactor('lost');
    const target = await get(`SELECT id FROM users WHERE username = 'lost'`);

    // พนักงานอื่นรีเซ็ตให้ไม่ได้
    const denied = await api('staff', 'POST', `/api/admin/users/${target.id}/reset-2fa`);
    assert.equal(denied.status, 403);

    // เจ้าของรีเซ็ตได้
    const okReset = await api('owner', 'POST', `/api/admin/users/${target.id}/reset-2fa`);
    assert.equal(okReset.status, 200);
    const afterReset = await login('lost', 'Passw0rd#1');
    assert.equal(afterReset.status, 200, 'รีเซ็ตแล้วเข้าด้วยรหัสผ่านอย่างเดียวได้');
  });
});

describe('2FA: ไม่รั่วความลับ', () => {
  test('API ไม่ส่ง totp_secret/recovery ออกไป', async () => {
    const me = await api('owner', 'GET', '/api/me');
    assert.ok(!me.text.includes('totp_secret'), 'ต้องไม่มี totp_secret');
    assert.ok(!me.text.includes('totp_recovery'), 'ต้องไม่มี totp_recovery');

    const users = await api('owner', 'GET', '/api/admin/users');
    assert.ok(!users.text.includes('totp_secret'), 'รายชื่อผู้ใช้ต้องไม่มี secret');
    // แต่ต้องบอกสถานะว่าเปิด 2FA ไหม
    assert.ok(users.text.includes('two_factor_enabled'), 'ต้องบอกสถานะ 2FA');

    const backup = await api('owner', 'GET', '/api/admin/backup');
    assert.ok(!backup.text.includes('totp_secret'), 'ไฟล์สำรองต้องไม่มี secret');
    assert.ok(!backup.text.includes('totp_recovery'), 'ไฟล์สำรองต้องไม่มีรหัสสำรอง');
  });
});
