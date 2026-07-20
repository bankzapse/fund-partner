import { Router } from 'express';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, tx, dbPath, getAllSettings, setSetting, DEFAULT_SETTINGS } from '../db/index.js';
import { hashPassword, publicUser } from '../lib/auth.js';
import { nowISO } from '../lib/time.js';
import { audit, auditTrail } from '../lib/audit.js';
import { ROLES, MATRIX } from '../lib/permissions.js';
import { BACKUP_DIR } from '../lib/paths.js';
import { voidPayment } from '../domain/payments.js';
import { reyod } from '../domain/contracts.js';
import { wrap, need, intParam } from './_helpers.js';

const router = Router();

// ---- ผู้ใช้งานและพนักงาน (ข้อ 12) -------------------------------------------

router.get(
  '/users',
  need('employees_manage'),
  wrap((_req, res) => {
    res.json({
      items: all(`SELECT * FROM users ORDER BY id`).map(publicUser),
      roles: ROLES,
      capabilities: Object.keys(MATRIX),
    });
  }),
);

router.post(
  '/users',
  need('employees_manage'),
  wrap((req, res) => {
    const b = req.body ?? {};
    if (!b.username?.trim()) return res.status(400).json({ error: 'ต้องระบุชื่อผู้ใช้' });
    if (!ROLES[b.role]) return res.status(400).json({ error: 'ตำแหน่งไม่ถูกต้อง' });
    if (get(`SELECT id FROM users WHERE username = :u`, { u: b.username.trim() })) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
    }
    const now = nowISO();
    const info = run(
      `INSERT INTO users (username, password_hash, full_name, role, extra_perms, is_active, created_at, updated_at)
       VALUES (:u, :h, :name, :role, :extra, :active, :now, :now)`,
      {
        u: b.username.trim(),
        h: hashPassword(b.password),
        name: b.full_name ?? b.username,
        role: b.role,
        extra: JSON.stringify(b.extra_perms ?? {}),
        active: b.is_active === false ? 0 : 1,
        now,
      },
    );
    const user = publicUser(get(`SELECT * FROM users WHERE id = :id`, { id: Number(info.lastInsertRowid) }));
    audit({ userId: req.ctx.user.id, action: 'create', entity: 'user', entityId: user.id, after: user, ip: req.ctx.ip });
    res.status(201).json({ user });
  }),
);

router.put(
  '/users/:id',
  need('employees_manage'),
  wrap((req, res) => {
    const id = intParam(req.params.id);
    const before = get(`SELECT * FROM users WHERE id = :id`, { id });
    if (!before) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    const b = req.body ?? {};
    if (before.role === 'owner' && b.is_active === false) {
      const owners = get(`SELECT COUNT(*) AS n FROM users WHERE role='owner' AND is_active=1`).n;
      if (owners <= 1) return res.status(400).json({ error: 'ต้องมีเจ้าของที่เปิดใช้งานอย่างน้อย 1 คน' });
    }
    run(
      `UPDATE users SET full_name = :name, role = :role, extra_perms = :extra,
                        is_active = :active, updated_at = :now
       WHERE id = :id`,
      {
        id,
        name: b.full_name ?? before.full_name,
        role: b.role ?? before.role,
        extra: JSON.stringify(b.extra_perms ?? JSON.parse(before.extra_perms || '{}')),
        active: b.is_active === undefined ? before.is_active : b.is_active ? 1 : 0,
        now: nowISO(),
      },
    );
    if (b.password) {
      run(`UPDATE users SET password_hash = :h WHERE id = :id`, { id, h: hashPassword(b.password) });
    }
    const after = publicUser(get(`SELECT * FROM users WHERE id = :id`, { id }));
    audit({
      userId: req.ctx.user.id,
      action: 'update',
      entity: 'user',
      entityId: id,
      before: publicUser(before),
      after,
      reason: b.reason,
      ip: req.ctx.ip,
    });
    res.json({ user: after });
  }),
);

router.get(
  '/employees',
  wrap((_req, res) => {
    res.json({
      items: all(
        `SELECT e.*, u.username, s.full_name AS supervisor_name
         FROM employees e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN employees s ON s.id = e.supervisor_id
         ORDER BY e.full_name`,
      ),
    });
  }),
);

router.post(
  '/employees',
  need('employees_manage'),
  wrap((req, res) => {
    const b = req.body ?? {};
    if (!b.full_name?.trim()) return res.status(400).json({ error: 'ต้องระบุชื่อพนักงาน' });
    const employee = tx(() => {
      const code = b.code?.trim() || `E${String(all(`SELECT id FROM employees`).length + 1).padStart(3, '0')}`;
      if (get(`SELECT id FROM employees WHERE code = :c`, { c: code })) {
        throw Object.assign(new Error('รหัสพนักงานนี้ถูกใช้แล้ว'), { status: 400 });
      }
      const now = nowISO();
      const info = run(
        `INSERT INTO employees (user_id, code, full_name, phone, area, supervisor_id, is_active, created_at, updated_at)
         VALUES (:uid, :code, :name, :phone, :area, :sup, 1, :now, :now)`,
        {
          uid: b.user_id ?? null,
          code,
          name: b.full_name.trim(),
          phone: b.phone ?? null,
          area: b.area ?? null,
          sup: b.supervisor_id ?? null,
          now,
        },
      );
      return get(`SELECT * FROM employees WHERE id = :id`, { id: Number(info.lastInsertRowid) });
    });
    audit({ userId: req.ctx.user.id, action: 'create', entity: 'employee', entityId: employee.id, after: employee, ip: req.ctx.ip });
    res.status(201).json({ employee });
  }),
);

