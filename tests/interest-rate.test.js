// ยึดตัวเลขอัตราดอกเบี้ยที่อ้างใน docs/legal-checklist.md หัวข้อ 2.1
//
// เอกสารฉบับนั้นถูกส่งให้ทนายใช้ตัดสินใจ ถ้าตรรกะการสร้างตารางงวดเปลี่ยนไป
// แล้วตัวเลขในเอกสารกลายเป็นคนละเรื่องโดยไม่มีใครรู้ จะอันตรายกว่าไม่มีเอกสารเลย
// เทสต์ชุดนี้จึงพังทันทีเมื่อตัวเลขเปลี่ยน เพื่อบังคับให้กลับไปแก้เอกสารด้วย
process.env.FP_DB_PATH = ':memory:';

import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { analyse } from '../scripts/interest-rate.mjs';

/** ตัวเลขที่ปรากฏในเอกสารกฎหมาย — แก้ที่นี่ต้องแก้ในเอกสารด้วยเสมอ */
const IN_LEGAL_DOC = [
  {
    label: 'ก) ตัวอย่างตรงตาม SRS',
    input: { type: 'daily24', principal: 1000, installment: 50, interestPerInst: 20, n: 24, docFee: 100, deductFirst: true },
    cash: 850, totalPaid: 1430, cost: 580, apr: 1368,
  },
  {
    label: 'ข) รายวัน ไม่มีค่าธรรมเนียม',
    input: { type: 'daily24', principal: 720, installment: 50, interestPerInst: 20, n: 24 },
    cash: 720, totalPaid: 1200, cost: 480, apr: 1667,
  },
  {
    label: 'ค) รายเดือน 12 งวด',
    input: { type: 'monthly', principal: 10000, installment: 1134, interestPerInst: 300, n: 12 },
    cash: 10000, totalPaid: 13600, cost: 3600, apr: 61,
  },
  {
    label: 'ง) ดอกลอย',
    input: { type: 'floating', principal: 10000, installment: 500, interestPerInst: 500, n: 12 },
    cash: 10000, totalPaid: 16000, cost: 6000, apr: 60,
  },
];

describe('อัตราดอกเบี้ยที่อ้างในเอกสารกฎหมาย', () => {
  for (const c of IN_LEGAL_DOC) {
    test(`${c.label} — ตัวเลขตรงกับที่เขียนไว้ในเอกสาร`, () => {
      const r = analyse(c.input);
      assert.equal(r.cash, c.cash, 'เงินที่ลูกค้าได้รับจริง');
      assert.equal(r.totalPaid, c.totalPaid, 'ยอดจ่ายคืนรวม');
      assert.equal(r.cost, c.cost, 'ต้นทุนของลูกค้า');
      // เผื่อความคลาดเคลื่อนจากการปัดเศษ 1% แต่ไม่ให้เพี้ยนระดับหลักสิบ
      assert.ok(
        Math.abs(r.apr - c.apr) <= Math.max(1, c.apr * 0.01),
        `อัตราต่อปีเปลี่ยนจาก ${c.apr}% เป็น ${r.apr.toFixed(0)}% — ต้องแก้ docs/legal-checklist.md หัวข้อ 2.1 ด้วย`,
      );
    });
  }

  test('เงินที่ลูกค้าได้รับ ต้องหักค่าธรรมเนียมและงวดแรกออกแล้วเสมอ', () => {
    // ถ้าคำนวณจากเงินต้นเต็มจำนวน อัตราจะต่ำกว่าความจริง ซึ่งทำให้เอกสารกฎหมายผิดพลาด
    const withFee = analyse({ type: 'daily24', principal: 1000, installment: 50, interestPerInst: 20, n: 24, docFee: 100, deductFirst: true });
    const without = analyse({ type: 'daily24', principal: 1000, installment: 50, interestPerInst: 20, n: 24 });
    assert.ok(withFee.cash < without.cash, 'หักค่าธรรมเนียมแล้วเงินที่ได้รับต้องน้อยลง');
    assert.ok(withFee.apr > without.apr, 'ยิ่งได้เงินน้อยลง อัตราที่แท้จริงต้องยิ่งสูงขึ้น');
  });

  test('ยอดเงินต้นที่ค้างตอนจบต้องถูกนับเป็นเงินที่ลูกค้าต้องจ่าย', () => {
    // ตารางงวด 24 งวดตัดต้นได้แค่ 720 จากเงินต้น 1,000 — ถ้าไม่นับ 280 ที่ค้าง
    // อัตราจะดูต่ำกว่าความจริง
    const r = analyse({ type: 'daily24', principal: 1000, installment: 50, interestPerInst: 20, n: 24 });
    assert.equal(r.balloon, 280, 'ต้องเหลือเงินต้นค้าง 280 บาท');
    assert.equal(r.totalPaid, 24 * 50 + 280, 'ยอดจ่ายคืนต้องรวมยอดค้างด้วย');
  });

  test('ยิ่งดอกต่องวดต่ำลง อัตราต่อปีต้องต่ำลงตาม', () => {
    // ตรวจทิศทางของสูตร ถ้ากลับทิศแปลว่าคำนวณผิดและเอกสารเชื่อไม่ได้
    const rates = [300, 200, 125].map(
      (i) => analyse({ type: 'monthly', principal: 10000, installment: 1000 + i, interestPerInst: i, n: 12 }).apr,
    );
    assert.ok(rates[0] > rates[1] && rates[1] > rates[2], `อัตราควรลดหลั่นกัน แต่ได้ ${rates.map((r) => r.toFixed(0)).join(' → ')}`);
  });
});
