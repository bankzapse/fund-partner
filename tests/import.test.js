// ระบบนำเข้าข้อมูลจาก Excel — SRS ข้อ 19
process.env.FP_DB_PATH = ':memory:';

import { before, beforeEach, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { db, get, all, run, insert, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO } from '../src/lib/time.js';
import { readXlsx, readCsv, excelSerialToDate } from '../src/lib/xlsx.js';
import {
  guessMapping,
  parseMoney,
  parseDate,
  parseCount,
  dryRun,
  commitImport,
  FIELDS,
} from '../src/domain/import.js';
import { financeSummary } from '../src/domain/reports.js';
import { contractSummary } from '../src/domain/contracts.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures');
let owner, ctx, ready = false;

async function setup() {
  if (ready) return;
  await db();
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)
     ON CONFLICT (username) DO NOTHING`,
    { h: hashPassword('owner1234'), now: nowISO() },
  );
  owner = await get(`SELECT * FROM users WHERE username = 'owner'`);
  await run(
    `INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
     VALUES ('E001', 'สมชาย เก็บเงิน', 1, :now, :now)
     ON CONFLICT (code) DO NOTHING`,
    { now: nowISO() },
  );
  ctx = { user: owner, ip: 'test' };
  ready = true;
}

before(setup);
beforeEach(setup);
after(async () => { await closeDb(); });

/** จับคู่คอลัมน์ให้ครบตามลำดับหัวตารางของไฟล์ทดสอบ */
function sheetOf(file) {
  return readXlsx(readFileSync(join(FIXTURES, file)))[0];
}

// -----------------------------------------------------------------------------
describe('ตัวอ่านไฟล์', () => {
  test('อ่าน .xlsx ภาษาไทย ตัวเลข และวันที่ได้ครบ', () => {
    const sheet = sheetOf('debtors.xlsx');
    assert.equal(sheet.name, 'ลูกหนี้');
    assert.deepEqual(sheet.rows[0].slice(0, 3), ['รหัสลูกหนี้', 'ชื่อ-นามสกุล', 'เบอร์โทร']);
    assert.equal(sheet.rows[1][1], 'สมชาย ทดสอบ');
    assert.equal(sheet.rows[1][8], '2026-06-01', 'วันที่ต้องถูกแปลงจาก serial ของ Excel');
  });

  test('เซลล์ว่างแบบปิดในตัวต้องไม่กลืนค่าของเซลล์ถัดไป', () => {
    // แถวที่ 3 มีช่อง "ที่อยู่" ว่าง ซึ่ง Excel เขียนเป็น <c ... /> แบบปิดในตัว
    // ถ้าตัวอ่านพลาด ค่า "เงินต้น" ของเซลล์ถัดไปจะหายไปเงียบ ๆ
    const sheet = sheetOf('debtors.xlsx');
    const row = sheet.rows[3];
    assert.equal(row[3], '', 'ที่อยู่ว่าง');
    assert.equal(row[4], '20000', 'เงินต้นต้องยังอยู่ครบ');
    assert.equal(row[5], '1000', 'ค่างวดต้องไม่เลื่อนตำแหน่ง');
  });

  test('ทุกแถวข้อมูลต้องมีจำนวนคอลัมน์ตรงกับหัวตาราง', () => {
    const sheet = sheetOf('debtors.xlsx');
    for (let i = 1; i < sheet.rows.length; i++) {
      assert.ok(sheet.rows[i].length >= 10, `แถว ${i} คอลัมน์ไม่ครบ`);
    }
  });

  test('อ่าน CSV ที่มี BOM และเครื่องหมายคำพูดได้', () => {
    const rows = readCsv('﻿ชื่อ,ยอด\n"สมชาย, ใจดี","1,000"\n')[0].rows;
    assert.deepEqual(rows[0], ['ชื่อ', 'ยอด']);
    assert.deepEqual(rows[1], ['สมชาย, ใจดี', '1,000']);
  });

  test('แปลง serial ของ Excel เป็นวันที่ถูกต้อง', () => {
    assert.equal(excelSerialToDate(45658), '2025-01-01');
  });

  test('ไฟล์ .xls รุ่นเก่าต้องแจ้งให้แปลงไฟล์ ไม่ใช่พังเงียบ', async () => {
    const { readSpreadsheet } = await import('../src/lib/xlsx.js');
    const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.throws(
      () => readSpreadsheet(`data:application/vnd.ms-excel;base64,${oleHeader.toString('base64')}`, 'old.xls'),
      /\.xls รุ่นเก่า/,
    );
  });
});

// -----------------------------------------------------------------------------
describe('การแปลงค่าและจับคู่คอลัมน์', () => {
  test('เดาการจับคู่จากหัวคอลัมน์ภาษาไทยได้', () => {
    const headers = ['รหัสลูกหนี้', 'ชื่อ-นามสกุล', 'เบอร์โทร', 'ที่อยู่', 'เงินต้น', 'ค่างวด', 'ดอกเบี้ย', 'จำนวนงวด', 'วันเริ่มสัญญา', 'เงินต้นคงเหลือ'];
    const m = guessMapping(headers, 'contracts');
    assert.equal(m.debtor_name, 1);
    assert.equal(m.principal_amount, 4);
    assert.equal(m.installment_amount, 5);
    assert.equal(m.interest_per_inst, 6);
    assert.equal(m.start_date, 8);
    assert.equal(m.principal_remaining, 9);
  });

  test('คอลัมน์หนึ่งถูกจับคู่กับฟิลด์เดียวเท่านั้น', () => {
    const headers = ['เงินต้น', 'เงินต้นคงเหลือ'];
    const m = guessMapping(headers, 'contracts');
    const used = Object.values(m);
    assert.equal(new Set(used).size, used.length, 'ห้ามจับคู่คอลัมน์ซ้ำ');
  });

  test('แปลงจำนวนเงินรองรับเครื่องหมายคั่นหลักและสัญลักษณ์บาท', () => {
    assert.equal(parseMoney('1,000.50'), 100050);
    assert.equal(parseMoney('฿2,000'), 200000);
    assert.equal(parseMoney(' 350 '), 35000);
    assert.equal(parseMoney(''), null);
    assert.ok(Number.isNaN(parseMoney('ไม่ใช่ตัวเลข')));
  });

  test('แปลงวันที่รองรับ พ.ศ. และรูปแบบไทย วว/ดด/ปปปป', () => {
    assert.equal(parseDate('2026-07-20'), '2026-07-20');
    assert.equal(parseDate('20/07/2569'), '2026-07-20', 'ปี พ.ศ. ต้องแปลงเป็น ค.ศ.');
    assert.equal(parseDate('05/01/2026'), '2026-01-05', 'ต้องอ่านเป็น วัน/เดือน/ปี');
    assert.equal(parseDate(''), null);
    assert.ok(Number.isNaN(parseDate('31/02/2026')), 'วันที่ไม่มีจริงต้องถูกปฏิเสธ');
  });

  test('parseCount ปฏิเสธค่าที่ไม่ใช่ตัวเลข', () => {
    assert.equal(parseCount('24'), 24);
    assert.equal(parseCount(''), null);
    assert.ok(Number.isNaN(parseCount('abc')));
  });
});

// -----------------------------------------------------------------------------
describe('ตรวจก่อนนำเข้า (dry run)', () => {
  const mapping = {
    debtor_code: 0, debtor_name: 1, phone: 2, address: 3,
    principal_amount: 4, installment_amount: 5, interest_per_inst: 6,
    num_installments: 7, start_date: 8, principal_remaining: 9,
  };

  test('ไฟล์ที่ถูกต้องต้องผ่านทุกแถว', async () => {
    const sheet = sheetOf('debtors.xlsx');
    const result = await dryRun({ rows: sheet.rows.slice(1), mapping, kind: 'contracts', options: {} });
    assert.equal(result.total_rows, 3);
    assert.equal(result.error_count, 0, JSON.stringify(result.rows.flatMap((r) => r.errors)));
    assert.equal(result.total_principal, 3_500_000, 'เงินต้นรวม 35,000 บาท');
    assert.equal(result.total_remaining, 3_120_000, 'ยอดยกมารวม 31,200 บาท');
  });

  test('dry run ต้องไม่บันทึกอะไรลงฐานข้อมูล', async () => {
    const before = (await all(`SELECT id FROM debtors`)).length;
    const sheet = sheetOf('debtors.xlsx');
    await dryRun({ rows: sheet.rows.slice(1), mapping, kind: 'contracts', options: {} });
    const after = (await all(`SELECT id FROM debtors`)).length;
    assert.equal(after, before);
  });

  test('จับข้อผิดพลาดรายแถวได้ครบ ไม่ล้มทั้งไฟล์', async () => {
    const rows = [
      ['', '', '', '', '', '', '', '', '', ''],              // แถวว่าง -> ข้าม
      ['X1', '', '0800000000', '', '1000', '50', '20', '24', '2026-01-01', '900'],   // ไม่มีชื่อ
      ['X2', 'ทดสอบ ก', '', '', 'abc', '50', '20', '24', '2026-01-01', '900'],       // เงินต้นไม่ใช่ตัวเลข
      ['X3', 'ทดสอบ ข', '', '', '1000', '20', '20', '24', '2026-01-01', '900'],      // ค่างวด <= ดอก
      ['X4', 'ทดสอบ ค', '', '', '1000', '50', '20', '24', '2026-01-01', '2000'],     // คงเหลือ > เงินต้น
      ['X5', 'ทดสอบ ง', '', '', '1000', '50', '20', '24', '31/02/2026', '900'],      // วันที่ไม่มีจริง
    ];
    const result = await dryRun({ rows, mapping, kind: 'contracts', options: {} });
    assert.equal(result.total_rows, 5, 'แถวว่างทั้งแถวต้องถูกข้าม');
    assert.equal(result.error_count, 5);
    assert.match(result.rows[0].errors.join(), /ชื่อ/);
    assert.match(result.rows[1].errors.join(), /ตัวเลข/);
    assert.match(result.rows[2].errors.join(), /ค่างวดต้องมากกว่าดอกเบี้ย/);
    assert.match(result.rows[3].errors.join(), /มากกว่าเงินต้น/);
    assert.match(result.rows[4].errors.join(), /อ่านไม่ออก/);
  });

  test('ตรวจรหัสลูกหนี้ซ้ำภายในไฟล์เดียวกัน', async () => {
    const rows = [
      ['SAME', 'คนที่หนึ่ง', '', '', '1000', '50', '20', '24', '2026-01-01', '1000'],
      ['SAME', 'คนที่สอง', '', '', '1000', '50', '20', '24', '2026-01-01', '1000'],
    ];
    const result = await dryRun({ rows, mapping, kind: 'contracts', options: {} });
    assert.match(result.rows[1].errors.join(), /ซ้ำในไฟล์/);
  });
});

// -----------------------------------------------------------------------------
describe('นำเข้าจริง', () => {
  const mapping = {
    debtor_code: 0, debtor_name: 1, phone: 2, address: 3,
    principal_amount: 4, installment_amount: 5, interest_per_inst: 6,
    num_installments: 7, start_date: 8, principal_remaining: 9,
  };

  test('สร้างลูกหนี้และสัญญาพร้อมยอดยกมาถูกต้อง', async () => {
    const sheet = sheetOf('debtors.xlsx');
    const summary = await commitImport(
      { rows: sheet.rows.slice(1), mapping, kind: 'contracts', options: {} },
      ctx,
    );
    assert.equal(summary.debtors_created, 3);
    assert.equal(summary.contracts_created, 3);
    assert.equal(summary.skipped, 0);

    const debtor = await get(`SELECT * FROM debtors WHERE code = 'L001'`);
    assert.equal(debtor.full_name, 'สมชาย ทดสอบ');

    const contract = await get(
      `SELECT * FROM contracts WHERE debtor_id = :id`, { id: debtor.id },
    );
    assert.equal(contract.principal_amount, 500_000, 'เงินต้น 5,000 บาท');
    assert.equal(contract.principal_remaining, 320_000, 'ยอดยกมา 3,200 บาท');
    assert.equal(contract.status, 'active');
    assert.match(contract.note, /นำเข้าจากไฟล์/);

    const installments = await all(
      `SELECT * FROM installments WHERE contract_id = :id ORDER BY seq`, { id: contract.id },
    );
    assert.equal(installments.length, 24);
  });

  test('การนำเข้าต้องไม่สร้างรายรับ-รายจ่ายย้อนหลัง (ไม่ทำให้กำไรงวดนี้ผิด)', async () => {
    const before = await financeSummary({ from: '1900-01-01', to: '2999-12-31' });

    const rows = [
      ['IMP1', 'ตรวจกำไร', '', '', '10000', '500', '200', '24', '2026-06-01', '6000'],
    ];
    await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);

    const after = await financeSummary({ from: '1900-01-01', to: '2999-12-31' });

    assert.equal(after.doc_fee_income, before.doc_fee_income, 'ต้องไม่มีค่าทำเอกสารเกิดใหม่');
    assert.equal(after.interest_income, before.interest_income, 'ต้องไม่มีดอกเบี้ยรับเกิดใหม่');
    assert.equal(after.net_profit, before.net_profit, 'กำไรสุทธิต้องไม่เปลี่ยน');
    assert.equal(after.total_in, before.total_in, 'เงินรับต้องไม่เปลี่ยน');
    assert.equal(after.total_out, before.total_out, 'เงินจ่ายต้องไม่เปลี่ยน');
    assert.equal(
      after.principal_outstanding,
      before.principal_outstanding + 600_000,
      'เงินต้นคงเหลือในลูกหนี้ต้องเพิ่มตามยอดยกมา',
    );
  });

  test('สัญญาที่นำเข้ารับชำระต่อได้ทันที และตัดดอกก่อนต้นตามกติกาเดิม', async () => {
    const rows = [
      ['CONT1', 'ผ่อนต่อได้', '', '', '1000', '50', '20', '24', '2026-06-01', '700'],
    ];
    await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);

    const debtor = await get(`SELECT * FROM debtors WHERE code = 'CONT1'`);
    const contract = await get(`SELECT * FROM contracts WHERE debtor_id = :id`, { id: debtor.id });

    const { recordPayment } = await import('../src/domain/payments.js');
    const payment = await recordPayment(
      { contractId: contract.id, amountPaid: 5_000, paidDate: '2026-08-01' },
      ctx,
    );
    assert.equal(payment.interest_amount, 2_000);
    assert.equal(payment.principal_amount, 3_000);

    const after = await get(`SELECT principal_remaining FROM contracts WHERE id = :id`, {
      id: contract.id,
    });
    assert.equal(after.principal_remaining, 70_000 - 3_000, 'ตัดจากยอดยกมา ไม่ใช่เงินต้นเต็ม');
  });

  test('นำเข้าซ้ำด้วยรหัสเดิมจะใช้ลูกหนี้เดิม ไม่สร้างซ้ำ', async () => {
    const rows = [['DUP1', 'ลูกหนี้ซ้ำ', '', '', '1000', '50', '20', '24', '2026-06-01', '1000']];
    const first = await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);
    assert.equal(first.debtors_created, 1);

    const second = await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);
    assert.equal(second.debtors_created, 0);
    assert.equal(second.debtors_reused, 1, 'ต้องใช้ลูกหนี้เดิม');
    assert.equal(second.contracts_created, 1, 'แต่สร้างสัญญาใบใหม่ได้');

    const count = (await all(`SELECT id FROM debtors WHERE code = 'DUP1'`)).length;
    assert.equal(count, 1);
  });

  test('แถวที่มีปัญหาถูกข้าม แถวที่ถูกต้องยังนำเข้าได้', async () => {
    const rows = [
      ['MIX1', 'ถูกต้อง', '', '', '1000', '50', '20', '24', '2026-06-01', '1000'],
      ['MIX2', '', '', '', '1000', '50', '20', '24', '2026-06-01', '1000'], // ไม่มีชื่อ
    ];
    const summary = await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);
    assert.equal(summary.contracts_created, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.errors.length, 1);
    assert.ok(await get(`SELECT id FROM debtors WHERE code = 'MIX1'`));
  });

  test('บันทึก Audit Log ของการนำเข้า (ข้อ 15)', async () => {
    const rows = [['AUD1', 'ตรวจ log', '', '', '1000', '50', '20', '24', '2026-06-01', '1000']];
    await commitImport({ rows, mapping, kind: 'contracts', options: { reason: 'ย้ายข้อมูลจากสมุด' } }, ctx);
    const log = await get(
      `SELECT * FROM audit_logs WHERE entity = 'import' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(log.action, 'import');
    assert.equal(log.reason, 'ย้ายข้อมูลจากสมุด');
    assert.equal(log.user_id, owner.id);
  });

  test('นำเข้าเฉพาะลูกหนี้ (ไม่มีสัญญา) ได้', async () => {
    const rows = [['ONLY1', 'ลูกหนี้อย่างเดียว', '0899999999', 'เชียงใหม่', '', '', '']];
    const summary = await commitImport(
      {
        rows,
        mapping: { debtor_code: 0, debtor_name: 1, phone: 2, address: 3 },
        kind: 'debtors',
        options: {},
      },
      ctx,
    );
    assert.equal(summary.debtors_created, 1);
    assert.equal(summary.contracts_created, 0);
    const d = await get(`SELECT * FROM debtors WHERE code = 'ONLY1'`);
    assert.equal(d.phone, '0899999999');
  });

  test('ยอดยกหมด (คงเหลือ 0) ต้องปิดสัญญาเป็นครบสัญญา', async () => {
    const rows = [['DONE1', 'ปิดแล้ว', '', '', '1000', '50', '20', '24', '2026-01-01', '0']];
    await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);
    const d = await get(`SELECT * FROM debtors WHERE code = 'DONE1'`);
    const c = await get(`SELECT * FROM contracts WHERE debtor_id = :id`, { id: d.id });
    assert.equal(c.status, 'completed');
    assert.equal(c.principal_remaining, 0);
  });

  test('เลขที่สัญญาที่ระบบออกให้ต้องไม่ซ้ำกับของเดิม', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => [
      `SEQ${i}`, `ลูกหนี้ ${i}`, '', '', '1000', '50', '20', '24', '2026-09-01', '1000',
    ]);
    await commitImport({ rows, mapping, kind: 'contracts', options: {} }, ctx);
    const nos = (await all(`SELECT contract_no FROM contracts`)).map((r) => r.contract_no);
    assert.equal(new Set(nos).size, nos.length, 'เลขที่สัญญาต้องไม่ซ้ำ');
  });
});