router.put(
  '/employees/:id',
  need('employees_manage'),
  wrap((req, res) => {
    const id = intParam(req.params.id);
    const before = get(`SELECT * FROM employees WHERE id = :id`, { id });
    if (!before) return res.status(404).json({ error: 'ไม่พบพนักงาน' });
    const b = req.body ?? {};
    run(
      `UPDATE employees SET full_name = :name, phone = :phone, area = :area,
              user_id = :uid, supervisor_id = :sup, is_active = :active, updated_at = :now
       WHERE id = :id`,
      {
        id,
        name: b.full_name ?? before.full_name,
        phone: b.phone ?? before.phone,
        area: b.area ?? before.area,
        uid: b.user_id === undefined ? before.user_id : b.user_id,
        sup: b.supervisor_id === undefined ? before.supervisor_id : b.supervisor_id,
        active: b.is_active === undefined ? before.is_active : b.is_active ? 1 : 0,
        now: nowISO(),
      },
    );
    const after = get(`SELECT * FROM employees WHERE id = :id`, { id });
    audit({ userId: req.ctx.user.id, action: 'update', entity: 'employee', entityId: id, before, after, ip: req.ctx.ip });
    res.json({ employee: after });
  }),
);

// ---- ตั้งค่าระบบ (ข้อ 4 เมนูตั้งค่า) ----------------------------------------

router.get(
  '/settings',
  wrap((_req, res) => {
    res.json({ settings: getAllSettings(), defaults: DEFAULT_SETTINGS });
  }),
);

router.put(
  '/settings',
  need('settings_manage'),
  wrap((req, res) => {
    const before = getAllSettings();
    const patch = req.body?.settings ?? {};
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
      setSetting(key, value, req.ctx.user.id);
    }
    const after = getAllSettings();
    audit({ userId: req.ctx.user.id, action: 'update', entity: 'settings', entityId: 'settings', before, after, ip: req.ctx.ip });
    res.json({ settings: after });
  }),
);

// ---- คำขออนุมัติ (ข้อ 12: ผู้จัดการ "รออนุมัติ") -----------------------------

router.get(
  '/approvals',
  wrap((req, res) => {
    res.json({
      items: all(
        `SELECT a.*, r.full_name AS requested_by_name, d.full_name AS decided_by_name
         FROM approvals a
         LEFT JOIN users r ON r.id = a.requested_by
         LEFT JOIN users d ON d.id = a.decided_by
         ${req.query.status ? 'WHERE a.status = :status' : ''}
         ORDER BY a.id DESC LIMIT 100`,
        { status: req.query.status },
      ),
    });
  }),
);

router.post(
  '/approvals/:id/decide',
  need('approvals_decide'),
  wrap((req, res) => {
    const id = intParam(req.params.id);
    const approval = get(`SELECT * FROM approvals WHERE id = :id`, { id });
    if (!approval) return res.status(404).json({ error: 'ไม่พบคำขอ' });
    if (approval.status !== 'pending') return res.status(400).json({ error: 'คำขอนี้ถูกพิจารณาแล้ว' });

    const approve = req.body?.approve === true;
    let result = null;
    if (approve) {
      const payload = JSON.parse(approval.payload);
      if (approval.kind === 'void_payment') {
        result = voidPayment({ paymentId: payload.paymentId, reason: payload.reason }, req.ctx);
      } else if (approval.kind === 'reyod') {
        result = reyod(payload, req.ctx);
      }
    }
    run(
      `UPDATE approvals SET status = :s, decided_by = :uid, decided_at = :now, decision_note = :note
       WHERE id = :id`,
      {
        id,
        s: approve ? 'approved' : 'rejected',
        uid: req.ctx.user.id,
        now: nowISO(),
        note: req.body?.note ?? null,
      },
    );
    const after = get(`SELECT * FROM approvals WHERE id = :id`, { id });
    audit({
      userId: req.ctx.user.id,
      action: approve ? 'approve' : 'reject',
      entity: 'approval',
      entityId: id,
      before: approval,
      after,
      reason: req.body?.note,
      ip: req.ctx.ip,
    });
    res.json({ approval: after, result });
  }),
);

// ---- Audit Log (ข้อ 15) -----------------------------------------------------

router.get(
  '/audit',
  need('audit_view'),
  wrap((req, res) => {
    res.json({
      items: auditTrail({
        entity: req.query.entity,
        entityId: req.query.entity_id,
        limit: intParam(req.query.limit, 200),
      }),
    });
  }),
);

// ---- สำรองข้อมูล (ข้อ 15/17) ------------------------------------------------

router.post(
  '/backup',
  need('settings_manage'),
  wrap((req, res) => {
    if (dbPath() === ':memory:') return res.status(400).json({ error: 'ฐานข้อมูลในหน่วยความจำสำรองไม่ได้' });
    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = nowISO().replaceAll(/[^0-9]/g, '').slice(0, 14);
    const name = `fund-partner-${stamp}.sqlite`;
    copyFileSync(dbPath(), join(BACKUP_DIR, name));
    audit({ userId: req.ctx.user.id, action: 'backup', entity: 'database', entityId: name, ip: req.ctx.ip });
    res.status(201).json({ file: name });
  }),
);

router.get(
  '/backups',
  need('settings_manage'),
  wrap((_req, res) => {
    mkdirSync(BACKUP_DIR, { recursive: true });
    res.json({ items: readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite')).sort().reverse() });
  }),
);

export default router;
