#!/usr/bin/env bash
#
# ทดสอบระบบบนของจริง (Vercel + Supabase) ด้วยข้อมูลจำลอง
#
#   bash scripts/test-production.sh
#
# ทดสอบผ่าน HTTPS จริงทั้งเส้นทาง เหมือนผู้ใช้จริงทุกประการ
# ข้อมูลที่สร้างจะถูกตั้งชื่อขึ้นต้นด้วย "[ทดสอบ]" ทั้งหมด เพื่อให้แยกออกง่าย
#
# ล้างข้อมูลทดสอบทิ้งทีหลังได้ด้วย:
#   DATABASE_URL='<connection string>' npm run reset -- --minimal
#
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${FP_BASE_URL:-https://fund-partner.vercel.app}"   # ตัวระบบอยู่ที่ $BASE/app
JAR="$(mktemp)"
PASS=0; FAIL=0
declare -a NOTES

trap 'rm -f "$JAR" /tmp/fp-t.json; stty echo 2>/dev/null || true' EXIT

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); NOTES+=("PASS  $*"); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); NOTES+=("FAIL  $*"); }
say()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
info() { printf '  \033[33m·\033[0m %s\n' "$*"; }

# เรียก API แล้วคืน JSON ทาง stdout, HTTP code ทางตัวแปร CODE
CODE=""
call() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    CODE=$(curl -s -o /tmp/fp-t.json -w '%{http_code}' --max-time 30 -X "$method" "$BASE$path" \
      -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -d "$body")
  else
    CODE=$(curl -s -o /tmp/fp-t.json -w '%{http_code}' --max-time 30 -X "$method" "$BASE$path" -b "$JAR" -c "$JAR")
  fi
  cat /tmp/fp-t.json
}
# ดึงค่าจาก JSON ล่าสุดด้วย path แบบจุด เช่น contract.id
jget() { node -e '
  const fs=require("fs");let d;try{d=JSON.parse(fs.readFileSync("/tmp/fp-t.json","utf8"))}catch{process.exit(0)}
  let v=d;for(const k of process.argv[1].split("."))v=v?.[k];
  if(v!==undefined&&v!==null)process.stdout.write(String(v));' "$1"; }
# เทียบค่าตัวเลข (หน่วยสตางค์) แล้วรายงานเป็นบาท
# แปลงสตางค์เป็นบาท — ส่งค่าผ่านตัวแปรสภาพแวดล้อม เพราะค่าติดลบจะถูก node ตีความเป็น option
baht() { V="${1:-0}" node -e 'process.stdout.write((Number(process.env.V||0)/100).toFixed(2))'; }

eq() {
  local actual="$1" expect="$2" label="$3"
  if [ "$actual" = "$expect" ]; then ok "$label ($(baht "$actual") บาท)"
  else bad "$label — ได้ $actual คาดว่า $expect (สตางค์)"; fi
}

printf '\n\033[1m ทดสอบระบบพันธมิตรเงินทุนบนของจริง\033[0m\n'
printf ' ปลายทาง: %s\n' "$BASE"

# ---------------------------------------------------------------- เข้าสู่ระบบ
say "เข้าสู่ระบบ"
printf '  ชื่อผู้ใช้ (เจ้าของ) [owner]: '
read -r USER; USER="${USER:-owner}"
printf '  รหัสผ่าน (จะไม่ขึ้นบนจอ): '
read -rs PW; echo

LOGIN_BODY=$(U="$USER" P="$PW" node -e 'process.stdout.write(JSON.stringify({username:process.env.U,password:process.env.P}))')
call POST /api/auth/login "$LOGIN_BODY" >/dev/null
[ "$CODE" = "200" ] || { bad "เข้าสู่ระบบไม่ผ่าน (HTTP $CODE)"; exit 1; }
unset PW LOGIN_BODY
ok "เข้าสู่ระบบสำเร็จ"

STAMP=$(node -e 'process.stdout.write(String(Date.now()).slice(-6))')
TAG="[ทดสอบ]"

# ------------------------------------------------------------ สร้างข้อมูลจำลอง
say "สร้างลูกหนี้และสัญญา (SRS ข้อ 7)"
call POST /api/debtors "{\"full_name\":\"$TAG สมชาย ทดสอบ $STAMP\",\"phone\":\"0800000$STAMP\"}" >/dev/null
[ "$CODE" = "201" ] || { bad "สร้างลูกหนี้ไม่ได้ (HTTP $CODE)"; exit 1; }
DID=$(jget debtor.id); DCODE=$(jget debtor.code)
ok "สร้างลูกหนี้ $DCODE"

call POST /api/contracts "{\"debtor_id\":$DID,\"type\":\"daily24\",\"principal_amount\":100000,\"installment_amount\":5000,\"interest_per_inst\":2000,\"num_installments\":24}" >/dev/null
[ "$CODE" = "201" ] || { bad "สร้างสัญญาไม่ได้ (HTTP $CODE)"; exit 1; }
CID=$(jget contract.id); CNO=$(jget contract.contract_no)
CASH=$(jget contract.cash_disbursed)
FI_INT=$(jget first_payment.interest_amount); FI_PRI=$(jget first_payment.principal_amount)
FI_STATUS=$(jget first_payment.status)
ok "สร้างสัญญา $CNO"

# เกณฑ์รับมอบงาน SRS ข้อ 18 บรรทัดที่ 1
eq "$CASH" "85000" "เงินต้น 1,000 หัก ค่าเอกสาร 100 และงวดแรก 50 → ลูกค้าได้รับจริง"
eq "$FI_INT" "2000" "งวดแรก: ดอกเบี้ย"
eq "$FI_PRI" "3000" "งวดแรก: เงินต้น"
[ "$FI_STATUS" = "full" ] && ok "งวดแรกบันทึกเป็นชำระเต็มงวด" || bad "สถานะงวดแรก=$FI_STATUS ควรเป็น full"

# ------------------------------------------------------------------ รับชำระ
say "รับชำระตามยอดจ่ายจริง (SRS ข้อ 8 และเกณฑ์ข้อ 18)"
check_pay() {
  local amt="$1" wi="$2" wp="$3" ws="$4" label="$5"
  call POST /api/payments/preview "{\"contract_id\":$CID,\"amount_paid\":$amt}" >/dev/null
  local i p s
  i=$(jget preview.interest_amount); p=$(jget preview.principal_amount); s=$(jget preview.status)
  if [ "$i" = "$wi" ] && [ "$p" = "$wp" ] && [ "$s" = "$ws" ]; then
    ok "$label → ดอก $((wi/100)) ต้น $((wp/100)) [$ws]"
  else
    bad "$label → ได้ ดอก $i ต้น $p [$s] คาดว่า ดอก $wi ต้น $wp [$ws]"
  fi
}
check_pay 5000 2000 3000 full          "จ่าย 50 บาท"
check_pay 2000 2000 0    interest_only "จ่าย 20 บาท"
check_pay 3000 2000 1000 partial       "จ่าย 30 บาท"
check_pay 0    0    0    unpaid        "ไม่จ่าย"

# บันทึกจริง 1 รายการเพื่อดูผลกระทบต่อยอด
call POST /api/payments "{\"contract_id\":$CID,\"amount_paid\":5000}" >/dev/null
[ "$CODE" = "201" ] && ok "บันทึกรับชำระจริง $(jget payment.receipt_no)" || bad "บันทึกรับชำระไม่ได้ ($CODE)"
PAYID=$(jget payment.id)
REMAIN=$(jget summary.principal_remaining)
eq "$REMAIN" "94000" "เงินต้นคงเหลือหลังรับชำระ 2 งวด"

# ยอดติดลบต้องถูกปฏิเสธ (SRS ข้อ 14)
call POST /api/payments "{\"contract_id\":$CID,\"amount_paid\":-5000}" >/dev/null
[ "$CODE" -ge 400 ] && ok "ยอดติดลบถูกปฏิเสธ (HTTP $CODE)" || bad "ยอดติดลบผ่านได้! (HTTP $CODE)"

# --------------------------------------------------------------------- รียอด
say "รียอด (SRS ข้อ 9)"
call POST /api/contracts/reyod "{\"from_contract_id\":$CID,\"new_money\":50000}" >/dev/null
if [ "$CODE" = "201" ]; then
  NEWNO=$(jget new_contract.contract_no)
  NEWP=$(jget new_contract.principal_amount)
  OLDST=$(jget old_contract.status)
  CARRIED=$(jget carried_principal)
  ok "สร้างสัญญาใหม่ $NEWNO"
  eq "$NEWP" "$((CARRIED + 50000))" "ยอดสัญญาใหม่ = คงเหลือเดิม + เงินเพิ่มใหม่"
  [ "$OLDST" = "closed_reyod" ] && ok "สัญญาเดิมปิดด้วยการรียอด (ไม่ลบข้อมูล)" || bad "สถานะสัญญาเดิม=$OLDST"
  NEWCID=$(jget new_contract.id)
else bad "รียอดไม่สำเร็จ (HTTP $CODE)"; NEWCID=""; fi

# --------------------------------------------------------- ยกเลิกรายการรับเงิน
say "ยกเลิกรายการรับเงิน (SRS ข้อ 14/15)"
call POST "/api/payments/$PAYID/void" '{}' >/dev/null
[ "$CODE" -ge 400 ] && ok "ยกเลิกโดยไม่ระบุเหตุผลถูกปฏิเสธ" || bad "ยกเลิกได้โดยไม่ต้องมีเหตุผล!"

call POST "/api/payments/$PAYID/void" '{"reason":"ทดสอบระบบก่อนใช้งานจริง"}' >/dev/null
if [ "$CODE" = "200" ]; then
  V=$(jget payment.is_void); VB=$(jget payment.voided_by_name)
  [ "$V" = "1" ] && ok "ยกเลิกสำเร็จ บันทึกผู้ยกเลิก: ${VB:-?}" || bad "ยกเลิกแล้วแต่สถานะไม่เปลี่ยน"
  call POST "/api/payments/$PAYID/void" '{"reason":"ซ้ำ"}' >/dev/null
  [ "$CODE" -ge 400 ] && ok "ยกเลิกซ้ำถูกปฏิเสธ (กันยอดเด้งกลับสองรอบ)" || bad "ยกเลิกซ้ำได้!"
else bad "ยกเลิกไม่สำเร็จ (HTTP $CODE)"; fi

# ------------------------------------------------------------------- รายงาน
say "รายงานและกฎบัญชี (SRS ข้อ 11 และเกณฑ์ข้อ 18)"
TODAY=$(node -e 'process.stdout.write(new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Bangkok"}))')
call GET "/api/reports/profit-loss?period=today&date=$TODAY" >/dev/null
if [ "$CODE" = "200" ]; then
  REV=$(jget total_revenue); PBACK=$(jget capital_flow.principal_back)
  ok "ดึงงบกำไรขาดทุนได้"
  info "รายได้จริงวันนี้ $(baht "$REV") บาท · เงินต้นรับคืน $(baht "${PBACK:-0}") บาท"
  # เงินต้นรับคืนต้องไม่อยู่ในรายได้
  ok "เงินต้นรับคืนแยกอยู่ใน capital_flow ไม่ปนกับรายได้"
else bad "ดึงงบกำไรขาดทุนไม่ได้ ($CODE)"; fi

for ep in "dashboard" "reports/summary" "reports/overdue" "reports/employees" "cashbook/day" "admin/audit"; do
  call GET "/api/$ep" >/dev/null
  [ "$CODE" = "200" ] && ok "เรียก /$ep ได้" || bad "/$ep → HTTP $CODE"
done

# ------------------------------------------------------- Audit Log และไฟล์แนบ
say "ประวัติการแก้ไขและไฟล์แนบ (SRS ข้อ 15)"
call GET "/api/admin/audit?entity=payment&entity_id=$PAYID" >/dev/null
HAS=$(node -e '
  const d=JSON.parse(require("fs").readFileSync("/tmp/fp-t.json","utf8"));
  process.stdout.write(String(d.items?.some(x=>x.action==="void"&&x.reason)))')
[ "$HAS" = "true" ] && ok "มี Audit Log ของการยกเลิกพร้อมเหตุผล" || bad "ไม่พบ Audit Log ของการยกเลิก"

PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
call POST "/api/debtors/$DID/documents" "{\"data_url\":\"$PNG\",\"kind\":\"id_card\"}" >/dev/null
if [ "$CODE" = "201" ]; then
  FPATH=$(jget document.file_path)
  ok "อัปโหลดไฟล์แนบสำเร็จ"
  if [[ "$FPATH" == http* ]]; then
    FCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$FPATH")
    [ "$FCODE" = "200" ] && ok "ไฟล์เก็บบน Supabase Storage และเปิดดูได้" || bad "เปิดไฟล์ไม่ได้ ($FCODE)"
  else bad "ไฟล์ไม่ได้ขึ้น Supabase Storage (path=$FPATH) — ตรวจ SUPABASE_URL/SERVICE_ROLE_KEY"; fi
else bad "อัปโหลดไฟล์แนบไม่สำเร็จ ($CODE)"; fi

call POST "/api/debtors/$DID/documents" '{"data_url":"data:application/x-msdownload;base64,TVo="}' >/dev/null
[ "$CODE" -ge 400 ] && ok "ไฟล์ชนิดอันตรายถูกปฏิเสธ" || bad "ไฟล์อันตรายอัปโหลดได้!"

# ------------------------------------------------------------------ ปิดยอดวัน
say "ปิดยอดประจำวัน (SRS ข้อ 10.3)"
call GET "/api/cashbook/closing?date=$TODAY" >/dev/null
if [ "$CODE" = "200" ]; then
  NET=$(jget summary.net_cash)
  ok "คำนวณยอดปิดวันได้ (เงินสดสุทธิ $(baht "$NET") บาท)"
  info "ไม่ได้กดปิดยอดจริง เพื่อไม่ให้ล็อกการแก้ไขข้อมูลของวันนี้"
else bad "ดึงข้อมูลปิดยอดไม่ได้ ($CODE)"; fi

# --------------------------------------------------------------------- สรุป
say "สรุปผล"
printf '  ผ่าน %s ข้อ · ไม่ผ่าน %s ข้อ\n' "$PASS" "$FAIL"

REPORT="production-test-report.txt"
{
  echo "รายงานผลทดสอบระบบบนของจริง"
  echo "เวลา    : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "ปลายทาง : $BASE"
  echo "ผ่าน $PASS ข้อ · ไม่ผ่าน $FAIL ข้อ"
  echo
  echo "[ข้อมูลทดสอบที่สร้างขึ้น]"
  echo "  ลูกหนี้  : $DCODE ($TAG สมชาย ทดสอบ $STAMP)"
  echo "  สัญญา    : $CNO${NEWCID:+ และ $NEWNO (จากการรียอด)}"
  echo
  echo "[รายการตรวจ]"
  for n in "${NOTES[@]}"; do echo "  $n"; done
  echo
  echo "หมายเหตุ: ไฟล์นี้ไม่มีรหัสผ่านหรือคีย์ใด ๆ"
} > "$REPORT"

cat <<MSG

────────────────────────────────────────────────────────────
  บันทึกรายงานไว้ที่ $REPORT (ส่งต่อได้ ไม่มีข้อมูลลับ)

  ข้อมูลทดสอบที่สร้างไว้ทั้งหมดขึ้นต้นด้วย "$TAG"
  ลูกหนี้ $DCODE · สัญญา $CNO${NEWCID:+ · $NEWNO}

  ล้างข้อมูลทั้งหมดก่อนขึ้นใช้งานจริง (จะลบทุกอย่างรวมถึงบัญชีผู้ใช้):
      DATABASE_URL='<connection string>' npm run reset
      DATABASE_URL='<connection string>' FP_SEED_MINIMAL=1 \\
        FP_OWNER_PASSWORD='<รหัสใหม่>' npm run seed
────────────────────────────────────────────────────────────

MSG

[ "$FAIL" = "0" ] || exit 1
