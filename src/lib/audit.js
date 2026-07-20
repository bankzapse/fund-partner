import { run, all } from '../db/index.js';
import { nowISO } from './time.js';

/**
 * บันทึก Audit Log ทุกการสร้าง แก้ไข ยกเลิก และอนุมัติ (SRS ข้อ 15)
 * เก็บค่าเดิม ค่าใหม่ เหตุผล และผู้ทำรายการ
 */
export function audit({ userId, action, entity, entityId, before, after, reason, ip }) {
  run(
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

export function auditTrail({ entity, entityId, limit = 200 }) {
  if (entity && entityId) {
    return all(
      `SELECT a.*, u.full_name AS user_name FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity = :entity AND a.entity_id = :eid
       ORDER BY a.id DESC LIMIT :limit`,
      { entity, eid: String(entityId), limit },
    );
  }
  return all(
    `SELECT a.*, u.full_name AS user_name FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT :limit`,
    { limit },
  );
}
