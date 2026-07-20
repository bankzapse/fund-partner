// จำกัดจำนวนครั้งที่เข้าสู่ระบบผิด — ป้องกันการเดารหัสผ่าน (ข้อ 15 ความปลอดภัย)
//
// หลักการที่เลือกใช้ และเหตุผล:
//
// 1) นับ 3 ชั้นพร้อมกัน (รายละเอียดและเหตุผลของแต่ละชั้นอยู่ที่ POLICY ด้านล่าง)
//    ชื่อผู้ใช้+IP → ชื่อผู้ใช้ → IP  เข้มมากไปหาหลวม
//    ต้องมีหลายชั้นเพราะผู้โจมตีเลี่ยงชั้นเดียวได้ง่าย ๆ ด้วยการสลับ IP หรือสลับชื่อผู้ใช้
//
// 2) นับผู้ใช้ที่ "ไม่มีอยู่จริง" ด้วย และตอบข้อความเดียวกันเสมอ
//    ถ้าล็อกเฉพาะชื่อที่มีจริง ผู้โจมตีจะเดาได้ว่าชื่อไหนมีอยู่ในระบบ
//
// 3) เก็บตัวนับในฐานข้อมูล ไม่ใช่ในหน่วยความจำ
//    บน Vercel แต่ละ request อาจทำงานคนละ instance ตัวนับในหน่วยความจำ
//    จึงนับไม่ครบและถูกข้ามได้ง่าย ๆ ด้วยการยิงถี่ ๆ
//
// 4) ล็อกนานขึ้นเรื่อย ๆ เมื่อโดนซ้ำ (5 → 15 → 60 นาที)
//    ครั้งแรกสั้นพอที่คนจำรหัสไม่ได้จะไม่เดือดร้อน แต่ผู้โจมตีที่ยิงต่อเนื่อง
//    จะถูกถ่วงจนไม่คุ้มที่จะเดาต่อ

import { get, run, all } from '../db/index.js';
import { nowISO } from './time.js';

export const POLICY = {
  // ด่านหลัก: นับแยกตาม "ชื่อผู้ใช้ + IP"
  //
  // ที่ไม่นับตามชื่อผู้ใช้อย่างเดียว เพราะจะกลายเป็นช่องให้กลั่นแกล้ง —
  // ใครก็ตามที่รู้ชื่อผู้ใช้ของเจ้าของกิจการ ยิงรหัสผิด 5 ครั้งทุก ๆ 5 นาที
  // ก็ล็อกเจ้าของไม่ให้เข้าระบบตัวเองได้ตลอดไป ทั้งที่ไม่รู้รหัสผ่านเลย
  // ธุรกิจนี้ต้องเก็บเงินทุกวัน เข้าระบบไม่ได้แม้ครึ่งวันก็เสียหายจริง
  //
  // พอนับรวม IP ด้วย ผู้โจมตีจะล็อกได้แค่ตัวเอง เจ้าของที่นั่งอยู่คนละที่ยังเข้าได้ปกติ
  user_ip: {
    limit: 5,
    windowMinutes: 15,
    lockMinutes: [5, 15, 60], // โดนซ้ำแล้วนานขึ้นเรื่อย ๆ
  },
  // ด่านสำรอง: นับตามชื่อผู้ใช้ล้วน เผื่อผู้โจมตีสลับ IP ไปเรื่อย ๆ เพื่อเลี่ยงด่านแรก
  // ตั้งไว้สูงกว่ามาก เพราะด่านนี้แลกมาด้วยความเสี่ยงเรื่องการกลั่นแกล้งข้างต้น
  user: {
    limit: 20,
    windowMinutes: 15,
    lockMinutes: [15, 30, 60],
  },
  // ด่านกันยิงถล่ม: นับตาม IP ล้วน เผื่อผู้โจมตีสลับ "ชื่อผู้ใช้" ไปเรื่อย ๆ แทน
  // ตั้งหลวมสุด เพราะพนักงานทั้งทีมอาจออกเน็ตจาก IP เดียวกัน
  ip: {
    limit: 30,
    windowMinutes: 15,
    lockMinutes: [15, 30, 60],
  },
};

/** แปลงข้อมูลการเข้าสู่ระบบหนึ่งครั้ง เป็นรายการ "ตัวนับ" ที่ต้องตรวจ/บวกทั้งหมด */
function layersFor({ username, ip }) {
  const u = normalizeKey('user', username);
  const i = normalizeKey('ip', ip);
  const layers = [];
  if (u && i) layers.push(['user_ip', `${u}|${i}`]);
  if (u) layers.push(['user', u]);
  if (i) layers.push(['ip', i]);
  return layers;
}

const ms = (minutes) => minutes * 60_000;

function normalizeKey(scope, value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  // ชื่อผู้ใช้ไม่แยกตัวพิมพ์เล็กใหญ่ กัน "Owner" กับ "owner" นับแยกกัน
  return scope === 'user' ? v.toLowerCase().slice(0, 120) : v.slice(0, 160);
}

async function readState(scope, key, now) {
  const row = await get(
    `SELECT * FROM login_attempts WHERE scope = :s AND key = :k`,
    { s: scope, k: key },
  );
  if (!row) return { failed: 0, lockedUntil: null, lockCount: 0, windowStart: now };
  const policy = POLICY[scope];
  const windowStart = new Date(row.window_start).getTime();
  const expired = now - windowStart > ms(policy.windowMinutes);
  const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : null;
  const stillLocked = lockedUntil && lockedUntil > now;
  return {
    // หน้าต่างเวลาหมดแล้วให้เริ่มนับใหม่ แต่ยัง "จำ" ว่าเคยถูกล็อกมากี่รอบ
    // เพื่อไม่ให้ผู้โจมตีรีเซ็ตความเข้มด้วยการรอเฉย ๆ ระหว่างรอบ
    failed: expired && !stillLocked ? 0 : row.failed_count,
    lockedUntil: stillLocked ? lockedUntil : null,
    lockCount: row.lock_count,
    windowStart: expired && !stillLocked ? now : windowStart,
  };
}

