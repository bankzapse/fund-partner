// หน้าแนะนำระบบ (SEO) กับราคาที่ผู้ดูแลตั้งเอง
//
// หน้านี้เป็นหน้าสาธารณะที่คนนอกเห็น และรับข้อความที่ผู้ดูแลพิมพ์เองมาแสดง
// จึงต้องพิสูจน์ 2 เรื่อง: ราคาขึ้นไปอยู่ใน HTML จริง (ไม่ใช่รอ JavaScript)
// และข้อความที่พิมพ์มาทำหน้าเว็บพังหรือแทรกสคริปต์ไม่ได้
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, closeDb, setSetting } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO } from '../src/lib/time.js';
import { renderPricing, escapeHtml } from '../src/lib/landing.js';

let server, base, ownerCookie;

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, html: await res.text(), headers: res.headers };
};

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const now = nowISO();
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)`,
    { h: hashPassword('Owner#Pass1'), now },
  );
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'Owner#Pass1' }),
  });
  ownerCookie = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
});

after(async () => {
  server?.close();
  await closeDb();
});

describe('ราคาบนหน้าแนะนำระบบ', () => {
  test('ราคาอยู่ใน HTML ที่ส่งกลับ ไม่ต้องรอ JavaScript', async () => {
    // ถ้าราคาถูกเติมด้วย JavaScript ทีหลัง Google อาจเก็บหน้าที่ยังไม่มีราคา
    const { status, html } = await get('/');
    assert.equal(status, 200);
    assert.match(html, /฿790/, 'ต้องเห็นราคาในเนื้อ HTML ตั้งแต่แรก');
    assert.match(html, /id="pricing"/);
    assert.match(html, /มาตรฐาน/);
  });

  test('แก้ราคาจากหน้าตั้งค่าแล้วหน้าเว็บเปลี่ยนตาม', async () => {
    const res = await fetch(base + '/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `fp_session=${ownerCookie}` },
      body: JSON.stringify({
        settings: {
          pricing_heading: 'ค่าบริการรายเดือน',
          pricing_plans: JSON.stringify([
            { name: 'เหมาจ่าย', price: '฿1,500', per: '/ เดือน', features: ['ใช้ได้ทุกอย่าง'], cta: 'สนใจแพ็กเกจนี้', best: true },
          ]),
        },
      }),
    });
    assert.equal(res.status, 200);

    const { html } = await get('/');
    assert.match(html, /฿1,500/, 'ราคาใหม่ต้องขึ้น');
    assert.match(html, /ค่าบริการรายเดือน/, 'หัวข้อใหม่ต้องขึ้น');
    assert.match(html, /สนใจแพ็กเกจนี้/, 'ข้อความบนปุ่มต้องเปลี่ยนตาม');
    assert.doesNotMatch(html, /฿790/, 'ราคาเดิมต้องหายไป ไม่ค้างอยู่');
  });

  test('ไม่มีแพ็กเกจเลย = ซ่อนทั้งส่วนราคาและลิงก์ในเมนู', async () => {
    // ถ้าซ่อนแต่ส่วนราคาแล้วลิงก์ยังอยู่ กดแล้วจะไม่ไปไหน ดูเหมือนเว็บเสีย
    await setSetting('pricing_plans', '[]');
    const { html } = await get('/');
    assert.doesNotMatch(html, /id="pricing"/, 'ต้องไม่มีส่วนราคา');
    assert.doesNotMatch(html, /href="#pricing"/, 'ต้องไม่เหลือลิงก์ที่กดแล้วไม่ไปไหน');
    assert.match(html, /<title>/, 'หน้าอื่น ๆ ต้องยังอยู่ครบ');
  });

  test('ข้อมูลราคาเสียหาย ต้องไม่ทำให้หน้าเว็บล่ม', async () => {
    // ถ้าหน้าสาธารณะพังเพราะข้อมูลในฐานข้อมูลเพี้ยน จะเสียลูกค้าโดยไม่รู้ตัว
    await setSetting('pricing_plans', 'ไม่ใช่ JSON');
    const { status, html } = await get('/');
    assert.equal(status, 200, 'ต้องยังเปิดได้');
    assert.match(html, /<title>/);
  });

  test('ข้อความที่ผู้ดูแลพิมพ์ ต้องแทรกสคริปต์ลงหน้าเว็บไม่ได้', async () => {
    await setSetting('pricing_plans', JSON.stringify([
      { name: '<script>alert(1)</script>', price: '"><img src=x onerror=alert(1)>', per: '/ เดือน', features: ['<b>หนา</b>'], cta: 'ตกลง' },
    ]));
    const { html } = await get('/');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'ต้องไม่มีสคริปต์ที่แทรกเข้ามา');
    // ต้องเช็คว่าไม่มี "แท็ก" ที่ทำงานได้ ไม่ใช่เช็คแค่คำว่า onerror
    // เพราะข้อความที่ถูก escape แล้วยังมีตัวอักษรเหล่านั้นอยู่ แต่เป็นข้อความเฉย ๆ ที่ไม่ทำงาน
    assert.doesNotMatch(html, /<img[^>]*onerror/i, 'ต้องไม่มีแท็กที่มี event handler ทำงานได้');
    assert.match(html, /&lt;script&gt;/, 'ต้องแสดงเป็นข้อความธรรมดาแทน');
    assert.match(html, /&quot;&gt;&lt;img/, 'อักขระอันตรายต้องถูกแปลงเป็นข้อความ');
  });

  test('หน้าเว็บถูกเก็บใน CDN ช่วงสั้น ๆ ไม่ใช่ไม่เก็บเลย', async () => {
    // ถ้าไม่ตั้ง cache ทุกคนที่เข้าเว็บจะปลุกเซิร์ฟเวอร์ทุกครั้ง ทำให้หน้าแรกช้า
    const { headers } = await get('/');
    assert.match(headers.get('cache-control') ?? '', /s-maxage=\d+/);
  });
});

describe('การสร้าง HTML ส่วนราคา', () => {
  test('เน้นแพ็กเกจไหน แพ็กเกจนั้นได้ทั้งกรอบเด่นและปุ่มทอง', () => {
    const html = renderPricing({
      heading: 'ราคา', subheading: '', note: '',
      plans: [
        { name: 'ก', price: '฿1', per: '/ด', features: [], best: false },
        { name: 'ข', price: '฿2', per: '/ด', features: [], best: true },
      ],
    });
    assert.match(html, /class="price best"/);
    assert.match(html, /btn gold block/);
    assert.equal((html.match(/class="price best"/g) ?? []).length, 1, 'เน้นได้ทีละอันเท่านั้น');
  });

  test('จำนวนแพ็กเกจกำหนดจำนวนคอลัมน์ การ์ดจะได้ไม่ยืดจนโหวง', () => {
    const make = (n) => renderPricing({
      heading: 'ราคา', subheading: '', note: '',
      plans: Array.from({ length: n }, (_, i) => ({ name: `แพ็ก${i}`, price: '฿1', per: '/ด', features: [] })),
    });
    assert.match(make(2), /grid c2/);
    assert.match(make(3), /grid c3/);
    assert.match(make(4), /grid c4/);
    assert.match(make(6), /grid c4/);
  });

  test('escapeHtml ปิดอักขระที่ใช้แทรกโค้ดได้ครบ', () => {
    assert.equal(escapeHtml(`<a href="x" data='y'>&</a>`),
      '&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
