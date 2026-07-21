// ทดสอบการจำกัดจำนวนครั้งที่เข้าสู่ระบบผิด — ยิงเข้า API จริง ไม่ได้เรียกฟังก์ชันตรง ๆ
// เพราะสิ่งที่ต้องพิสูจน์คือ "ผู้โจมตีจากภายนอกทำอะไรไม่ได้" ไม่ใช่ "ฟังก์ชันคืนค่าถูก"
process.env.FP_DB_PATH = ':memory:';

import { before, after, beforeEach, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, all, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO } from '../src/lib/time.js';
import { POLICY } from '../src/lib/login-guard.js';

let server, base;
const PASS = 'Owner#Pass1';

/** ยิง login ตรง ๆ พร้อมกำหนด IP ปลอมได้ เพื่อแยกโควตาชั้น IP ของแต่ละเทสต์ */
async function login(username, password, ip = '203.0.113.1') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const now = nowISO();
  for (const u of ['owner', 'somchai', 'malee', 'wichai', 'nid', 'kanya']) {
    await run(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (:u, :h, :n, 'owner', 1, :now, :now)`,
      { u, h: hashPassword(PASS), n: u, now },
    );
  }
});

after(async () => {
  server?.close();
  await closeDb();
});

// ทุกเทสต์เริ่มจากกระดานเปล่า ไม่งั้นเทสต์ก่อนหน้าจะทำให้เทสต์ถัดไปถูกล็อกไปด้วย
beforeEach(async () => { await run(`DELETE FROM login_attempts`); });

describe('จำกัดจำนวนครั้งที่เข้าสู่ระบบผิด', () => {
  test('ผิดครบตามโควตาแล้วถูกล็อก (จากเดิมที่ยิงได้ไม่จำกัด)', async () => {
    const statuses = [];
    for (let i = 0; i < POLICY.user_ip.limit + 2; i++) {
      statuses.push((await login('somchai', 'ผิดแน่นอน')).status);
    }
    const first = statuses.slice(0, POLICY.user_ip.limit);
    const after = statuses.slice(POLICY.user_ip.limit);
    assert.deepEqual(first, Array(POLICY.user_ip.limit).fill(401), 'ครั้งแรก ๆ ต้องเป็น 401 ตามปกติ');
    assert.deepEqual(after, Array(after.length).fill(429), 'เกินโควตาแล้วต้องโดน 429 ทุกครั้ง');
  });

  test('ระหว่างถูกล็อก ต่อให้ใส่รหัสผ่านถูกก็เข้าไม่ได้', async () => {
    for (let i = 0; i < POLICY.user_ip.limit; i++) await login('malee', 'ผิด');
    const res = await login('malee', PASS);
    assert.equal(res.status, 429, 'ถ้ารหัสถูกแล้วเข้าได้ ผู้โจมตีจะยิงต่อได้เรื่อย ๆ ระหว่างถูกล็อก');
    assert.match(res.body.error, /ล็อกไว้ชั่วคราว/);
    assert.ok(Number(res.retryAfter) > 0, 'ต้องบอกด้วยว่าให้รออีกกี่วินาที');
  });

  test('พอครบเวลาล็อกแล้วเข้าได้เอง ไม่ต้องรอใครมาปลด', async () => {
    for (let i = 0; i < POLICY.user_ip.limit; i++) await login('wichai', 'ผิด');
    assert.equal((await login('wichai', PASS)).status, 429);

    // เร่งเวลาโดยเลื่อน locked_until ให้เป็นอดีต แทนการรอจริง 5 นาที
    await run(
      `UPDATE login_attempts SET locked_until = :past WHERE key LIKE 'wichai%'`,
      { past: new Date(Date.now() - 1000).toISOString() },
    );
    assert.equal((await login('wichai', PASS)).status, 200, 'ครบเวลาแล้วต้องเข้าได้เอง');
  });

  test('เข้าสำเร็จแล้วตัวนับถูกล้าง — คนพิมพ์ผิดบ่อย ๆ ไม่โดนล็อกสะสม', async () => {
    for (let i = 0; i < POLICY.user_ip.limit - 1; i++) await login('nid', 'ผิด');
    assert.equal((await login('nid', PASS)).status, 200);

    // นับใหม่ตั้งแต่ศูนย์ ผิดได้อีกเต็มโควตาโดยไม่ถูกล็อก
    for (let i = 0; i < POLICY.user_ip.limit - 1; i++) {
      assert.equal((await login('nid', 'ผิด')).status, 401);
    }
  });

  test('ชื่อผู้ใช้ที่ไม่มีอยู่จริงก็ถูกล็อกเหมือนกัน — เดาไม่ได้ว่าชื่อไหนมีในระบบ', async () => {
    let real, fake;
    for (let i = 0; i <= POLICY.user_ip.limit; i++) {
      real = await login('kanya', 'ผิด', '203.0.113.10');
      fake = await login('ไม่มีคนนี้', 'ผิด', '203.0.113.11');
    }
    assert.equal(real.status, fake.status, 'สถานะต้องเหมือนกัน ไม่งั้นบอกใบ้ว่าชื่อไหนมีจริง');
    assert.equal(real.body.error, fake.body.error, 'ข้อความต้องเหมือนกันเป๊ะ');
  });

  test('ล็อกซ้ำแล้วนานขึ้นเรื่อย ๆ ยิงต่อไม่คุ้ม', async () => {
    const lockFor = async (username) => {
      for (let i = 0; i < POLICY.user_ip.limit; i++) await login(username, 'ผิด');
      const row = await get(
        `SELECT locked_until FROM login_attempts WHERE scope = 'user_ip' AND key LIKE :k`,
        { k: `${username}|%` },
      );
      return new Date(row.locked_until).getTime() - Date.now();
    };
    const first = await lockFor('somchai');
    // ปลดล็อกรอบแรก (แต่ยังจำจำนวนครั้งที่เคยโดนไว้) แล้วโดนอีกรอบ
    await run(
      `UPDATE login_attempts SET locked_until = :past WHERE key LIKE 'somchai%'`,
      { past: new Date(Date.now() - 1000).toISOString() },
    );
    const second = await lockFor('somchai');
    assert.ok(second > first, `รอบสอง (${Math.round(second / 60000)} นาที) ต้องนานกว่ารอบแรก (${Math.round(first / 60000)} นาที)`);
  });

  test('ชั้น IP หลวมกว่าชั้นชื่อผู้ใช้ — ทีมที่ใช้เน็ตร่วมกันไม่โดนล็อกยกออฟฟิศ', async () => {
    assert.ok(
      POLICY.ip.limit > POLICY.user_ip.limit * 3,
      'ถ้าโควตา IP ใกล้เคียงโควตาชื่อผู้ใช้ พนักงานไม่กี่คนพิมพ์ผิดจะล็อกทั้งสำนักงาน',
    );
    // พนักงาน 4 คนพิมพ์ผิดคนละ 3 ครั้งจาก IP เดียวกัน (สถานการณ์ปกติของออฟฟิศ)
    const ip = '198.51.100.7';
    for (const u of ['owner', 'malee', 'wichai', 'nid']) {
      for (let i = 0; i < 3; i++) await login(u, 'ผิด', ip);
    }
    assert.equal((await login('kanya', PASS, ip)).status, 200, 'คนที่พิมพ์ถูกต้องยังเข้าได้');
  });

  test('ยิงถล่มจาก IP เดียวด้วยชื่อผู้ใช้สลับไปมา ก็ยังโดนล็อกที่ชั้น IP', async () => {
    const ip = '198.51.100.99';
    for (let i = 0; i <= POLICY.ip.limit; i++) {
      await login(`สุ่ม${i}`, 'ผิด', ip);   // เปลี่ยนชื่อทุกครั้ง ชั้นชื่อผู้ใช้จึงกันไม่ได้
    }
    const res = await login('kanya', PASS, ip);
    assert.equal(res.status, 429, 'ชั้น IP ต้องรับมือกรณีที่ชั้นชื่อผู้ใช้กันไม่ได้');
  });

  test('คนอื่นยิงรหัสผิดใส่ชื่อเรา ต้องไม่ทำให้เราเข้าระบบไม่ได้', async () => {
    // ถ้านับตามชื่อผู้ใช้อย่างเดียว ใครก็ตามที่รู้ว่าเจ้าของใช้ชื่อ 'owner'
    // จะยิงรหัสผิดรัว ๆ เพื่อล็อกเจ้าของออกจากระบบตัวเองได้ — ต้องกันจุดนี้
    for (let i = 0; i < POLICY.user_ip.limit * 2; i++) {
      await login('owner', 'ผิด', '203.0.113.200');       // ผู้ไม่หวังดี
    }
    assert.equal((await login('owner', 'ผิด', '203.0.113.200')).status, 429, 'ผู้ไม่หวังดีต้องโดนล็อก');
    assert.equal(
      (await login('owner', PASS, '203.0.113.201')).status, 200,
      'เจ้าของที่นั่งอยู่คนละที่ต้องยังเข้าระบบได้ ไม่งั้นกลายเป็นช่องกลั่นแกล้ง',
    );
  });

  test('บันทึกลง Audit Log ทุกครั้งที่ล็อก เจ้าของกิจการตรวจย้อนหลังได้', async () => {
    for (let i = 0; i < POLICY.user_ip.limit; i++) await login('malee', 'ผิด', '203.0.113.55');
    const rows = await all(`SELECT * FROM audit_logs WHERE action = 'login_locked' ORDER BY id DESC`);
    assert.ok(rows.length > 0, 'ต้องมีร่องรอยว่าเกิดการล็อกขึ้น');
    assert.match(rows[0].reason, /malee/);
    // ต้องบอกให้ถูกว่าล็อกที่ชั้นไหน ไม่งั้นเจ้าของกิจการอ่าน log แล้วเข้าใจผิด
    assert.match(rows[0].reason, /ชื่อผู้ใช้\+IP/, 'ชั้นหลักคือคู่ชื่อผู้ใช้กับ IP ไม่ใช่ IP อย่างเดียว');
    assert.doesNotMatch(rows[0].reason, /ล็อก IP malee/, 'ต้องไม่เรียกคู่ชื่อผู้ใช้+IP ว่าเป็น IP');
    assert.equal(rows[0].ip, '203.0.113.55', 'ต้องเก็บ IP ต้นทางไว้ด้วย');
  });
});
