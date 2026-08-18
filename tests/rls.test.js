// ยาม RLS: ทุกตารางใน public ต้องเปิด Row Level Security เสมอ
//
// schema.sql เปิด RLS แบบไดนามิก (ครอบทุกตาราง) เทสต์นี้กันตกหล่นอีกชั้น —
// ถ้าเพิ่มตารางใหม่แล้ว RLS ไม่ติด (เช่น สร้างตารางหลังบล็อก RLS หรือกลไกเปลี่ยน)
// เทสต์จะ fail ทันทีใน CI ไม่ปล่อยให้ตารางเปิดโล่งขึ้น production
process.env.FP_DB_PATH = ':memory:';

import { after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { all, closeDb } from '../src/db/index.js';

after(async () => {
  await closeDb();
});

describe('Row Level Security', () => {
  test('ทุกตารางใน public เปิด RLS ครบ (ตารางใหม่ต้องถูกครอบเองเสมอ)', async () => {
    const rows = await all(`
      SELECT c.relname AS table, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    assert.ok(rows.length >= 18, `ควรมีตารางอย่างน้อย 18 ตาราง (พบ ${rows.length})`);
    const off = rows.filter((r) => !r.rls).map((r) => r.table);
    assert.equal(off.length, 0, `ตารางที่ยังไม่เปิด RLS: ${off.join(', ') || '(none)'}`);
  });
});
