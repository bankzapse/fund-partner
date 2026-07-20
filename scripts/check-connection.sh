#!/usr/bin/env bash
#
# ตรวจว่า connection string ของ Supabase ใช้ได้หรือไม่ และบอกสาเหตุที่ชัดเจน
#
#   bash scripts/check-connection.sh
#
# ถ้าโฮสต์เป็น shared pooler จะลองทั้ง aws-0 และ aws-1 ให้อัตโนมัติ
# ไม่แสดงรหัสผ่านบนจอ และไม่แก้ไขอะไรทั้งสิ้น (อ่านอย่างเดียว)
#
set -uo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info() { printf '  \033[33m·\033[0m %s\n' "$*"; }

trap 'stty echo 2>/dev/null || true' EXIT

printf '\n\033[1;34m▸ ตรวจ connection string ของ Supabase\033[0m\n\n'
printf '  วาง connection string (จะไม่ขึ้นบนจอ): '
read -rs DB_URL; echo; echo

[ -n "$DB_URL" ] || { bad "ไม่ได้ใส่อะไรมา"; exit 1; }

# แสดงรายละเอียดโดยปิดบังรหัสผ่าน เพื่อให้เห็นว่าพิมพ์ถูกส่วนไหนผิดส่วนไหน
node -e '
const raw = process.argv[1];
let u;
try { u = new URL(raw); } catch { console.log("  ✗ อ่าน URL ไม่ออกเลย — รหัสผ่านอาจมีอักขระพิเศษที่ยังไม่ได้แปลง"); process.exit(1); }
const kind = /pooler\.supabase\.com$/.test(u.hostname) ? "Shared pooler (IPv4) ✓"
           : /^db\..*\.supabase\.co$/.test(u.hostname) ? "Dedicated pooler (IPv6) — Vercel ต่อไม่ได้"
           : "ไม่รู้จักรูปแบบนี้";
console.log("  โฮสต์      : " + u.hostname);
console.log("  พอร์ต      : " + (u.port || "(ไม่ระบุ)") + (u.port === "6543" ? "  ← transaction pooler ✓" : "  ← ควรเป็น 6543"));
console.log("  ผู้ใช้      : " + decodeURIComponent(u.username));
console.log("  ฐานข้อมูล  : " + u.pathname.replace(/^\//, ""));
console.log("  รหัสผ่าน   : " + (u.password ? u.password.length + " ตัวอักษร" : "(ว่าง!)"));
console.log("  ชนิด       : " + kind);
' "$DB_URL"
echo

# ทดสอบเชื่อมต่อจริง คืนข้อความ error ตรง ๆ
try_url() {
  DATABASE_URL="$1" node -e '
    import("pg").then(async ({ default: pg }) => {
      const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
      });
      const r = await pool.query("SELECT current_database() db");
      console.log("OK:" + r.rows[0].db);
      await pool.end();
    }).catch((e) => { console.log("ERR:" + e.message); process.exit(1); });
  ' 2>/dev/null
}

explain() {
  case "$1" in
    *"SASL"*|*"password authentication"*)
      info "รหัสผ่านไม่ถูกต้อง — กด Reset password ที่ Settings > Database แล้วเอารหัสใหม่มาใส่"
      info "ถ้ารหัสมีอักขระพิเศษ ต้องแปลงก่อน:"
      info "    node -e \"console.log(encodeURIComponent(process.argv[1]))\" 'รหัสผ่าน'" ;;
    *"tenant/user"*|*"Tenant or user not found"*)
      info "โปรเจกต์ไม่ได้อยู่บนโฮสต์นี้ หรือชื่อผู้ใช้ผิด (ต้องเป็น postgres.<project-ref>)" ;;
    *ENOTFOUND*)
      info "ชื่อโฮสต์ไม่มีอยู่จริง — ตรวจการสะกด หรือลองสลับ aws-0 กับ aws-1" ;;
    *ETIMEDOUT*|*timeout*)
      info "ต่อไม่ถึงเซิร์ฟเวอร์ — อาจเป็นเรื่องเครือข่ายหรือไฟร์วอลล์" ;;
    *ECONNREFUSED*)
      info "เซิร์ฟเวอร์ปฏิเสธการเชื่อมต่อ — ตรวจพอร์ตว่าเป็น 6543" ;;
    *"does not exist"*)
      info "ไม่พบฐานข้อมูลชื่อนี้ — ปกติต้องเป็น postgres" ;;
  esac
}

printf '\033[1;34m▸ ทดสอบเชื่อมต่อ\033[0m\n'
RES=$(try_url "$DB_URL")
if [[ "$RES" == OK:* ]]; then
  ok "ต่อได้ — ฐานข้อมูล: ${RES#OK:}"
  echo
  printf '  \033[32mใช้สตริงนี้ได้เลย\033[0m — รันต่อ: bash scripts/connect-supabase.sh\n\n'
  exit 0
fi

bad "ต่อไม่ได้: ${RES#ERR:}"
explain "$RES"

# ถ้าเป็น shared pooler ลองสลับ aws-0 <-> aws-1 ให้อัตโนมัติ
HOST=$(node -e 'try{console.log(new URL(process.argv[1]).hostname)}catch{}' "$DB_URL")
ALT=""
case "$HOST" in
  aws-0-*) ALT="${HOST/aws-0-/aws-1-}" ;;
  aws-1-*) ALT="${HOST/aws-1-/aws-0-}" ;;
esac

if [ -n "$ALT" ]; then
  echo
  printf '\033[1;34m▸ ลองโฮสต์สำรอง: %s\033[0m\n' "$ALT"
  ALT_URL="${DB_URL//$HOST/$ALT}"
  RES2=$(try_url "$ALT_URL")
  if [[ "$RES2" == OK:* ]]; then
    ok "โฮสต์นี้ใช้ได้! — ฐานข้อมูล: ${RES2#OK:}"
    echo
    printf '  แก้สตริงโดยเปลี่ยน \033[1m%s\033[0m เป็น \033[1m%s\033[0m แล้วรัน connect-supabase.sh\n\n' "$HOST" "$ALT"
    exit 0
  fi
  bad "โฮสต์สำรองก็ไม่ได้: ${RES2#ERR:}"
  explain "$RES2"
fi

echo
printf '  ยังไม่ผ่าน — ส่งข้อความ error ด้านบนมาได้เลย (ไม่มีรหัสผ่านปนอยู่)\n\n'
exit 1
