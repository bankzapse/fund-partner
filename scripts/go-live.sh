#!/usr/bin/env bash
#
# เตรียมฐานข้อมูลจริงก่อนเปิดใช้งาน — ล้างข้อมูลทดสอบ แล้วสร้างผู้ใช้จริง
#
#   bash scripts/go-live.sh
#   bash scripts/go-live.sh --staff=staff.json     (โหลดรายชื่อจากไฟล์)
#   DATABASE_URL='...' bash scripts/go-live.sh     (ไม่ต้องวาง connection string)
#
# ทำงานในเครื่องคุณเท่านั้น รหัสผ่านที่พิมพ์ไม่ถูกส่งไปไหนและไม่ลงไฟล์
# สำรองข้อมูลลง backups/ ก่อนลบเสมอ ถ้าสำรองไม่สำเร็จจะไม่ลบอะไรเลย
#
set -uo pipefail
cd "$(dirname "$0")/.."

bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# คืนสถานะจอให้ปกติ เผื่อกด Ctrl+C ตอนกำลังพิมพ์รหัสผ่านที่ถูกซ่อนไว้
trap 'stty echo 2>/dev/null || true' EXIT

if [ ! -d node_modules/pg ] || [ ! -d node_modules/bcryptjs ]; then
  printf '\n'
  bad 'ยังไม่ได้ติดตั้งแพ็กเกจ'
  printf '     รัน npm install ก่อน แล้วค่อยรันสคริปต์นี้อีกครั้ง\n\n'
  exit 1
fi

# ส่งอาร์กิวเมนต์ต่อไปให้สคริปต์หลัก เช่น --staff=staff.json
exec node scripts/go-live.mjs "$@"
