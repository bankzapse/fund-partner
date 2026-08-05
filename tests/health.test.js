// ตรวจ endpoint สุขภาพระบบ /healthz — ต้องเปิดได้โดยไม่ล็อกอิน และสะท้อนสถานะ DB จริง
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { closeDb } from '../src/db/index.js';

let server, base;

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

describe('สุขภาพระบบ (/healthz)', () => {
  test('ตอบ 200 และบอกว่า DB ปกติ โดยไม่ต้องล็อกอิน', async () => {
    const res = await fetch(base + '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'ต้องไม่ให้ cache');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.db, 'ok');
    assert.ok(body.time, 'ต้องมีเวลา');
  });

  test('ไม่เปิดเผยรายละเอียดภายใน (เวอร์ชัน/สแตก/พาธ)', async () => {
    const text = await (await fetch(base + '/healthz')).text();
    assert.ok(!/\/Users\/|SELECT|node_modules|stack/i.test(text), 'ต้องไม่มีข้อมูลภายในหลุด');
  });

  test('DB ล่ม -> ตอบ 503 degraded (ให้ monitor จับได้)', async () => {
    // จำลอง DB ใช้ไม่ได้: ปิดการเชื่อมต่อ แล้วชี้ path ไปที่ที่สร้างไม่ได้
    // (โฟลเดอร์ย่อยใต้ไฟล์ package.json — mkdir จะล้มเหลวด้วย ENOTDIR)
    // db() จะเชื่อมต่อใหม่ไม่สำเร็จ ทำให้ healthz เข้า catch แล้วตอบ 503
    await closeDb();
    const good = process.env.FP_DB_PATH;
    process.env.FP_DB_PATH = new URL('../package.json/nope', import.meta.url).pathname;
    try {
      const res = await fetch(base + '/healthz');
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.status, 'degraded');
      assert.equal(body.db, 'error');
    } finally {
      process.env.FP_DB_PATH = good;
      await closeDb(); // ล้างสถานะที่ค้าง ให้เชื่อมต่อใหม่ได้ปกติ
    }
  });
});
