#!/usr/bin/env bash
#
# ตั้งรหัสผ่านผู้ใช้ใหม่ กรณีลืมรหัสจนเข้าระบบไม่ได้
#
#   bash scripts/reset-password.sh
#
# ทำงานกับฐานข้อมูลโดยตรง จึงใช้ได้แม้ล็อกอินไม่ได้แล้ว
# ไม่แตะข้อมูลอื่นเลย และบันทึกลง Audit Log ว่ามีการตั้งรหัสใหม่นอกระบบ
#
set -uo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
say()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

trap 'stty echo 2>/dev/null || true' EXIT

[ -d node_modules ] || die "ยังไม่ได้ติดตั้ง dependency — รัน: npm install"

say "ตั้งรหัสผ่านผู้ใช้ใหม่"
echo "  ใช้เมื่อลืมรหัสจนเข้าระบบไม่ได้ ทำงานกับฐานข้อมูลโดยตรง"

# ใช้ค่าจากตัวแปรสภาพแวดล้อมถ้ามี ไม่งั้นถามใหม่
if [ -n "${DATABASE_URL:-}" ]; then
  ok "ใช้ DATABASE_URL จากตัวแปรสภาพแวดล้อม"
  DB_URL="$DATABASE_URL"
else
  printf '\n  Connection string ของ Supabase (จะไม่ขึ้นบนจอ)\n'
  printf '  เว้นว่างแล้วกด Enter ถ้าต้องการแก้ฐานข้อมูลในเครื่อง: '
  read -rs DB_URL; echo
  if [ -z "$DB_URL" ]; then
    ok "ใช้ฐานข้อมูลในเครื่อง (PGlite)"
  fi
fi

printf '  ชื่อผู้ใช้ที่จะตั้งรหัสใหม่ [owner]: '
read -r USERNAME; USERNAME="${USERNAME:-owner}"

printf '  รหัสผ่านใหม่ (อย่างน้อย 8 ตัว): '
read -rs PW1; echo
printf '  พิมพ์ซ้ำอีกครั้ง: '
read -rs PW2; echo
[ ${#PW1} -ge 8 ] || die "รหัสผ่านสั้นเกินไป"
[ "$PW1" = "$PW2" ] || die "รหัสผ่านสองครั้งไม่ตรงกัน"

say "ดำเนินการ"
run_node() {
  if [ -n "$DB_URL" ]; then DATABASE_URL="$DB_URL" FP_USERNAME="$USERNAME" FP_NEWPW="$PW1" node -e "$1"
  else FP_USERNAME="$USERNAME" FP_NEWPW="$PW1" node -e "$1"; fi
}
run_node '
import("./src/db/index.js").then(async ({ get, run, closeDb }) => {
  const { hashPassword } = await import("./src/lib/auth.js");
  const { audit } = await import("./src/lib/audit.js");
  const { nowISO } = await import("./src/lib/time.js");

  const username = process.env.FP_USERNAME;
  const user = await get(`SELECT id, username, role, is_active FROM users WHERE username = :u`, { u: username });
  if (!user) {
    const all = await (await import("./src/db/index.js")).all(`SELECT username, role FROM users ORDER BY id`);
    console.error(`  ไม่พบผู้ใช้ "${username}"`);
    console.error("  ผู้ใช้ที่มีในระบบ: " + (all.map((u) => `${u.username} (${u.role})`).join(", ") || "(ไม่มีเลย)"));
    process.exit(1);
  }

  await run(`UPDATE users SET password_hash = :h, updated_at = :now WHERE id = :id`, {
    id: user.id, h: hashPassword(process.env.FP_NEWPW), now: nowISO(),
  });

  // ถ้าบัญชีถูกปิดไว้ ให้เปิดกลับ ไม่งั้นตั้งรหัสใหม่ก็ยังเข้าไม่ได้
  if (!user.is_active) {
    await run(`UPDATE users SET is_active = 1 WHERE id = :id`, { id: user.id });
    console.log("  บัญชีถูกปิดอยู่ — เปิดใช้งานกลับให้แล้ว");
  }

  // ยกเลิก session เดิมทั้งหมดของผู้ใช้รายนี้ กันคนที่ยังค้างอยู่ใช้ต่อ
  const s = await run(`DELETE FROM sessions WHERE user_id = :id`, { id: user.id });
  if (s.rowCount > 0) console.log(`  ยกเลิก session เดิม ${s.rowCount} รายการ`);

  await audit({
    userId: user.id,
    action: "update",
    entity: "user",
    entityId: user.id,
    after: { password_reset_via_script: true },
    reason: "ตั้งรหัสผ่านใหม่ผ่านสคริปต์ (กรณีลืมรหัส)",
  });

  console.log(`  ตั้งรหัสผ่านใหม่ให้ ${user.username} (${user.role}) เรียบร้อย`);
  await closeDb();
}).catch((e) => { console.error("  ผิดพลาด: " + e.message); process.exit(1); });
' 2>&1 | grep -viE "experimental|trace-warnings" | sed 's/^/  /'

STATUS=${PIPESTATUS[0]}
unset PW1 PW2
[ "$STATUS" = "0" ] || die "ตั้งรหัสผ่านไม่สำเร็จ"

ok "เรียบร้อย"
cat <<MSG

  เข้าสู่ระบบได้ที่ https://fund-partner.vercel.app
  ชื่อผู้ใช้: $USERNAME

  หมายเหตุ: session เดิมทั้งหมดถูกยกเลิกแล้ว อุปกรณ์อื่นต้องเข้าสู่ระบบใหม่

MSG
