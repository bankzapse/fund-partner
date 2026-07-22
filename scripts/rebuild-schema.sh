#!/usr/bin/env bash
#
# ลบตารางของระบบทิ้งแล้วสร้างใหม่จากโครงสร้างล่าสุด
#
#   bash scripts/rebuild-schema.sh
#
# ใช้เมื่อ scripts/inspect-db.sh บอกว่าโครงสร้างไม่ตรงกับโปรแกรม
# สำรองข้อมูลลง backups/ ให้ก่อนเสมอ และต้องพิมพ์ยืนยันก่อนลบ
#
set -uo pipefail
cd "$(dirname "$0")/.."
trap 'stty echo 2>/dev/null || true' EXIT

if [ ! -d node_modules/pg ]; then
  printf '\n  \033[31m✗\033[0m ยังไม่ได้ติดตั้งแพ็กเกจ — รัน npm install ก่อน\n\n'
  exit 1
fi

exec node scripts/rebuild-schema.mjs
