// ยาม: supabase/migrations/0001_init.sql ต้องตรงกับ src/db/schema.sql เสมอ
//
// migration บน Supabase = ส่วนหัวคอมเมนต์ + เนื้อหา schema.sql เป๊ะ
// ถ้าแก้ schema.sql แล้วลืม regenerate migration → Supabase ที่ตั้งใหม่จะได้โครงสร้างเก่า
// (ตาราง/คอลัมน์ใหม่หาย = production พัง) เทสต์นี้ทำให้ CI แดงทันทีถ้าสองไฟล์ไม่ตรงกัน
//
// วิธี regenerate เมื่อเทสต์นี้ fail:
//   head -4 supabase/migrations/0001_init.sql > /tmp/h && cat /tmp/h src/db/schema.sql > supabase/migrations/0001_init.sql

import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8');

describe('migration ↔ schema.sql sync', () => {
  test('0001_init.sql ลงท้ายด้วยเนื้อหา schema.sql เป๊ะ (ลืม regenerate = fail)', () => {
    assert.ok(
      migration.endsWith(schema),
      'supabase/migrations/0001_init.sql ไม่ตรงกับ src/db/schema.sql — ลืม regenerate? ' +
        'รัน: head -4 supabase/migrations/0001_init.sql > /tmp/h && cat /tmp/h src/db/schema.sql > supabase/migrations/0001_init.sql',
    );
  });

  test('ส่วนที่นำหน้า schema เป็นคอมเมนต์ล้วน (ไม่มี SQL แอบอยู่ในหัว)', () => {
    const header = migration.slice(0, migration.length - schema.length);
    for (const line of header.split('\n')) {
      assert.ok(
        line === '' || line.startsWith('--'),
        `บรรทัดหัว migration ต้องเป็นคอมเมนต์หรือบรรทัดว่าง แต่พบ SQL: "${line}"`,
      );
    }
  });
});
