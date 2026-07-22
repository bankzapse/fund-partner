#!/usr/bin/env bash
#
# ส่องดูว่าในฐานข้อมูลมีอะไรอยู่ และโครงสร้างตรงกับโปรแกรมไหม
#
#   bash scripts/inspect-db.sh
#
# อ่านอย่างเดียว ไม่สร้าง ไม่แก้ ไม่ลบอะไรทั้งสิ้น
#
set -uo pipefail
cd "$(dirname "$0")/.."
trap 'stty echo 2>/dev/null || true' EXIT

if [ ! -d node_modules/pg ]; then
  printf '\n  \033[31m✗\033[0m ยังไม่ได้ติดตั้งแพ็กเกจ — รัน npm install ก่อน\n\n'
  exit 1
fi

exec node scripts/inspect-db.mjs
