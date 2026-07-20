#!/usr/bin/env bash
#
# เชื่อมระบบพันธมิตรเงินทุนเข้ากับ Supabase ที่คุณสร้างไว้เอง
#
#   bash scripts/connect-supabase.sh
#
# สคริปต์นี้ถามข้อมูลลับแบบ "พิมพ์แล้วไม่ขึ้นจอ" และไม่บันทึกลงประวัติคำสั่ง
# ผลลัพธ์ที่พิมพ์ออกมาถูกปิดบังข้อมูลลับทั้งหมด ส่งต่อให้คนอื่นดูได้อย่างปลอดภัย
#
# สิ่งที่ทำให้:
#   1. ตรวจการเชื่อมต่อฐานข้อมูล
#   2. ตั้งค่าตัวแปรบน Vercel
#   3. สร้างตารางทั้งหมด + บัญชีเจ้าของ (รหัสผ่านที่คุณกำหนดเอง)
#   4. สร้าง Storage bucket สำหรับไฟล์แนบ
#   5. deploy ใหม่ แล้วตรวจสอบทุกส่วน
#
set -uo pipefail

cd "$(dirname "$0")/.."

SCOPE="${VERCEL_SCOPE:-chao-dee}"
BUCKET="${SUPABASE_STORAGE_BUCKET:-fund-partner}"
PROD_URL="https://fund-partner.vercel.app"
VERCEL_VERSION="${VERCEL_VERSION:-56}"
VC=""   # กำหนดค่าจริงใน ensure_vercel_cli
REPORT="setup-report.txt"

say()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

# ปิดบังรหัสผ่านใน connection string ก่อนแสดงผลเสมอ
mask_url() { sed -E 's#(://[^:/@]+:)[^@]*(@)#\1********\2#g'; }
# ปิดบังคีย์ยาว ๆ เหลือให้พอตรวจว่าใส่ถูกตัว
mask_key() { local k="$1"; printf '%s…%s' "${k:0:6}" "${k: -4}"; }

trap 'stty echo 2>/dev/null || true' EXIT

# ---------------------------------------------------------------- 0. ตรวจสอบ
# หา Vercel CLI ตามลำดับ: ในโปรเจกต์ > ติดตั้งทั่วเครื่อง > ดาวน์โหลดชั่วคราวผ่าน npx
ensure_vercel_cli() {
  if [ -x node_modules/.bin/vercel ]; then
    VC="node_modules/.bin/vercel"
    ok "Vercel CLI: ในโปรเจกต์"
  elif command -v vercel >/dev/null 2>&1; then
    VC="vercel"
    ok "Vercel CLI: ติดตั้งไว้ทั้งเครื่อง"
  else
    warn "ไม่พบ Vercel CLI — กำลังติดตั้งลงโปรเจกต์ (ครั้งเดียว อาจใช้เวลาสักครู่)"
    if ! npm install --no-save "vercel@${VERCEL_VERSION}" >/tmp/fp-npm.log 2>&1; then
      # เครื่องที่เคยรัน sudo npm install จะมีไฟล์ของ root ค้างใน ~/.npm ทำให้ติดตั้งไม่ได้
      if grep -qE "EACCES|EEXIST" /tmp/fp-npm.log; then
        warn "แคชของ npm มีปัญหาสิทธิ์ — ลองใหม่โดยใช้แคชชั่วคราว"
        TMP_CACHE=$(mktemp -d)
        npm install --no-save --cache "$TMP_CACHE" "vercel@${VERCEL_VERSION}" >/tmp/fp-npm.log 2>&1 || {
          rm -rf "$TMP_CACHE"
          printf '\n' >&2
          tail -5 /tmp/fp-npm.log >&2
          die "ติดตั้ง Vercel CLI ไม่สำเร็จ

  แคชของ npm เสียสิทธิ์ ทำให้ติดตั้งอะไรไม่ได้เลยทั้งเครื่อง แก้ถาวรด้วย:
      sudo chown -R $(id -u):$(id -g) ~/.npm
  แล้วรันสคริปต์นี้ใหม่"
        }
        rm -rf "$TMP_CACHE"
      else
        tail -5 /tmp/fp-npm.log >&2
        die "ติดตั้ง Vercel CLI ไม่สำเร็จ — ดูรายละเอียดใน /tmp/fp-npm.log"
      fi
    fi
    [ -x node_modules/.bin/vercel ] || die "ติดตั้ง Vercel CLI แล้วแต่เรียกใช้ไม่ได้"
    VC="node_modules/.bin/vercel"
    ok "ติดตั้ง Vercel CLI แล้ว"
  fi
}

