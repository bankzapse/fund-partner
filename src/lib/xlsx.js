import { inflateRawSync } from 'node:zlib';

/**
 * ตัวอ่านไฟล์ Excel (.xlsx) และ CSV แบบไม่พึ่งไลบรารีภายนอก
 *
 * .xlsx คือไฟล์ ZIP ที่ข้างในเป็น XML — อ่านเฉพาะค่าที่ Excel บันทึกไว้แล้ว
 * (สูตรจะถูกอ่านเป็น "ค่าผลลัพธ์ล่าสุด" ที่ Excel คำนวณไว้ ซึ่งเพียงพอกับการนำเข้าข้อมูล)
 *
 * รองรับ: sharedStrings, inline string, ตัวเลข, วันที่แบบ serial ของ Excel
 * ไม่รองรับ: .xls รุ่นเก่า (ให้ Save As เป็น .xlsx หรือ CSV ก่อน)
 */

// ---- ZIP ---------------------------------------------------------------------

/** แตกไฟล์ ZIP แบบอ่านอย่างเดียว คืน Map ของ ชื่อไฟล์ -> Buffer */
function readZip(buf) {
  const files = new Map();

  // หา End of Central Directory (อาจมี comment ต่อท้าย จึงไล่จากท้ายไฟล์)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ไฟล์ไม่ใช่ .xlsx ที่ถูกต้อง (ไม่พบโครงสร้าง ZIP)');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // อ่าน local header เพื่อหาจุดเริ่มข้อมูลจริง
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---- XML ---------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

/** ดึงข้อความทั้งหมดจาก <t>...</t> ภายในก้อน XML */
function textOf(xml) {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

// ---- แปลงค่าเซลล์ -------------------------------------------------------------

/** Excel เก็บวันที่เป็นจำนวนวันนับจาก 1899-12-30 */
export function excelSerialToDate(serial) {
  const days = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** อ้างอิงเซลล์ เช่น "BC12" -> ลำดับคอลัมน์ (เริ่มที่ 0) */
function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** รูปแบบตัวเลขที่บ่งบอกว่าเป็นวันที่ */
const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

// ---- ตัวอ่านหลัก -------------------------------------------------------------

/**
 * อ่านไฟล์ .xlsx คืนรายการชีต: [{ name, rows: string[][] }]
 * ทุกค่าถูกคืนเป็น string เพื่อให้ขั้นตอนตรวจสอบเป็นผู้ตีความเอง
 */
export function readXlsx(buffer) {
  const files = readZip(buffer);

  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [];
  for (const m of sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  // รูปแบบวันที่: styles.xml -> cellXfs -> numFmtId
  const stylesXml = files.get('xl/styles.xml')?.toString('utf8') ?? '';
  const customDateFmt = new Set();
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    if (/[dmyDMY]/.test(m[2]) && !/[hs]/.test(m[2].replace(/"[^"]*"/g, ''))) {
      customDateFmt.add(Number(m[1]));
    }
  }
  const cellXfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  const styleIsDate = [...cellXfs.matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*\/?>/g)].map((m) => {
    const id = Number(m[1]);
    return DATE_FORMATS.has(id) || customDateFmt.has(id);
  });

  // ชื่อชีตจาก workbook.xml จับคู่กับไฟล์ worksheet
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const sheetNames = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) =>
    decodeXml(m[1]),
  );

  const sheetPaths = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const sheets = [];
  sheetPaths.forEach((path, i) => {
    const xml = files.get(path).toString('utf8');
    const rows = [];

    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      // แยกสองรูปแบบให้ชัด: เซลล์ว่างแบบปิดในตัว <c ... /> กับเซลล์ที่มีเนื้อหา <c ...>...</c>
      // ต้องลองแบบปิดในตัวก่อน มิฉะนั้นการจับคู่จะกลืนเซลล์ถัดไปและทำให้ค่าหาย
      const CELL_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
      for (const c of rowMatch[1].matchAll(CELL_RE)) {
        const selfClosing = c[1] !== undefined;
        const attrs = selfClosing ? c[1] : c[2];
        const inner = selfClosing ? '' : (c[3] ?? '');
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/t="(\w+)"/)?.[1];
        const styleId = Number(attrs.match(/s="(\d+)"/)?.[1] ?? -1);
        const idx = ref ? colIndex(ref) : cells.length;

        let value = '';
        if (type === 's') {
          const n = Number(inner.match(/<v>(\d+)<\/v>/)?.[1]);
          value = shared[n] ?? '';
        } else if (type === 'inlineStr') {
          value = textOf(inner);
        } else if (type === 'str' || type === 'e') {
          value = decodeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
        } else {
          const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
          if (raw !== '' && styleIsDate[styleId] && Number.isFinite(Number(raw))) {
            value = excelSerialToDate(Number(raw));
          } else {
            value = decodeXml(raw);
          }
        }
        cells[idx] = value;
      }
      // เติมช่องว่างให้ครบ ไม่ให้ index เลื่อน
      for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = '';
      rows.push(cells);
    }

    sheets.push({ name: sheetNames[i] ?? `Sheet${i + 1}`, rows });
  });

  return sheets;
}

/** อ่าน CSV (รองรับ BOM, เครื่องหมายคำพูด และตัวคั่น , ; tab) */
export function readCsv(text) {
  let s = text.replace(/^﻿/, '');
  const head = s.slice(0, s.indexOf('\n') === -1 ? s.length : s.indexOf('\n'));
  const delim = [',', ';', '\t'].reduce(
    (best, d) => ((head.split(d).length > head.split(best).length ? d : best)),
    ',',
  );

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return [{ name: 'CSV', rows }];
}

/** อ่านไฟล์จาก data URL — เลือกตัวอ่านตามชนิดไฟล์ */
export function readSpreadsheet(dataUrl, fileName = '') {
  const m = /^data:([\w/+.-]*);base64,(.+)$/s.exec(String(dataUrl ?? ''));
  if (!m) throw Object.assign(new Error('รูปแบบไฟล์ไม่ถูกต้อง'), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');

  if (buf.length > 12 * 1024 * 1024) {
    throw Object.assign(new Error('ไฟล์ใหญ่เกิน 12 MB'), { status: 400 });
  }
  if (buf.length === 0) {
    throw Object.assign(new Error('ไฟล์ว่างเปล่า'), { status: 400 });
  }

  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  if (isZip) return readXlsx(buf);

  if (buf[0] === 0xd0 && buf[1] === 0xcf) {
    throw Object.assign(
      new Error('ไฟล์เป็น .xls รุ่นเก่า กรุณาเปิดด้วย Excel แล้ว Save As เป็น .xlsx หรือ CSV ก่อน'),
      { status: 400 },
    );
  }

  if (/\.(csv|txt)$/i.test(fileName) || !isZip) return readCsv(buf.toString('utf8'));

  throw Object.assign(new Error('รองรับเฉพาะไฟล์ .xlsx และ .csv'), { status: 400 });
}
