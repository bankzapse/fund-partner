import { Router } from 'express';
import { all, get, run, insert, tx, nextCounter } from '../db/index.js';
import { nowISO } from '../lib/time.js';
import { audit, auditTrail, logAccess } from '../lib/audit.js';
import { contractSummary, contractBehaviour } from '../domain/contracts.js';
import { listPayments } from '../domain/payments.js';
import {
  wrap,
  need,
  scopeEmployeeId,
  assertDebtorAccess,
  saveDataUrl,
  intParam,
  sendCsv,
} from './_helpers.js';
import { toServePath } from '../lib/storage.js';

const router = Router();

/**
 * ออกรหัสลูกหนี้อัตโนมัติ รันแยกตามโซนของพนักงานผู้ดูแล (สเปกข้อ 2-3)
 *
 * โซน A (รหัสพนักงาน 'A') → A.1, A.2, ... โซน B → B.1, B.2, ...
 * เพิ่มพนักงานใหม่ในอนาคตได้เรื่อย ๆ (C.1, D.1, ...) ตามรหัสพนักงาน
 * ลูกหนี้ที่ไม่ผูกพนักงานใช้รหัสกลางแบบเดิม (D00001)
 *
 * ข้ามเลขที่ถูกใช้ไปแล้วเสมอ (ผู้ใช้กรอกรหัสเองได้ ตัวนับจึงอาจตามหลังความจริง)
 * รหัสเก่าไม่ถูกนำกลับมาใช้กับลูกค้าใหม่ เพราะแถวลูกหนี้เดิมไม่ถูกลบ (unique ค้ำไว้)
 */
async function nextFreeDebtorCode(employeeId = null) {
  const emp = employeeId
    ? await get(`SELECT code FROM employees WHERE id = :id`, { id: employeeId })
    : null;
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = emp
      ? `${emp.code}.${await nextCounter(`debtor:${emp.code}`)}`
      : `D${String(await nextCounter('debtor')).padStart(5, '0')}`;
    if (!(await get(`SELECT id FROM debtors WHERE code = :c`, { c: code }))) return code;
  }
  throw Object.assign(new Error('ออกรหัสลูกหนี้อัตโนมัติไม่สำเร็จ กรุณาระบุรหัสเอง'), { status: 500 });
}

/** ค้นหาลูกหนี้จากชื่อ เบอร์โทร รหัสลูกหนี้ และเลขที่สัญญา (SRS ข้อ 6) */
router.get(
  '/',
  need('debtors_view'),
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const status = req.query.status ? String(req.query.status) : null;
    const scope = await scopeEmployeeId(req.ctx.user);
    const params = { like: `%${q}%`, status, emp: scope, limit: intParam(req.query.limit, 100) };

    const rows = await all(
      `SELECT d.*, e.full_name AS employee_name,
         (SELECT COUNT(*) FROM contracts c WHERE c.debtor_id = d.id) AS contract_count,
         (SELECT COUNT(*) FROM contracts c WHERE c.debtor_id = d.id AND c.status = 'active') AS active_contracts,
         (SELECT COALESCE(SUM(c.principal_remaining), 0) FROM contracts c
            WHERE c.debtor_id = d.id AND c.status = 'active') AS principal_outstanding
       FROM debtors d
       LEFT JOIN employees e ON e.id = d.employee_id
       WHERE 1=1
         ${q ? `AND (d.full_name LIKE :like OR d.phone LIKE :like OR d.code LIKE :like
                 OR EXISTS (SELECT 1 FROM contracts c WHERE c.debtor_id = d.id AND c.contract_no LIKE :like))` : ''}
         ${status ? 'AND d.status = :status' : ''}
         ${scope !== null ? 'AND d.employee_id = :emp' : ''}
       ORDER BY d.full_name
       LIMIT :limit`,
      params,
    );
    res.json({ items: rows });
  }),
);

