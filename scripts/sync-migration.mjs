// สร้าง supabase/migrations/0001_init.sql ใหม่จาก src/db/schema.sql ให้ตรงกันเป๊ะ
//
// รันหลังแก้ schema.sql ทุกครั้ง: npm run sync:migration
// (มี tests/migration-sync.test.js เป็นด่านกันใน CI ถ้าลืมรัน)
import { readFileSync, writeFileSync } from 'node:fs';

// ส่วนหัวคอมเมนต์ของ migration (คงที่) — เนื้อหาที่เหลือคือ schema.sql ทั้งไฟล์
const HEADER =
  '-- พันธมิตรเงินทุน :: Migration สำหรับ Supabase\n' +
  '-- รันใน Supabase Dashboard > SQL Editor (หรือปล่อยให้ระบบสร้างเองตอนเชื่อมต่อครั้งแรก)\n' +
  '-- ไฟล์นี้สร้างจาก src/db/schema.sql จึงตรงกันเสมอ\n' +
  '\n';

const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
const out = new URL('../supabase/migrations/0001_init.sql', import.meta.url);
writeFileSync(out, HEADER + schema);
console.log('✓ regenerate supabase/migrations/0001_init.sql จาก schema.sql แล้ว');
