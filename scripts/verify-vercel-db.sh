#!/usr/bin/env bash
#
# ตรวจว่า DATABASE_URL ที่อยู่ใน Vercel ใช้ต่อฐานข้อมูลได้จริงไหม
#
#   bash scripts/verify-vercel-db.sh
#
# ดึงค่าจริงจาก Vercel มาทดสอบในเครื่อง แล้วลบไฟล์ชั่วคราวทิ้งทันที
# ค่าไม่ขึ้นบนจอและไม่ถูกส่งไปไหน
#
# มีไว้เพราะการเดาว่า "ใส่ค่าถูกหรือยัง" แล้ว deploy ไปลองทีละรอบ
# เสียเวลารอบละหลายนาที ตัวนี้ตอบได้ใน 10 วินาที
#
set -uo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info() { printf '  \033[33m·\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1;34m▸ %s\033[0m\n\n' "$*"; }

TMP=".env.vercel-check.$$"
# ลบไฟล์ชั่วคราวเสมอ ไม่ว่าจะจบแบบไหน กันความลับค้างอยู่ในเครื่อง
cleanup() { rm -f "$TMP"; stty echo 2>/dev/null || true; }
trap cleanup EXIT INT TERM

head_ "ตรวจค่า DATABASE_URL ที่อยู่ใน Vercel"

# ระบุเวอร์ชันตายตัว กันหน้าจอถามอัปเดตมาขวาง
VERCEL="npx --yes vercel@56.3.2"

info "กำลังดึงค่าจาก Vercel..."
if ! $VERCEL env pull "$TMP" --environment=production --yes >/dev/null 2>&1; then
  bad "ดึงค่าไม่ได้"
  info "ถ้ายังไม่ได้เข้าสู่ระบบ Vercel ให้รัน: npx vercel@56.3.2 login"
  exit 1
fi

if ! grep -q '^DATABASE_URL=' "$TMP"; then
  bad "ไม่พบ DATABASE_URL ใน Vercel (สภาพแวดล้อม Production)"
  info "ตัวแปรที่มี:"
  grep -oE '^[A-Z_]+' "$TMP" | sed 's/^/     /'
  exit 1
fi

# ดึงเฉพาะบรรทัดที่ต้องการ ถอดเครื่องหมายคำพูดที่ Vercel ใส่มา
DB_URL=$(grep '^DATABASE_URL=' "$TMP" | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')

if [ -z "$DB_URL" ]; then
  bad "DATABASE_URL มีอยู่แต่ค่าว่าง"
  exit 1
fi

# ถ้าเป็นตัวแปรแบบ Sensitive จะดึงค่าจริงไม่ได้ Vercel ส่งค่าหลอกมาแทน
if printf '%s' "$DB_URL" | grep -q '\[SENSITIVE\]\|VERCEL_ENV_PULL\|\*\*\*'; then
  bad "ตัวแปรนี้ตั้งเป็นแบบ Sensitive จึงดึงค่าจริงมาตรวจไม่ได้"
  info "ใช้ bash scripts/set-vercel-db.sh แทน — ตัวนั้นทดสอบก่อนส่งขึ้น Vercel"
  exit 1
fi

ok "ดึงค่ามาได้"
echo

# ส่งต่อให้ตัวตรวจฐานข้อมูลตัวเดิม จะได้ผลแบบเดียวกับที่ทดสอบด้วยมือ
DATABASE_URL="$DB_URL" node scripts/inspect-db.mjs
RESULT=$?

echo
if [ $RESULT -eq 0 ]; then
  ok "ค่าที่อยู่ใน Vercel ใช้งานได้จริง — deploy ได้เลย"
else
  bad "ค่าที่อยู่ใน Vercel ยังใช้ไม่ได้ — แก้ก่อนแล้วรันตัวนี้ซ้ำ"
fi
exit $RESULT