router.get(
  '/export',
  need('debtors_view'),
  wrap(async (req, res) => {
    const scope = await scopeEmployeeId(req.ctx.user);
    const rows = await all(
      `SELECT d.code, d.full_name, d.phone, d.address, d.status, e.full_name AS employee_name,
              (SELECT COALESCE(SUM(c.principal_remaining),0) FROM contracts c
                 WHERE c.debtor_id = d.id AND c.status='active') AS principal_outstanding
       FROM debtors d LEFT JOIN employees e ON e.id = d.employee_id
       ${scope !== null ? 'WHERE d.employee_id = :emp' : ''}
       ORDER BY d.code`,
      { emp: scope },
    );
    // PDPA: การส่งออกเป็นการเข้าถึงข้อมูลส่วนบุคคลจำนวนมากในครั้งเดียว ต้องบันทึกไว้
    await logAccess({
      userId: req.ctx.user.id,
      entity: 'debtor_export',
      entityId: null,
      detail: { count: rows.length, scope: scope === null ? 'ทั้งหมด' : `พนักงาน ${scope}` },
      ip: req.ctx.ip,
    });
    sendCsv(res, 'debtors.csv', rows, [
      { label: 'รหัสลูกหนี้', key: 'code' },
      { label: 'ชื่อ-นามสกุล', key: 'full_name' },
      { label: 'เบอร์โทร', key: 'phone' },
      { label: 'ที่อยู่', key: 'address' },
      { label: 'สถานะ', key: 'status' },
      { label: 'พนักงานผู้ดูแล', key: 'employee_name' },
      { label: 'เงินต้นคงเหลือ (บาท)', value: (r) => (r.principal_outstanding / 100).toFixed(2) },
    ]);
  }),
);

/** ประวัติรวมของลูกหนี้ในหน้าเดียว (ข้อ 6) */
router.get(
  '/:id',
  need('debtors_view'),
  wrap(async (req, res) => {
    const id = intParam(req.params.id);
    await assertDebtorAccess(req.ctx.user, id);
    const debtor = await get(
      `SELECT d.*, e.full_name AS employee_name FROM debtors d
       LEFT JOIN employees e ON e.id = d.employee_id WHERE d.id = :id`,
      { id },
    );
    if (!debtor) return res.status(404).json({ error: 'ไม่พบลูกหนี้' });

    // PDPA: บันทึกว่าใครเปิดดูข้อมูลส่วนบุคคลของลูกหนี้คนนี้
    await logAccess({
      userId: req.ctx.user.id,
      entity: 'debtor',
      entityId: id,
      detail: { code: debtor.code, name: debtor.full_name },
      ip: req.ctx.ip,
    });

    const contractRows = await all(
      `SELECT * FROM contracts WHERE debtor_id = :id ORDER BY id DESC`,
      { id },
    );
    // ยิงสรุป/พฤติกรรมของแต่ละสัญญาแบบขนาน แทนการวนทีละสัญญาแบบเรียงต่อกัน
    // (ทั้งสองฟังก์ชันเป็น read-only) — ลดเวลาหน้าประวัติลูกหนี้ที่มีสัญญาหลายก้อน
    // จากเดิม ~4×จำนวนสัญญา round-trip ที่รอกันไปเรื่อย ๆ
    const [contracts, payments, documents, audit] = await Promise.all([
      Promise.all(
        contractRows.map(async (c) => {
          const [summary, behaviour] = await Promise.all([
            contractSummary(c.id),
            contractBehaviour(c.id),
          ]);
          return { ...c, summary, behaviour };
        }),
      ),
      listPayments({ debtorId: id, includeVoid: true, limit: 300 }),
      all(`SELECT * FROM debtor_documents WHERE debtor_id = :id ORDER BY id DESC`, { id }),
      auditTrail({ entity: 'debtor', entityId: id, limit: 50 }),
    ]);

    res.json({
      debtor,
      contracts,
      payments,
      documents: documents.map((d) => ({ ...d, file_path: toServePath(d.file_path) })),
      audit,
    });
  }),
);