say "ตรวจสอบเครื่องมือ"
command -v node >/dev/null || die "ไม่พบ Node.js"
[ -d node_modules ] || die "ยังไม่ได้ติดตั้ง dependency — รัน: npm install"
ok "Node.js $(node -v)"
ensure_vercel_cli

WHO=$($VC whoami --scope "$SCOPE" 2>/dev/null | tail -1)
if [ -z "$WHO" ] || [ "$WHO" = "Error" ]; then
  die "ยังไม่ได้เข้าสู่ระบบ Vercel — รัน: $VC login"
fi
ok "Vercel: $WHO"

[ -f .vercel/project.json ] || die "ยังไม่ได้เชื่อมโปรเจกต์ — รัน: $VC link --scope $SCOPE --project fund-partner"
ok "โปรเจกต์เชื่อมกับ Vercel แล้ว"

# ------------------------------------------------------------- 1. รับข้อมูล
say "ข้อมูลจาก Supabase (พิมพ์แล้วจะไม่ขึ้นบนจอ)"
cat <<'HELP'
  หาได้จาก Supabase > โปรเจกต์ของคุณ
    · Connection string : Settings > Database > Connection string > URI
                          เลือกแท็บ "Connection pooling" (พอร์ต 6543)
                          อย่าลืมแทนที่ [YOUR-PASSWORD] ด้วยรหัสจริง
    · service_role key  : Settings > API > Project API keys > service_role
HELP

printf '\n  Connection string: '
read -rs DB_URL; echo
[ -n "$DB_URL" ] || die "ไม่ได้ใส่ connection string"
case "$DB_URL" in
  postgres://*|postgresql://*) ;;
  *) die "connection string ต้องขึ้นต้นด้วย postgresql://" ;;
esac
case "$DB_URL" in
  *YOUR-PASSWORD*|*'[YOUR-PASSWORD]'*) die "ยังไม่ได้แทนที่ [YOUR-PASSWORD] ด้วยรหัสผ่านจริง" ;;
esac
if [[ "$DB_URL" != *:6543* ]]; then
  warn "ไม่ใช่พอร์ต 6543 — Serverless ควรใช้แบบ Transaction pooler"
  printf '  จะใช้ต่อไปหรือไม่ (y/N)? '; read -r yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "ยกเลิก — กลับไปเลือกแท็บ Transaction pooler"
fi

# Dedicated pooler เป็น IPv6 ซึ่ง Vercel ต่อไม่ถึง ต้องใช้ Shared pooler ที่เป็น IPv4
if [[ "$DB_URL" == *"db."*".supabase.co"* ]]; then
  cat >&2 <<'MSG'

  ✗ นี่คือ Dedicated pooler (host เป็น db.xxx.supabase.co) ซึ่งใช้ IPv6
    Vercel เป็นเครือข่าย IPv4 จะต่อไม่ติด

    กลับไปที่หน้า Connect แล้วสลับเป็น "Shared pooler"
    ของที่ถูกต้อง host จะเป็น  aws-0-<region>.pooler.supabase.com
    และ user จะเป็น            postgres.<project-ref>

MSG
  exit 1
fi

# ตรวจว่ารหัสผ่านมีอักขระพิเศษที่ยังไม่ได้ percent-encode หรือไม่
# JS ยอมรับ URL ที่ผิดรูปแบบโดยตีความ host เพี้ยน จึงต้องตรวจ host และพอร์ตด้วย
if ! node -e '
  const u = new URL(process.argv[1]);
  const hostOk = /\.supabase\.(com|co)$/.test(u.hostname);
  const portOk = u.port !== "";
  if (!hostOk || !portOk) process.exit(1);
