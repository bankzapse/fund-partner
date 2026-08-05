import { run, all } from '../db/index.js';
import { nowISO } from './time.js';

/**
 * บันทึก Audit Log ทุกการสร้าง แก้ไข ยกเลิก และอนุมัติ (SRS ข้อ 15)
 * เก็บค่าเดิม ค่าใหม่ เหตุผล และผู้ทำรายการ
 */
export async function audit({ userId, action, entity, entityId, before, after, reason, ip }) {
  await run(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, before_json, after_json, reason, ip, created_at)
     VALUES (:uid, :action, :entity, :eid, :before, :after, :reason, :ip, :now)`,
    {
      uid: userId ?? null,
      action,
      entity,
      eid: entityId === undefined || entityId === null ? null : String(entityId),
      before: before === undefined ? null : JSON.stringify(before),
      after: after === undefined ? null : JSON.stringify(after),
      reason: reason ?? null,
      ip: ip ?? null,
      now: nowISO(),
    },
  );
}

/**
 * บันทึกการ "เปิดดู" ข้อมูลส่วนบุคคล (PDPA) — ใครเปิดดูข้อมูล/สำเนาบัตรของใคร เมื่อไหร่
 * ใช้ action='view' ในตารางเดียวกับ audit ปกติ แต่แยกออกจากประวัติการแก้ไข
 * (auditTrail ตัด view ออก เพื่อไม่ให้ประวัติการเปลี่ยนแปลงรก)
 *
 * ตั้งใจให้ล้มเงียบได้ — การบันทึกการเข้าถึงต้องไม่ทำให้การเปิดดูข้อมูลพัง
 */
export async function logAccess({ userId, entity, entityId, detail, ip }) {
  try {
    await run(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, after_json, ip, created_at)
       VALUES (:uid, 'view', :entity, :eid, :after, :ip, :now)`,
      {
        uid: userId ?? null,
        entity,
        eid: entityId === undefined || entityId === null ? null : String(entityId),
        after: detail === undefined ? null : JSON.stringify(detail),
        ip: ip ?? null,
        now: nowISO(),
      },
    );
  } catch (err) {
    console.error('logAccess:', err.message);
  }
}

export async function auditTrail({ entity, entityId, limit = 200 }) {
  // ตัด action='view' ออกจากประวัติการเปลี่ยนแปลง — ดูการเข้าถึงได้ที่ accessTrail
  if (entity && entityId) {
    return await all(
      `SELECT a.*, u.full_name AS user_name FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity = :entity AND a.entity_id = :eid AND a.action <> 'view'
       ORDER BY a.id DESC LIMIT :limit`,
      { entity, eid: String(entityId), limit },
    );
  }
  return await all(
    `SELECT a.*, u.full_name AS user_name FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.action <> 'view'
     ORDER BY a.id DESC LIMIT :limit`,
    { limit },
  );
}

/**
 * ประวัติการเข้าถึงข้อมูลส่วนบุคคล (เจ้าของกิจการดูเพื่อตอบเรื่อง PDPA)
 * กรองตามลูกหนี้ได้ หรือดูทั้งหมดในช่วงเวลาที่กำหนด
 */
export async function accessTrail({ entity, entityId, from, to, limit = 500 }) {
  const where = ["a.action = 'view'"];
  const params = { limit };
  if (entity) { where.push('a.entity = :entity'); params.entity = entity; }
  if (entityId !== undefined && entityId !== null) {
    where.push('a.entity_id = :eid'); params.eid = String(entityId);
  }
  if (from) { where.push('a.created_at >= :from'); params.from = from; }
  if (to) { where.push('a.created_at <= :to'); params.to = to; }
  return await all(
    `SELECT a.id, a.user_id, a.entity, a.entity_id, a.after_json, a.ip, a.created_at,
            u.full_name AS user_name
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.id DESC LIMIT :limit`,
    params,
  );
}