router.post(
  '/',
  need('debtors_edit'),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    if (!b.full_name?.trim()) return res.status(400).json({ error: 'ต้องระบุชื่อ-นามสกุล' });

    const debtor = await tx(async () => {
      const code = b.code?.trim() || (await nextFreeDebtorCode(b.employee_id ?? null));
      if (await get(`SELECT id FROM debtors WHERE code = :c`, { c: code })) {
        throw Object.assign(new Error('รหัสลูกหนี้นี้ถูกใช้แล้ว'), { status: 400 });
      }
      const now = nowISO();
      const newId = await insert(
        `INSERT INTO debtors (code, full_name, phone, address, note, employee_id, area, status, created_at, updated_at)
         VALUES (:code, :name, :phone, :addr, :note, :emp, :area, :status, :now, :now)`,
        {
          code,
          name: b.full_name.trim(),
          phone: b.phone ?? null,
          addr: b.address ?? null,
          note: b.note ?? null,
          emp: b.employee_id ?? null,
          area: b.area ?? null,
          status: b.status ?? 'normal',
          now,
        },
      );
      return await get(`SELECT * FROM debtors WHERE id = :id`, { id: newId });
    });

    await audit({
      userId: req.ctx.user.id,
      action: 'create',
      entity: 'debtor',
      entityId: debtor.id,
      after: debtor,
      ip: req.ctx.ip,
    });
    res.status(201).json({ debtor });
  }),
);

router.put(
  '/:id',
  need('debtors_edit'),
  wrap(async (req, res) => {
    const id = intParam(req.params.id);
    const before = await get(`SELECT * FROM debtors WHERE id = :id`, { id });
    if (!before) return res.status(404).json({ error: 'ไม่พบลูกหนี้' });
    const b = req.body ?? {};

    await run(
      `UPDATE debtors SET
         full_name = :name, phone = :phone, address = :addr, note = :note,
         employee_id = :emp, area = :area, status = :status, updated_at = :now
       WHERE id = :id`,
      {
        id,
        name: b.full_name ?? before.full_name,
        phone: b.phone ?? before.phone,
        addr: b.address ?? before.address,
        note: b.note ?? before.note,
        emp: b.employee_id === undefined ? before.employee_id : b.employee_id,
        area: b.area ?? before.area,
        status: b.status ?? before.status,
        now: nowISO(),
      },
    );
    const after = await get(`SELECT * FROM debtors WHERE id = :id`, { id });
    await audit({
      userId: req.ctx.user.id,
      action: 'update',
      entity: 'debtor',
      entityId: id,
      before,
      after,
      reason: b.reason ?? null,
      ip: req.ctx.ip,
    });
    res.json({ debtor: after });
  }),
);

/** แนบเอกสาร: รูปถ่าย สำเนาบัตร เอกสารประกอบ (ข้อ 6) */
router.post(
  '/:id/documents',
  need('debtors_edit'),
  wrap(async (req, res) => {
    const id = intParam(req.params.id);
    if (!(await get(`SELECT id FROM debtors WHERE id = :id`, { id }))) {
      return res.status(404).json({ error: 'ไม่พบลูกหนี้' });
    }
    const saved = await saveDataUrl(req.body?.data_url, `debtor-${id}`);
    if (!saved) return res.status(400).json({ error: 'ไม่พบไฟล์แนบ' });

    const docId = await insert(
      `INSERT INTO debtor_documents (debtor_id, kind, file_name, file_path, mime_type, note, uploaded_by, created_at)
       VALUES (:id, :kind, :name, :path, :mime, :note, :uid, :now)`,
      {
        id,
        kind: req.body?.kind ?? 'document',
        name: req.body?.file_name ?? saved.path.split('/').pop(),
        path: saved.path,
        mime: saved.mime,
        note: req.body?.note ?? null,
        uid: req.ctx.user.id,
        now: nowISO(),
      },
    );
    const doc = await get(`SELECT * FROM debtor_documents WHERE id = :id`, { id: docId });
    await audit({
      userId: req.ctx.user.id,
      action: 'create',
      entity: 'debtor_document',
      entityId: doc.id,
      after: doc,
      ip: req.ctx.ip,
    });
    res.status(201).json({ document: doc });
  }),
);

export default router;
