// การวินิจฉัยเมื่อต่อฐานข้อมูลไม่ได้ ตอนเตรียมระบบขึ้นใช้งานจริง
//
// เจ้าของกิจการรันสคริปต์นี้เองโดยไม่มีใครช่วยข้าง ๆ ถ้าบอกสาเหตุผิด
// จะเสียเวลาไล่ผิดทาง เช่นไปตรวจเน็ตทั้งที่ปัญหาอยู่ที่ชื่อผู้ใช้
process.env.FP_DB_PATH = ':memory:';

import { describe, it as test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { diagnose } from '../scripts/go-live.mjs';

/** ดักข้อความที่สคริปต์พิมพ์ออกจอ แล้วถอดสีออกเพื่อตรวจเนื้อความ */
function capture(url, message) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    diagnose(url, new Error(message));
  } finally {
    process.stdout.write = orig;
  }
  return lines.join('').replace(/\x1b\[[0-9;]*m/g, '');
}

const HOST = 'aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';

describe('วินิจฉัยสาเหตุที่ต่อฐานข้อมูลไม่ได้', () => {
  test('ยังไม่ได้แทนที่ [YOUR-PASSWORD] — ต้องชี้ตรงจุด', () => {
    const out = capture(
      `postgresql://postgres.abcd:${encodeURIComponent('[YOUR-PASSWORD]')}@${HOST}`,
      'SASL authentication failed',
    );
    assert.match(out, /ยังไม่ได้แทนที่ \[YOUR-PASSWORD\]/);
    // ต้องไม่พ่นคำแนะนำอื่นมารกจนกลบสาเหตุที่แน่นอนแล้ว
    assert.doesNotMatch(out, /Reset database password/, 'รู้สาเหตุแน่นอนแล้วไม่ต้องเสนอตั้งรหัสใหม่');
  });

  test('รหัสผ่านมีอักขระพิเศษ — ต้องบอกว่าตัวไหนและแปลงเป็นอะไร', () => {
    const out = capture(
      `postgresql://postgres.abcd:${encodeURIComponent('MyPass@123#x')}@${HOST}`,
      'SASL authentication failed',
    );
    assert.match(out, /มีอักขระพิเศษ/);
    assert.match(out, /@/);
    assert.match(out, /%40/, 'ต้องบอกวิธีแปลงด้วย ไม่ใช่บอกแค่ว่ามีปัญหา');
  });

  test('รหัสผ่านธรรมดาแต่ผิดจริง — ต้องบอกทางออก ไม่ใช่ปล่อยค้าง', () => {
    const out = capture(`postgresql://postgres.abcd:PlainPass123@${HOST}`, 'SASL authentication failed');
    assert.match(out, /ไม่มีอักขระที่ต้องแปลง/);
    assert.match(out, /Reset database password/, 'ต้องบอกวิธีตั้งรหัสใหม่');
    assert.match(out, /vercel env/, 'ต้องเตือนให้อัปเดตใน Vercel ด้วย ไม่งั้นเว็บที่รันอยู่จะล่ม');
  });

  test('ไม่บอกความยาวรหัสผ่านเกินจำเป็น และไม่พิมพ์รหัสออกจอ', () => {
    const secret = 'SuperSecret999';
    const out = capture(`postgresql://postgres.abcd:${secret}@${HOST}`, 'SASL authentication failed');
    assert.doesNotMatch(out, new RegExp(secret), 'ห้ามพิมพ์รหัสผ่านออกจอเด็ดขาด');
    assert.match(out, new RegExp(String(secret.length)), 'บอกได้แค่ความยาว เพื่อให้เทียบเองว่าคัดลอกครบไหม');
  });

  test('Supabase ส่ง ENOTFOUND มาแต่หมายถึงไม่พบผู้ใช้ ต้องไม่ไล่ไปตรวจเน็ต', () => {
    // ข้อความจริงจาก Supabase pooler มีคำว่า ENOTFOUND ปนมาด้วย
    // ถ้าจับแค่คำนั้นจะแนะนำผิดทางทันที
    const out = capture(`postgresql://postgres.abcd:pw@${HOST}`, '(ENOTFOUND) tenant/user postgres.abcd not found');
    assert.match(out, /ไม่พบผู้ใช้/);
    assert.doesNotMatch(out, /เน็ตใช้งานได้/, 'ต้องไม่ไล่ให้ไปตรวจอินเทอร์เน็ต');
  });

  test('DNS พังจริง ต้องยังบอกว่าหาโฮสต์ไม่เจอ', () => {
    const out = capture(`postgresql://postgres.abcd:pw@ไม่มีโฮสต์นี้.com:6543/postgres`, 'getaddrinfo ENOTFOUND');
    assert.match(out, /หาโฮสต์.*ไม่เจอ/);
  });

  test('ต่อไม่ติดเพราะใช้ Dedicated pooler ที่เป็น IPv6 อย่างเดียว', () => {
    const out = capture(`postgresql://postgres:pw@db.abcd.supabase.co:5432/postgres`, 'connect ETIMEDOUT');
    assert.match(out, /IPv6/);
    assert.match(out, /6543/, 'ต้องบอกด้วยว่าให้ใช้พอร์ตไหนแทน');
  });

  test('connection string เพี้ยนจนอ่านไม่ออก ต้องเดาว่าเป็นเพราะอักขระพิเศษ', () => {
    const out = capture('ไม่ใช่ URL เลย', 'อะไรก็ตาม');
    assert.match(out, /อ่าน connection string ไม่ออก/);
    assert.match(out, /%40/, 'สาเหตุที่พบบ่อยคือรหัสผ่านมี @ ที่ยังไม่ได้แปลง');
  });
});