' "$DB_URL" 2>/dev/null; then
  cat >&2 <<'MSG'

  ✗ อ่าน connection string ไม่ออก

    มักเกิดจากรหัสผ่านมีอักขระพิเศษ (@ : / ? # เป็นต้น) ซึ่งต้องแปลงก่อน
    แปลงได้ด้วยคำสั่งนี้ แล้วเอาผลลัพธ์ไปใส่แทนรหัสผ่านในสตริง:

        node -e "console.log(encodeURIComponent(process.argv[1]))" 'รหัสผ่านของคุณ'

MSG
  exit 1
fi
ok "connection string: $(printf '%s' "$DB_URL" | mask_url)"

# เดา project ref จากชื่อผู้ใช้ (รูปแบบ postgres.<ref>) เพื่อประกอบเป็น SUPABASE_URL
PROJECT_REF=$(printf '%s' "$DB_URL" | sed -nE 's#^postgres(ql)?://postgres\.([a-z0-9]+):.*#\2#p')
[ -n "$PROJECT_REF" ] || PROJECT_REF=$(printf '%s' "$DB_URL" | sed -nE 's#.*@db\.([a-z0-9]+)\.supabase\.co.*#\1#p')
if [ -n "$PROJECT_REF" ]; then
  SUPA_URL="https://${PROJECT_REF}.supabase.co"
  ok "Supabase URL: $SUPA_URL"
else
  printf '  Supabase URL (เช่น https://xxxx.supabase.co): '
  read -r SUPA_URL
fi

printf '  service_role key: '
read -rs SERVICE_KEY; echo
[ -n "$SERVICE_KEY" ] || die "ไม่ได้ใส่ service_role key"
ok "service_role key: $(mask_key "$SERVICE_KEY")"

say "ตั้งรหัสผ่านบัญชีเจ้าของ"
echo "  ระบบจะสร้างบัญชี owner ด้วยรหัสนี้ตั้งแต่แรก"
echo "  จะไม่มีรหัสตั้งต้นที่เปิดเผยใน repo อยู่บนฐานข้อมูลจริงเลย"
printf '\n  รหัสผ่านใหม่ (อย่างน้อย 8 ตัว): '
read -rs OWNER_PW; echo
printf '  พิมพ์ซ้ำอีกครั้ง: '
read -rs OWNER_PW2; echo
[ ${#OWNER_PW} -ge 8 ] || die "รหัสผ่านสั้นเกินไป"
[ "$OWNER_PW" = "$OWNER_PW2" ] || die "รหัสผ่านสองครั้งไม่ตรงกัน"
ok "ตั้งรหัสผ่านแล้ว"

# ------------------------------------------------- 2. ทดสอบเชื่อมต่อฐานข้อมูล
say "ทดสอบการเชื่อมต่อฐานข้อมูล"
DATABASE_URL="$DB_URL" node -e "
import('pg').then(async ({ default: pg }) => {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  const r = await pool.query('SELECT current_database() db, version() v');
  console.log('  \x1b[32m✓\x1b[0m ต่อได้: ' + r.rows[0].db + ' | ' + r.rows[0].v.split(',')[0]);
  await pool.end();
}).catch((e) => { console.error('  เชื่อมต่อไม่สำเร็จ: ' + e.message); process.exit(1); });
" || die "เชื่อมต่อฐานข้อมูลไม่ได้ — ตรวจรหัสผ่านและว่าเลือกแบบ Connection pooling แล้ว"

# ----------------------------------------------------- 3. ตั้งค่าตัวแปร Vercel
say "ตั้งค่าตัวแปรบน Vercel"
set_env() {
  local name="$1" value="$2"
  $VC env rm "$name" production --yes --scope "$SCOPE" >/dev/null 2>&1
  if printf '%s' "$value" | $VC env add "$name" production --sensitive --force --scope "$SCOPE" >/dev/null 2>&1; then
    ok "$name"
  else
    warn "ตั้งค่า $name ไม่สำเร็จ"
    return 1
  fi
}
set_env DATABASE_URL              "$DB_URL"      || die "ตั้งค่า DATABASE_URL ไม่สำเร็จ"
set_env SUPABASE_URL              "$SUPA_URL"
set_env SUPABASE_SERVICE_ROLE_KEY "$SERVICE_KEY"
set_env SUPABASE_STORAGE_BUCKET   "$BUCKET"
set_env NODE_ENV                  "production"

# ---------------------------------------- 4. สร้างตารางและบัญชีเจ้าของ
say "สร้างตารางและบัญชีเจ้าของ"
DATABASE_URL="$DB_URL" FP_SEED_MINIMAL=1 FP_OWNER_PASSWORD="$OWNER_PW" \
  node src/db/seed.js 2>&1 | grep -viE "experimental|trace-warnings" | sed 's/^/  /'
[ "${PIPESTATUS[0]}" = "0" ] || die "สร้างตารางไม่สำเร็จ"

TABLE_COUNT=$(DATABASE_URL="$DB_URL" node -e "
import('pg').then(async ({ default: pg }) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(\"SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'\");
  console.log(r.rows[0].n); await pool.end();
}).catch(() => console.log('?'));
" 2>/dev/null)
ok "ตารางในฐานข้อมูล: $TABLE_COUNT ตาราง"

# ------------------------------------------------- 5. สร้าง Storage bucket
say "สร้างที่เก็บไฟล์แนบ"
CODE=$(curl -s -o /tmp/fp-bucket.json -w '%{http_code}' \
  -X POST "${SUPA_URL%/}/storage/v1/bucket" \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$BUCKET\",\"id\":\"$BUCKET\",\"public\":true}")
case "$CODE" in
  200|201) ok "สร้าง bucket \"$BUCKET\" แบบ public แล้ว" ; BUCKET_OK=yes ;;
  409)     ok "bucket \"$BUCKET\" มีอยู่แล้ว" ; BUCKET_OK=yes ;;
  *)       warn "สร้าง bucket ไม่สำเร็จ (HTTP $CODE) — สร้างเองได้ที่ Supabase > Storage"
           head -c 200 /tmp/fp-bucket.json 2>/dev/null | sed 's/^/    /'; echo
           BUCKET_OK=no ;;
esac
rm -f /tmp/fp-bucket.json

# ------------------------------------------------------------- 6. deploy ใหม่
say "deploy ใหม่ให้ตัวแปรมีผล"
DEPLOY_OUT=$($VC deploy --prod --yes --scope "$SCOPE" 2>&1)
DEPLOY_URL=$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | tail -1)
[ -n "$DEPLOY_URL" ] || { printf '%s\n' "$DEPLOY_OUT" | tail -15; die "deploy ไม่สำเร็จ"; }
ok "deploy แล้ว"

