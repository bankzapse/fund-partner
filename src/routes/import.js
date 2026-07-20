import { Router } from 'express';
import { readSpreadsheet } from '../lib/xlsx.js';
import { FIELDS, guessMapping, dryRun, commitImport, templateRows } from '../domain/import.js';
import { wrap, need, sendCsv } from './_helpers.js';

const router = Router();

const KINDS = new Set(['debtors', 'contracts']);

function assertKind(kind) {
  if (!KINDS.has(kind)) {
    throw Object.assign(new Error('ชนิดข้อมูลที่นำเข้าไม่ถูกต้อง'), { status: 400 });
  }
  return kind;
}

/** รายการฟิลด์ที่รองรับ ใช้สร้างหน้าจับคู่คอลัมน์ */
router.get(
  '/fields',
  need('settings_manage'),
  wrap((_req, res) => {
    res.json({ fields: FIELDS });
  }),
);

/** ไฟล์ตัวอย่างสำหรับกรอกข้อมูล */
router.get(
  '/template',
  need('settings_manage'),
  wrap((req, res) => {
    const kind = assertKind(String(req.query.kind ?? 'contracts'));
    const [header, ...rows] = templateRows(kind);
    sendCsv(
      res,
      `template-${kind}.csv`,
      rows.map((r) => Object.fromEntries(r.map((v, i) => [String(i), v]))),
      header.map((label, i) => ({ label, key: String(i) })),
    );
  }),
);

/**
 * ขั้นที่ 1 — อ่านไฟล์ คืนรายชื่อชีต หัวตาราง ตัวอย่างข้อมูล และการจับคู่ที่ระบบเดาให้
 * ยังไม่บันทึกอะไรลงฐานข้อมูล
 */
router.post(
  '/analyze',
  need('settings_manage'),
  wrap((req, res) => {
    const kind = assertKind(String(req.body?.kind ?? 'contracts'));
    const sheets = readSpreadsheet(req.body?.data_url, req.body?.file_name ?? '');

    const analyzed = sheets.map((sheet) => {
      const headerRowIndex = findHeaderRow(sheet.rows);
      const headers = sheet.rows[headerRowIndex] ?? [];
      return {
        name: sheet.name,
        total_rows: sheet.rows.length,
        header_row: headerRowIndex,
        headers,
        mapping: guessMapping(headers, kind),
        sample: sheet.rows.slice(headerRowIndex + 1, headerRowIndex + 6),
      };
    });

    res.json({ kind, sheets: analyzed, fields: FIELDS[kind] });
  }),
);

/** ขั้นที่ 2 — ตรวจสอบข้อมูลทุกแถวโดยไม่บันทึก */
router.post(
  '/dry-run',
  need('settings_manage'),
  wrap(async (req, res) => {
    const kind = assertKind(String(req.body?.kind ?? 'contracts'));
    const rows = extractRows(req.body);
    const result = await dryRun({
      rows,
      mapping: req.body?.mapping ?? {},
      kind,
      options: req.body?.options ?? {},
    });
    // ส่งกลับเฉพาะ 200 แถวแรกพอให้ตรวจ ไม่ให้ payload ใหญ่เกินไป
    res.json({ ...result, rows: result.rows.slice(0, 200), truncated: result.rows.length > 200 });
  }),
);

/** ขั้นที่ 3 — นำเข้าจริง (ทำใน transaction เดียว) */
router.post(
  '/commit',
  need('settings_manage'),
  wrap(async (req, res) => {
    const kind = assertKind(String(req.body?.kind ?? 'contracts'));
    const rows = extractRows(req.body);
    if (!rows.length) return res.status(400).json({ error: 'ไม่พบข้อมูลที่จะนำเข้า' });

    const summary = await commitImport(
      {
        rows,
        mapping: req.body?.mapping ?? {},
        kind,
        options: req.body?.options ?? {},
      },
      req.ctx,
    );
    res.status(201).json({ summary });
  }),
);

/** อ่านแถวข้อมูลจากไฟล์ที่ส่งมา ตัดหัวตารางออก */
function extractRows(body) {
  const sheets = readSpreadsheet(body?.data_url, body?.file_name ?? '');
  const sheetIndex = Number(body?.sheet_index ?? 0);
  const sheet = sheets[sheetIndex];
  if (!sheet) throw Object.assign(new Error('ไม่พบชีตที่เลือก'), { status: 400 });
  const headerRow = Number(body?.header_row ?? findHeaderRow(sheet.rows));
  return sheet.rows.slice(headerRow + 1);
}

/**
 * หาแถวหัวตาราง — ไฟล์จริงมักมีชื่อรายงานหรือบรรทัดว่างอยู่ด้านบน
 * เลือกแถวแรกใน 10 แถวแรกที่มีข้อความมากที่สุด
 */
function findHeaderRow(rows) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const filled = rows[i].filter((c) => String(c ?? '').trim() !== '').length;
    const textCells = rows[i].filter(
      (c) => String(c ?? '').trim() !== '' && !Number.isFinite(Number(String(c).replace(/,/g, ''))),
    ).length;
    const score = filled + textCells * 2;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export default router;
