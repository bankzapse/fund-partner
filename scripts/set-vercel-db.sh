#!/usr/bin/env bash
#
# ตั้งค่า DATABASE_URL บน Vercel โดยทดสอบให้ผ่านก่อนเสมอ
#
#   bash scripts/set-vercel-db.sh
#
# แก้ปัญหาที่เจอบ่อย: ทดสอบในเครื่องผ่าน แต่พอคัดลอกไปวางในหน้าเว็บหรือ CLI
# แล้วตกหล่น มีช่องว่างติด หรือวางไม่ทับของเดิม ทำให้ต้อง deploy ลองใหม่หลายรอบ
#
# ตัวนี้ใช้ค่าชุดเดียวกันตั้งแต่ทดสอบจนถึงส่งขึ้น Vercel จึงเพี้ยนไม่ได้
# ค่าไม่ขึ้นบนจอ ไม่ค้างในไฟล์ และไม่ถูกส่งไปที่อื่นนอกจาก Vercel
#
set -uo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info() { printf '  \033[33m·\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1;34m▸ %s\033[0m\n\n' "$*"; }

VERCEL="npx --yes vercel@56.3.2"
TMP=$(mktemp "${TMPDIR:-/tmp}/fp-conn.XXXXXX")
cleanup() { rm -f "$TMP"; stty echo 2>/dev/null || true; }
trap cleanup EXIT INT TERM

head_ "ตั้งค่า DATABASE_URL บน Vercel"
echo "  ทดสอบให้ผ่านก่อน แล้วค่อยส่งค่าชุดเดียวกันขึ้น Vercel"
echo "  ค่าที่พิมพ์จะไม่ขึ้นบนจอ"
echo

# อ่านแบบไม่แสดงบนจอ แล้วเขียนลงไฟล์ชั่วคราวโดยไม่มีอักขระขึ้นบรรทัดใหม่ต่อท้าย
printf '  วาง connection string: '
stty -echo 2>/dev/null
IFS= read -r CONN
stty echo 2>/dev/null
echo; echo

# ตัดช่องว่างและอักขระควบคุมหัวท้ายทิ้ง เป็นสาเหตุที่พบบ่อยที่สุด
CONN=$(printf '%s' "$CONN" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

if [ -z "$CONN" ]; then
  bad "ไม่ได้ใส่อะไรมา"
  exit 1
fi

# ---- 1. ทดสอบก่อน --------------------------------------------------------
head_ "1) ทดสอบกับฐานข้อมูลจริง"
if ! DATABASE_URL="$CONN" node scripts/inspect-db.mjs; then
  echo
  bad "ยังใช้ไม่ได้ — ไม่ส่งขึ้น Vercel"
  info "แก้ตามที่แจ้งด้านบน แล้วรันคำสั่งนี้ใหม่"
  exit 1
fi

# ---- 2. ส่งขึ้น Vercel ---------------------------------------------------
head_ "2) ส่งขึ้น Vercel"

info "ลบค่าเดิม..."
$VERCEL env rm DATABASE_URL production --yes >/dev/null 2>&1 || true

# ส่งผ่าน stdin ไม่ใช่การพิมพ์หรือวาง จึงไม่มีทางตกหล่น
printf '%s' "$CONN" > "$TMP"
if $VERCEL env add DATABASE_URL production --sensitive < "$TMP" >/dev/null 2>&1; then
  ok "ตั้งค่าบน Vercel แล้ว"
else
  bad "ส่งขึ้น Vercel ไม่สำเร็จ"
  info "ตรวจว่าเข้าสู่ระบบแล้ว: npx vercel@56.3.2 whoami"
  exit 1
fi

# ---- 3. ยืนยันว่าบันทึกจริง ----------------------------------------------
echo
if $VERCEL env ls production 2>&1 | grep -q "DATABASE_URL"; then
  ok "ยืนยันแล้วว่ามีอยู่ในสภาพแวดล้อม Production"
fi

echo
ok "เรียบร้อย — ขั้นต่อไปให้ deploy"
info "รัน: npx vercel@56.3.2 --prod --yes"
info "หรือแจ้งผู้ดูแลระบบให้ deploy ให้"
echo
