#!/usr/bin/env bash
#
# ตั้งค่า Supabase ให้พันธมิตรเงินทุน แบบอัตโนมัติ
#
# ใช้ได้หลังจากยอมรับข้อตกลง Supabase บน Vercel แล้ว (ต้องทำผ่านเบราว์เซอร์ครั้งเดียว)
#   https://vercel.com/chao-dee/~/integrations/accept-terms/supabase
#
# สคริปต์นี้จะ:
#   1. สร้างฐานข้อมูล Supabase ผ่าน Vercel Marketplace
#   2. ดึงตัวแปรสภาพแวดล้อมมาไว้ในเครื่อง
#   3. สร้างตารางทั้งหมด + ผู้ใช้ตั้งต้น
#   4. สร้าง Storage bucket สำหรับไฟล์แนบ
#   5. deploy ใหม่แล้วตรวจว่าใช้งานได้จริง
#
# วิธีใช้:  bash scripts/setup-supabase.sh
#
set -euo pipefail

SCOPE="${VERCEL_SCOPE:-chao-dee}"
ENV_FILE=".env.production.local"
BUCKET="fund-partner"
VC="npx --no-install vercel"

cd "$(dirname "$0")/.."

say()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. ตรวจสอบ
say "ตรวจสอบเครื่องมือ"
command -v node >/dev/null || die "ไม่พบ Node.js"
$VC whoami --scope "$SCOPE" >/dev/null 2>&1 || die "ยังไม่ได้เข้าสู่ระบบ Vercel — รัน: npx vercel login"
ok "Vercel: $($VC whoami --scope "$SCOPE" 2>/dev/null | tail -1)"
[ -f .vercel/project.json ] || die "ยังไม่ได้เชื่อมโปรเจกต์ — รัน: npx vercel link"
ok "โปรเจกต์เชื่อมแล้ว"

# ---------------------------------------------------- 2. สร้างฐานข้อมูล Supabase
say "สร้างฐานข้อมูล Supabase"
if $VC integration list --scope "$SCOPE" 2>/dev/null | grep -qi supabase; then
  ok "มี Supabase เชื่อมกับโปรเจกต์อยู่แล้ว — ข้ามขั้นตอนสร้าง"
else
  set +e
  ADD_OUT=$($VC integration add supabase --environment production --format=json --scope "$SCOPE" < /dev/null 2>&1)
  ADD_CODE=$?
  set -e
  if echo "$ADD_OUT" | grep -q "integration_terms_acceptance_required"; then
    cat <<'MSG'

  ✗ ต้องยอมรับข้อตกลงของ Supabase ก่อน (ทำครั้งเดียว ผ่านเบราว์เซอร์เท่านั้น)

    เปิดลิงก์นี้แล้วกดยอมรับ:
    https://vercel.com/chao-dee/~/integrations/accept-terms/supabase?source=cli

    เป็นการยอมรับ EULA + Privacy Policy ของ Supabase ในนามทีมคุณ
    จึงต้องเป็นคุณกดเอง แล้วรันสคริปต์นี้ใหม่อีกครั้ง

MSG
    exit 2
  fi
  [ $ADD_CODE -eq 0 ] || die "สร้าง Supabase ไม่สำเร็จ:\n$ADD_OUT"
  ok "สร้างฐานข้อมูลแล้ว"
fi

# ------------------------------------------------------- 3. ดึงตัวแปรมาในเครื่อง
say "ดึงตัวแปรสภาพแวดล้อม"
$VC env pull "$ENV_FILE" --environment production --scope "$SCOPE" --yes >/dev/null 2>&1 \
  || die "ดึงตัวแปรไม่สำเร็จ"
ok "บันทึกลง $ENV_FILE (ไฟล์นี้อยู่ใน .gitignore แล้ว)"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

DB_URL="${DATABASE_URL:-${POSTGRES_URL:-}}"
[ -n "$DB_URL" ] || die "ไม่พบ DATABASE_URL หรือ POSTGRES_URL ในตัวแปรที่ดึงมา"
ok "ฐานข้อมูล: $(echo "$DB_URL" | sed -E 's#(://[^:]+:)[^@]+(@)#\1****\2#')"

# ให้แน่ใจว่าแอปอ่านเจอ (โค้ดอ่าน DATABASE_URL ก่อน แล้วค่อย POSTGRES_URL)
if [ -z "${DATABASE_URL:-}" ]; then
  warn "ไม่มี DATABASE_URL — โค้ดจะใช้ POSTGRES_URL แทน (รองรับอยู่แล้ว)"
fi

# ------------------------------------------- 4. สร้างตาราง + ผู้ใช้ตั้งต้น
say "สร้างตารางและผู้ใช้ตั้งต้น"
DATABASE_URL="$DB_URL" node src/db/seed.js || die "สร้างข้อมูลตั้งต้นไม่สำเร็จ"
ok "ตารางและผู้ใช้พร้อมแล้ว"

# --------------------------------------------------- 5. สร้าง Storage bucket
say "สร้างที่เก็บไฟล์แนบ"
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  CODE=$(curl -s -o /tmp/fp-bucket.json -w '%{http_code}' \
    -X POST "${SUPABASE_URL%/}/storage/v1/bucket" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$BUCKET\",\"id\":\"$BUCKET\",\"public\":true}")
  case "$CODE" in
    200|201) ok "สร้าง bucket \"$BUCKET\" แล้ว (public)" ;;
    409)     ok "bucket \"$BUCKET\" มีอยู่แล้ว" ;;
    *)       warn "สร้าง bucket ไม่สำเร็จ (HTTP $CODE) — สร้างเองได้ที่ Supabase > Storage"
             cat /tmp/fp-bucket.json 2>/dev/null | head -c 200; echo ;;
  esac
  $VC env add SUPABASE_STORAGE_BUCKET production --force --scope "$SCOPE" <<<"$BUCKET" >/dev/null 2>&1 \
    && ok "ตั้งค่า SUPABASE_STORAGE_BUCKET แล้ว" \
    || warn "ตั้ง SUPABASE_STORAGE_BUCKET ไม่สำเร็จ (ค่าเริ่มต้นคือ $BUCKET อยู่แล้ว)"
else
  warn "ไม่พบ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — ไฟล์แนบจะยังใช้ไม่ได้"
fi

# ------------------------------------------------------------- 6. deploy ใหม่
say "deploy ใหม่ให้ตัวแปรมีผล"
URL=$($VC deploy --prod --yes --scope "$SCOPE" 2>&1 | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | tail -1)
[ -n "$URL" ] || die "deploy ไม่สำเร็จ"
ok "deploy แล้ว: $URL"

# ------------------------------------------------------------------ 7. ตรวจ
say "ตรวจสอบระบบ"
sleep 5
PROD="https://fund-partner.vercel.app"
for path in /welcome /api/auth/session; do
  code=$(curl -s -o /tmp/fp-check.json -w '%{http_code}' "$PROD$path")
  if [ "$code" = "200" ]; then ok "$path → $code"
  else warn "$path → $code : $(head -c 160 /tmp/fp-check.json)"; fi
done

cat <<MSG

────────────────────────────────────────────────────────────
  เสร็จแล้ว — เข้าใช้งานที่ $PROD

  ⚠  สิ่งที่ต้องทำทันที
     เข้าสู่ระบบด้วย owner / owner1234 แล้ว "เปลี่ยนรหัสผ่านทั้ง 4 บัญชี"
     (owner, manager, collector, account)
     เพราะรหัสตั้งต้นเปิดเผยอยู่ใน repo สาธารณะ
────────────────────────────────────────────────────────────

MSG