/**
 * ตรวจก่อนเช็ครหัสผ่าน — ถ้าถูกล็อกอยู่ให้โยน error 429 ทันที
 * ต้องเรียก "ก่อน" การตรวจรหัสผ่าน เพื่อไม่ให้ผู้โจมตีได้ลองรหัสเพิ่มระหว่างถูกล็อก
 */
export async function assertNotLocked({ username, ip }) {
  const now = Date.now();
  for (const [scope, key] of layersFor({ username, ip })) {
    const state = await readState(scope, key, now);
    if (state.lockedUntil) {
      const minutes = Math.max(1, Math.ceil((state.lockedUntil - now) / 60_000));
      throw Object.assign(
        new Error(
          `เข้าสู่ระบบผิดหลายครั้งเกินไป ระบบล็อกไว้ชั่วคราวเพื่อความปลอดภัย ` +
          `กรุณารออีก ${minutes} นาที หรือติดต่อเจ้าของกิจการให้ปลดล็อกให้`,
        ),
        { status: 429, retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000) },
      );
    }
  }
}

/** บันทึกว่าเข้าสู่ระบบผิด และล็อกถ้าครบจำนวน */
export async function recordFailure({ username, ip }) {
  const now = Date.now();
  const iso = nowISO();
  const locked = [];

  for (const [scope, key] of layersFor({ username, ip })) {
    const policy = POLICY[scope];
    const state = await readState(scope, key, now);
    const failed = state.failed + 1;

    let lockedUntil = null;
    let lockCount = state.lockCount;
    let nextFailed = failed;
    if (failed >= policy.limit) {
      // เลือกระยะเวลาล็อกตามจำนวนครั้งที่เคยโดน ครั้งหลัง ๆ ใช้ค่าสูงสุด
      const step = policy.lockMinutes[Math.min(lockCount, policy.lockMinutes.length - 1)];
      lockedUntil = new Date(now + ms(step)).toISOString();
      lockCount += 1;
      nextFailed = 0; // เริ่มนับใหม่หลังปลดล็อก
      locked.push({ scope, key, minutes: step });
    }

    await run(
      `INSERT INTO login_attempts (scope, key, failed_count, window_start, locked_until, lock_count, updated_at)
       VALUES (:s, :k, :f, :ws, :lu, :lc, :now)
       ON CONFLICT (scope, key) DO UPDATE SET
         failed_count = :f, window_start = :ws, locked_until = :lu, lock_count = :lc, updated_at = :now`,
      {
        s: scope,
        k: key,
        f: nextFailed,
        ws: new Date(state.windowStart).toISOString(),
        lu: lockedUntil,
        lc: lockCount,
        now: iso,
      },
    );
  }
  return locked;
}

/** เข้าสู่ระบบสำเร็จ — ล้างตัวนับทิ้ง */
export async function clearFailures({ username, ip }) {
  for (const [scope, key] of layersFor({ username, ip })) {
    await run(`DELETE FROM login_attempts WHERE scope = :s AND key = :k`, { s: scope, k: key });
  }
}

/** เจ้าของกิจการปลดล็อกให้พนักงานที่ลืมรหัสผ่านและถูกล็อกไว้ */
export async function unlockUser(username) {
  const key = normalizeKey('user', username);
  if (!key) return false;
  const row = await get(
    `SELECT key FROM login_attempts
     WHERE (scope = 'user' AND key = :k) OR (scope = 'user_ip' AND key LIKE :prefix)`,
    { k: key, prefix: `${key}|%` },
  );
  await run(
    `DELETE FROM login_attempts
     WHERE (scope = 'user' AND key = :k) OR (scope = 'user_ip' AND key LIKE :prefix)`,
    { k: key, prefix: `${key}|%` },
  );
  return Boolean(row);
}

/** รายชื่อที่กำลังถูกล็อกอยู่ ให้เจ้าของกิจการเห็นในหน้าผู้ใช้งาน */
export async function lockedAccounts() {
  // ชั้น user_ip เก็บคีย์เป็น "ชื่อผู้ใช้|IP" จึงตัดเอาเฉพาะชื่อผู้ใช้มาแสดง
  // และยุบให้เหลือบรรทัดเดียวต่อคน โดยใช้เวลาปลดล็อกที่ไกลที่สุด
  return await all(
    `SELECT split_part(key, '|', 1) AS username,
            max(locked_until) AS locked_until,
            max(lock_count)   AS lock_count
     FROM login_attempts
     WHERE scope IN ('user', 'user_ip')
       AND locked_until IS NOT NULL AND locked_until > :now
     GROUP BY split_part(key, '|', 1)
     ORDER BY 2 DESC`,
    { now: nowISO() },
  );
}

/** ล้างแถวเก่าที่ไม่ใช้แล้ว เรียกพร้อมกับการล้าง session */
export async function purgeLoginAttempts() {
  const cutoff = new Date(Date.now() - ms(24 * 60)).toISOString();
  await run(
    `DELETE FROM login_attempts
     WHERE updated_at < :cutoff AND (locked_until IS NULL OR locked_until < :now)`,
    { cutoff, now: nowISO() },
  );
}