# ------------------------------------------------------------------ 7. ตรวจ
say "ตรวจสอบระบบที่ใช้งานจริง"
sleep 6
declare -a RESULTS
check() {
  local path="$1" expect="$2" label="$3"
  local code
  code=$(curl -s -o /tmp/fp-check.json -w '%{http_code}' --max-time 25 "$PROD_URL$path")
  if [ "$code" = "$expect" ]; then ok "$label ($code)"; RESULTS+=("PASS  $label ($code)")
  else warn "$label ได้ $code (คาดว่า $expect)"; RESULTS+=("FAIL  $label ได้ $code คาดว่า $expect")
       head -c 200 /tmp/fp-check.json 2>/dev/null | sed 's/^/    /'; echo; fi
}
check /welcome          200 "หน้าแนะนำระบบ (SEO)"
check /                 200 "หน้าเข้าสู่ระบบ"
check /robots.txt       200 "robots.txt"
check /api/auth/session 200 "API เชื่อมฐานข้อมูล"

# ทดสอบเข้าสู่ระบบจริงโดยไม่เปิดเผยรหัสผ่านในผลลัพธ์
LOGIN_BODY=$(P="$OWNER_PW" node -e 'process.stdout.write(JSON.stringify({username:"owner",password:process.env.P}))')
LOGIN_CODE=$(printf '%s' "$LOGIN_BODY" | curl -s -o /tmp/fp-login.json -w '%{http_code}' --max-time 25 \
  -X POST "$PROD_URL/api/auth/login" -H 'Content-Type: application/json' --data-binary @-)
unset LOGIN_BODY
if [ "$LOGIN_CODE" = "200" ]; then ok "เข้าสู่ระบบด้วยบัญชี owner ($LOGIN_CODE)"; RESULTS+=("PASS  เข้าสู่ระบบด้วยบัญชี owner")
else warn "เข้าสู่ระบบไม่ผ่าน ($LOGIN_CODE)"; RESULTS+=("FAIL  เข้าสู่ระบบไม่ผ่าน ($LOGIN_CODE)"); fi
rm -f /tmp/fp-login.json /tmp/fp-check.json

# ------------------------------------------------------- 8. รายงานที่ส่งต่อได้
{
  echo "รายงานการติดตั้ง พันธมิตรเงินทุน"
  echo "สร้างเมื่อ: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo
  echo "[สภาพแวดล้อม]"
  echo "  Node.js        : $(node -v)"
  echo "  เว็บใช้งานจริง  : $PROD_URL"
  echo "  ฐานข้อมูล       : $(printf '%s' "$DB_URL" | mask_url)"
  echo "  Supabase URL   : $SUPA_URL"
  echo "  Storage bucket : $BUCKET (สร้างสำเร็จ: ${BUCKET_OK:-no})"
  echo "  ตารางที่สร้าง   : $TABLE_COUNT"
  echo
  echo "[ผลการตรวจสอบ]"
  for r in "${RESULTS[@]}"; do echo "  $r"; done
  echo
  echo "หมายเหตุ: ไฟล์นี้ไม่มีรหัสผ่านหรือคีย์ใด ๆ ส่งต่อให้ผู้อื่นดูได้"
} > "$REPORT"

printf '\n────────────────────────────────────────────────────────────\n'
cat "$REPORT"
printf '────────────────────────────────────────────────────────────\n\n'

FAILED=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)
if [ "$FAILED" = "0" ]; then
  printf '  \033[32mเสร็จสมบูรณ์\033[0m — เข้าใช้งานที่ %s\n' "$PROD_URL"
  printf '  เข้าสู่ระบบด้วย owner และรหัสผ่านที่คุณตั้งไว้\n\n'
else
  printf '  \033[33mมี %s รายการที่ไม่ผ่าน\033[0m — ส่งไฟล์ %s ให้ผู้ดูแลดูได้เลย\n\n' "$FAILED" "$REPORT"
fi
