# ทำให้ไฟล์แนบเป็นส่วนตัว (Supabase Storage private bucket)

> **ทำไมต้องทำ:** เดิม bucket เป็นแบบ *public* — สำเนาบัตรประชาชนและสลิปที่อัปโหลด
> เปิดดูได้ด้วย URL ตรง ๆ โดยไม่ต้องล็อกอิน (ความเสี่ยง PDPA อันดับ 1)
> โค้ดฝั่งเซิร์ฟเวอร์แก้ให้เรียบร้อยแล้ว เหลือ **สลับ bucket เป็น private** ในหน้า Supabase
> กับ **ย้ายข้อมูลเก่า** (ถ้ามี) ซึ่งต้องทำเองเพราะต้องเข้าหน้าเว็บ/รันบนฐานข้อมูลจริง

หลังแก้แล้ว การเปิดไฟล์จะไหลแบบนี้:

```
เบราว์เซอร์ → /uploads/<ชื่อไฟล์> (มีคุกกี้ล็อกอิน)
           → เซิร์ฟเวอร์ตรวจสิทธิ์ → ขอ signed URL อายุ 60 วิ จาก Supabase
           → 302 พาไปเปิดไฟล์
```
ฐานข้อมูลจะเก็บแค่ `/uploads/<ชื่อไฟล์>` ไม่เก็บ URL ตรงของ bucket อีกต่อไป

---

## ขั้นที่ 1 — สลับ bucket เป็น private (หน้าเว็บ Supabase)

1. เปิด **Supabase → โปรเจกต์ `gguaynkcuecwfxsctwgk` → Storage**
2. เลือก bucket ชื่อ **`fund-partner`** (หรือชื่อที่ตั้งใน `SUPABASE_STORAGE_BUCKET`)
3. กดไอคอนตั้งค่า (⋯ / Edit bucket) → ปิดสวิตช์ **Public bucket** ให้เป็น **Private**
4. บันทึก

ถ้ายังไม่มี bucket นี้ ให้สร้างใหม่แบบ **Private** ตั้งแต่แรก (ชื่อ `fund-partner`)

> ระบบใช้ **service role key** ในการอัปโหลดและออก signed URL อยู่แล้ว
> จึงทำงานได้ปกติแม้ bucket เป็น private — ไม่ต้องตั้ง Storage Policy เพิ่ม

---

## ขั้นที่ 2 — ย้าย URL เก่าในฐานข้อมูล (รันถ้ามีไฟล์แนบเก่าอยู่แล้ว)

ถ้าเพิ่งเปิดใช้งานและยังไม่มีใครอัปโหลดไฟล์ ข้ามข้อนี้ได้เลย
ถ้ามีข้อมูลเก่าที่เก็บเป็น URL เต็ม (`.../object/public/...`) ให้รัน SQL นี้ใน
**Supabase → SQL Editor** (ปลอดภัย รันซ้ำได้ ไม่กระทบค่าที่เป็น `/uploads/...` อยู่แล้ว):

```sql
-- ดึงเฉพาะชื่อไฟล์ท้าย URL แล้วเก็บเป็นเส้นทางภายใน /uploads/<ชื่อไฟล์>
UPDATE debtor_documents
   SET file_path = '/uploads/' || regexp_replace(split_part(file_path, '?', 1), '^.*/', '')
 WHERE file_path LIKE 'http%';

UPDATE payments
   SET proof_path = '/uploads/' || regexp_replace(split_part(proof_path, '?', 1), '^.*/', '')
 WHERE proof_path LIKE 'http%';
```

ตรวจผลว่าไม่เหลือ URL เต็มแล้ว (ควรได้ `0` ทั้งคู่):

```sql
SELECT
  (SELECT COUNT(*) FROM debtor_documents WHERE file_path LIKE 'http%') AS docs_left,
  (SELECT COUNT(*) FROM payments        WHERE proof_path LIKE 'http%') AS proofs_left;
```

> แม้ยังไม่รัน SQL นี้ ระบบก็แปลง URL เก่าให้ชี้ผ่านด่านล็อกอินตอนส่งออก API ให้อยู่แล้ว
> แต่การรัน SQL ทำให้ข้อมูลในฐานสะอาดและตรงกับของใหม่

---

## ขั้นที่ 3 — ตรวจว่าปิดช่องโหว่แล้วจริง

1. อัปโหลดสำเนาบัตรของลูกหนี้สักคนผ่านระบบ
2. เปิดหน้าประวัติลูกหนี้ → กดลิงก์เอกสาร → ต้องเปิดดูได้ตามปกติ (เพราะล็อกอินอยู่)
3. คัดลอก URL ของไฟล์ (จะเป็น `.../uploads/...`) → เปิดในหน้าต่างไม่ระบุตัวตน (ไม่ได้ล็อกอิน)
   → ต้องได้ **401 กรุณาเข้าสู่ระบบ** ไม่ใช่ตัวรูป
4. ลองเดา URL แบบเก่า `https://<project>.supabase.co/storage/v1/object/public/fund-partner/<ไฟล์>`
   → ต้องได้ **Bucket not found / 400** (เพราะ bucket เป็น private แล้ว)

ถ้าข้อ 3 และ 4 เป็นไปตามนี้ = ปิดช่องโหว่เรียบร้อย
