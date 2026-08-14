// โหมด "หักดอกก่อน" (สเปกข้อ 8-9, 11, 15-16, 26)
//
// กู้ 2,000 ดอก 10% → หัก 200 ตอนจ่ายเงิน ลูกค้าได้จริง 1,800 ส่งคืนตามยอดสัญญา 2,000
// ดอกรับรู้เป็นรายได้ตั้งแต่วันเปิดสัญญา และห้ามหักงวดแรก
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, all, closeDb, UPFRONT_INTEREST_CATEGORY } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO } from '../src/lib/time.js';
import { financeSummary } from '../src/domain/reports.js';

let server, base;
const sess = {};

async function api(role, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(sess[role] ? { Cookie: `fp_session=${sess[role]}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
  return { status: res.status, body: json, text };
}

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const now = nowISO();
  await run(
    `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('owner', :h, 'เจ้าของ', 'owner', 1, :now, :now)`,
    { h: hashPassword('Owner#Pass1'), now },
  );
  await run(
    `INSERT INTO employees (code, full_name, is_active, created_at, updated_at)
     VALUES ('E001', 'พนักงาน ก', 1, :now, :now)`,
    { now },
  );
  await run(
    `INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
     VALUES ('D001', 'ลูกหนี้ทดสอบ', 1, 'normal', :now, :now)`,
    { now },
  );
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'Owner#Pass1' }),
  });
  sess.owner = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1];
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closeDb();
});

async function makeUpfront({ principal = 200000, rateBp = 1000, n = 20, type = 'daily24', docFee = 0, startDate } = {}) {
  const res = await api('owner', 'POST', '/api/contracts', {
    debtor_id: 1,
    type,
    principal_amount: principal,
    num_installments: n,
    interest_mode: 'deduct_upfront',
    interest_rate_bp: rateBp,
    doc_fee: docFee,
    ...(startDate ? { start_date: startDate } : {}),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

describe('หักดอกก่อน — ตัวเลขตามสเปก', () => {
  test('ยอดสัญญา 2,000 ดอก 10% → ลูกค้าได้ 1,800 ส่งคืน 2,000 งวดละ 100×20', async () => {
    const { contract: c, preview } = await makeUpfront({ startDate: '2030-01-01' });
    assert.equal(c.interest_mode, 'deduct_upfront');
    assert.equal(c.total_due, 200000, 'ส่งคืนตามยอดสัญญา 2,000 ไม่บวกดอก');
    assert.equal(c.installment_amount, 10000, 'งวดละ 100 บาท');
    assert.equal(preview.upfront_interest, 20000, 'ดอกหักก่อน 200 บาท');
    assert.equal(preview.cash_to_customer, 180000, 'ลูกค้าได้รับจริง 1,800');

    // ตารางงวดเป็นเงินต้นล้วน รวมเท่ายอดสัญญา
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id });
    assert.equal(inst.length, 20);
    assert.ok(inst.every((r) => r.interest_due === 0), 'ทุกงวดไม่มีดอก (รับรู้แล้ววันเปิด)');
    assert.equal(inst.reduce((s, r) => s + r.principal_due, 0), 200000);
  });

  test('ข้อ 11: หักดอกก่อน → ไม่หักงวดแรก แม้ระบบตั้งค่าหักงวดแรกไว้', async () => {
    // ส่ง deduct_first: true มาตรง ๆ — domain ต้องบังคับเป็น false
    const res = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 20,
      interest_mode: 'deduct_upfront', interest_rate_bp: 1000, doc_fee: 10000,
      deduct_first: true, start_date: '2030-02-01',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.preview.first_installment, 0, 'ห้ามหักงวดแรก');
    assert.equal(res.body.contract.first_inst_deducted, 0);
    // มีค่าทำสัญญา 100: ได้จริง = 2,000 − 200 − 100 = 1,700
    assert.equal(res.body.preview.cash_to_customer, 170000);
    const paid = await get(
      `SELECT COUNT(*)::int n FROM payments WHERE contract_id = :c AND is_void = 0`,
      { c: res.body.contract.id },
    );
    assert.equal(paid.n, 0, 'ยังไม่มีการชำระใด ๆ — เหลือครบทุกงวด');
  });

  test('ข้อ 15: ดอกรับรู้เป็นรายได้เงินสดตั้งแต่วันเปิดสัญญา', async () => {
    const D = '2030-03-01';
    const { contract: c } = await makeUpfront({ startDate: D });
    const entry = await get(
      `SELECT * FROM income_entries WHERE contract_id = :c AND category = :cat AND is_void = 0`,
      { c: c.id, cat: UPFRONT_INTEREST_CATEGORY },
    );
    assert.ok(entry, 'ต้องมีรายการดอกหักก่อน');
    assert.equal(entry.amount, 20000);
    assert.equal(entry.entry_date, D, 'ลงวันเปิดสัญญา');

    const day = await financeSummary({ from: D, to: D });
    assert.equal(day.upfront_interest_income, 20000, 'เป็นรายได้วันเปิด');
    assert.ok(day.net_profit >= 20000, 'อยู่ในกำไรทันที');
    // เป็นเงินสดจริง: เงินออกสุทธิวันนั้น = 1,800 (ปล่อย 2,000 − ดอกหัก 200)
    assert.equal(day.total_out - day.total_in, 180000, 'เงินสดออกสุทธิ = เงินที่ลูกค้าได้จริง');
  });

  test('ข้อ 16: รายเดือนก็ใช้หักดอกก่อนได้', async () => {
    const res = await makeUpfront({ type: 'monthly', principal: 1000000, rateBp: 2000, n: 10, startDate: '2030-04-01' });
    // 10,000 ดอก 20% = 2,000 → ได้จริง 8,000 ส่งคืน 10,000
    assert.equal(res.preview.upfront_interest, 200000);
    assert.equal(res.preview.cash_to_customer, 800000);
    assert.equal(res.contract.total_due, 1000000);
  });
});

describe('หักดอกก่อน — วงจรชีวิตสัญญา', () => {
  test('จ่ายครบปิดสัญญา: ไม่รับรู้ดอกซ้ำ กำไรทั้งสัญญา = ดอกหักก่อนก้อนเดียว', async () => {
    const { contract: c } = await makeUpfront({ startDate: '2030-05-01' });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id });
    for (const r of inst) {
      const p = await api('owner', 'POST', '/api/payments', {
        contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date,
      });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      // สเปกข้อ 13: เงินรับเป็นรับชำระตามสัญญา — การจัดสรรภายในเป็นต้นล้วน
      assert.equal(p.body.payment.interest_amount, 0);
    }
    const st = await get(`SELECT status FROM contracts WHERE id = :c`, { c: c.id });
    assert.equal(st.status, 'completed', 'จ่ายครบต้องปิดสัญญา');

    // ห้ามมีรายการรับรู้ตอนปิด (ดอกรับรู้ไปแล้ววันเปิด — รับรู้ซ้ำ = กำไรเบิ้ล)
    const dup = await get(
      `SELECT COUNT(*)::int n FROM income_entries
       WHERE contract_id = :c AND category = 'ดอกเบี้ยรับรู้ตอนปิดสัญญา' AND is_void = 0`,
      { c: c.id },
    );
    assert.equal(dup.n, 0, 'ต้องไม่รับรู้ดอกซ้ำตอนปิด');

    // conservation ทั้งสัญญา: เก็บ 2,000 − จ่ายสุทธิ 1,800 = กำไร 200 = ดอกหักก่อน
    const cash = await get(`SELECT COALESCE(SUM(amount_paid),0) s FROM payments WHERE contract_id = :c AND is_void = 0`, { c: c.id });
    assert.equal(Number(cash.s) - 180000, 20000, 'กำไรเงินสดจริง = ดอกหักก่อนพอดี');
  });

  test('รียอดสัญญาหักดอกก่อน: ไม่รับรู้ดอกเพิ่ม ยอดคงเหลือยกไปถูกต้อง', async () => {
    const { contract: c } = await makeUpfront({ startDate: '2030-06-01' });
    // จ่าย 5 งวด (500) → คงเหลือตามสัญญา 1,500
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`, { c: c.id });
    for (const r of inst) {
      await api('owner', 'POST', '/api/payments', { contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date });
    }
    const before = await get(
      `SELECT COALESCE(SUM(amount),0) s FROM income_entries
       WHERE category IN ('ดอกเบี้ยรับรู้ตอนรียอด', 'ดอกเบี้ยรับรู้ตอนปิดสัญญา') AND contract_id = :c AND is_void = 0`,
      { c: c.id },
    );
    const res = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0, deduct_first: false, doc_fee: 0,
      interest_mode: 'per_installment', installment_amount: 10000, interest_per_inst: 1000,
      num_installments: 20,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.new_contract.principal_amount, 150000, 'ยกยอดคงเหลือ 1,500');

    const afterRec = await get(
      `SELECT COALESCE(SUM(amount),0) s FROM income_entries
       WHERE category IN ('ดอกเบี้ยรับรู้ตอนรียอด', 'ดอกเบี้ยรับรู้ตอนปิดสัญญา') AND contract_id = :c AND is_void = 0`,
      { c: c.id },
    );
    assert.equal(Number(afterRec.s), Number(before.s), 'รียอดต้องไม่รับรู้ดอกเพิ่ม (รับรู้แล้ววันเปิด)');

    const link = await get(`SELECT * FROM contract_links WHERE from_contract_id = :c`, { c: c.id });
    assert.equal(link.carried_interest, 0, 'ยอดที่ยกไปเป็นเงินต้นล้วน ไม่มีดอกค้างรับรู้');
    assert.equal(link.carried_principal, 150000);
  });

  test('หน้าจอรับชำระ: ได้ interest_mode + ยอดคงเหลือตามสัญญา (ไม่แยกต้น/ดอก)', async () => {
    const { contract: c } = await makeUpfront({ startDate: '2030-07-01' });
    const r = await api('owner', 'POST', '/api/payments/preview', {
      contract_id: c.id, amount_paid: 10000,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.preview.interest_mode, 'deduct_upfront');
    assert.equal(r.body.preview.contract_outstanding_after, 190000, '2,000 − 100 = 1,900');
  });
});

describe('หักดอกก่อน — ขอบเขตและการป้องกัน', () => {
  test('ดอกลอยใช้โหมดหักดอกก่อนไม่ได้', async () => {
    const res = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'floating', principal_amount: 1000000,
      num_installments: 12, interest_mode: 'deduct_upfront', interest_rate_bp: 1000,
    });
    assert.equal(res.status, 400);
  });

  test('รียอดแบบสัญญาใหม่เป็นหักดอกก่อน: หักดอกใหม่จากเงินเพิ่ม (สเปกข้อ 26)', async () => {
    // สัญญาเดิมโหมดเหมารวม 2,000@20% จ่าย 10 งวด (1,000) → คงเหลือ 1,400
    const mk = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 24,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0, deduct_first: false,
      start_date: '2030-08-01',
    });
    assert.equal(mk.status, 201);
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 10`, { c: mk.body.contract.id });
    for (const r of inst) {
      await api('owner', 'POST', '/api/payments', { contract_id: mk.body.contract.id, amount_paid: r.due_amount, paid_date: r.due_date });
    }
    // รียอด +1,000 สัญญาใหม่เป็นหักดอกก่อน 10% ของยอดใหม่ 2,400
    const rey = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: mk.body.contract.id, new_money: 100000,
      interest_mode: 'deduct_upfront', interest_rate_bp: 1000,
      num_installments: 24, doc_fee: 0,
    });
    assert.equal(rey.status, 201, JSON.stringify(rey.body));
    const nc = rey.body.new_contract;
    assert.equal(nc.principal_amount, 240000, 'ยอดใหม่ = คงเหลือ 1,400 + เพิ่ม 1,000');
    // ดอกหักก่อนของสัญญาใหม่ = 10% × 2,400 = 240 หักจากเงินเพิ่ม 1,000 → ลูกค้าได้ 760
    assert.equal(rey.body.preview.upfront_interest, 24000);
    assert.equal(rey.body.preview.cash_to_customer, 76000, 'เงินสดเพิ่มจริงหลังหักดอกใหม่');
  });

  test('รียอดไม่เติมเงิน + สัญญาใหม่หักดอกก่อน: หักได้ไม่เกินเงินที่จ่ายจริง (ไม่มีเงินงอก)', async () => {
    const { contract: c } = await makeUpfront({ startDate: '2030-09-01' });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`, { c: c.id });
    for (const r of inst) {
      await api('owner', 'POST', '/api/payments', { contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date });
    }
    const rey = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0,
      interest_mode: 'deduct_upfront', interest_rate_bp: 1000, num_installments: 20, doc_fee: 0,
    });
    assert.equal(rey.status, 201, JSON.stringify(rey.body));
    // เงินเพิ่ม 0 → ไม่มีเงินให้หัก → ดอกหักได้ 0 และไม่บันทึกรายได้ปลอม
    assert.equal(rey.body.preview.upfront_interest, 0, 'ไม่มีเงินจ่ายออกจึงหักไม่ได้');
    assert.equal(rey.body.preview.cash_to_customer, 0);
    assert.ok(rey.body.preview.warnings.some((w) => w.includes('หักดอกก่อนได้')), 'ต้องเตือนว่าหักไม่ครบ');
    const entry = await get(
      `SELECT COALESCE(SUM(amount),0) s FROM income_entries
       WHERE contract_id = :nc AND category = :cat AND is_void = 0`,
      { nc: rey.body.new_contract.id, cat: UPFRONT_INTEREST_CATEGORY },
    );
    assert.equal(Number(entry.s), 0, 'ห้ามบันทึกรายได้ที่ไม่มีเงินสดรองรับ');
  });
});

// =============================================================================
// บั๊กที่พบจากการตรวจแบบปฏิปักษ์ (workflow ยืนยัน 7 ข้อ) — regression กันกลับมา
describe('หักดอกก่อน — บั๊กที่พบจากการตรวจแบบปฏิปักษ์', () => {
  test('ติ๊กตัดเงินต้นบนสัญญาโหมดเหมาถูกปฏิเสธ (กันสัญญาจ่ายครบแต่ปิดไม่ได้)', async () => {
    const { contract: c } = await makeUpfront({ startDate: '2031-01-01', n: 10 });
    // จ่ายครบทั้งสัญญาพร้อม extra_to_principal — เดิมทำให้ค้าง active ตลอดกาล
    const r = await api('owner', 'POST', '/api/payments', {
      contract_id: c.id, amount_paid: 200000, extra_to_principal: true,
    });
    assert.equal(r.status, 400, 'ต้องถูกปฏิเสธ');
    assert.match(r.body.error, /ไม่ต้องใช้ตัวเลือกตัดเงินต้น/);

    // preview ก็ต้องเตือนเหมือนกัน
    const pv = await api('owner', 'POST', '/api/payments/preview', {
      contract_id: c.id, amount_paid: 200000, extra_to_principal: true,
    });
    assert.equal(pv.status, 400);

    // จ่ายก้อนเดียวแบบไม่ติ๊ก → ไหลตัดทุกงวดและปิดสัญญาได้ปกติ
    const ok = await api('owner', 'POST', '/api/payments', {
      contract_id: c.id, amount_paid: 200000,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const st = await get(`SELECT status FROM contracts WHERE id = :c`, { c: c.id });
    assert.equal(st.status, 'completed', 'จ่ายครบแบบปกติต้องปิดสัญญา');
  });

  test('สัญญาเหมารวม (flat) ก็ติ๊กตัดเงินต้นไม่ได้เช่นกัน', async () => {
    const mk = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 24,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0, deduct_first: false,
      start_date: '2031-02-01',
    });
    const r = await api('owner', 'POST', '/api/payments', {
      contract_id: mk.body.contract.id, amount_paid: 240000, extra_to_principal: true,
    });
    assert.equal(r.status, 400);
  });

  test('ดอกลอยยังใช้ตัดเงินต้นได้ตามเดิม (regression)', async () => {
    const mk = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'floating', principal_amount: 1000000,
      installment_amount: 15000, interest_per_inst: 15000, num_installments: 12,
      doc_fee: 0, deduct_first: false, start_date: '2031-03-01',
    });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    // จ่าย 1,150: ดอก 150 + ตัดต้น 1,000
    const r = await api('owner', 'POST', '/api/payments', {
      contract_id: mk.body.contract.id, amount_paid: 115000, extra_to_principal: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.payment.interest_amount, 15000);
    assert.equal(r.body.payment.principal_amount, 100000);
  });

  test('ฐานเต็มยอด (basis=full): เงินสดไม่หายเท่ายอดยกอีกต่อไป — net_cash = กำไร เมื่อจบเชน', async () => {
    // ตั้ง basis เป็น full ชั่วคราว
    const { setSetting } = await import('../src/db/index.js');
    await setSetting('reyod_cash_basis', 'full');
    try {
      const D1 = '2031-04-01';
      const { contract: c } = await makeUpfront({ startDate: D1, n: 10 });
      // จ่าย 5 งวด (1,000) → รียอด basis=full (ยอดยก 1,000)
      const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`, { c: c.id });
      for (const r of inst) {
        await api('owner', 'POST', '/api/payments', { contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date });
      }
      const rey = await api('owner', 'POST', '/api/contracts/reyod', {
        from_contract_id: c.id, new_money: 0, doc_fee: 0,
        interest_rate_bp: 0, num_installments: 10, start_date: '2031-04-20',
      });
      assert.equal(rey.status, 201, JSON.stringify(rey.body));
      const nc = rey.body.new_contract;

      // ขารับคู่ของยอดยกต้องถูกบันทึก (ไม่ใช่รายได้)
      const carryRet = await get(
        `SELECT COALESCE(SUM(amount),0) s FROM income_entries
         WHERE contract_id = :c AND category = 'เงินต้นรับคืนจากการรียอด (ฐานเต็มยอด)' AND is_void = 0`,
        { c: c.id },
      );
      // จ่าย 5 งวด × 200 = 1,000 → ยอดยก = 2,000 − 1,000 = 1,000
      assert.equal(Number(carryRet.s), 100000, 'ขารับ = ยอดยก 1,000');

      // จ่ายสัญญาใหม่จนครบ
      const inst2 = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: nc.id });
      for (const r of inst2) {
        const p = await api('owner', 'POST', '/api/payments', { contract_id: nc.id, amount_paid: r.due_amount, paid_date: r.due_date });
        assert.equal(p.status, 201);
      }

      // invariant ทั้งเชนของสองสัญญานี้: เงินเข้า − เงินออก = กำไรที่รับรู้
      const { financeSummary } = await import('../src/domain/reports.js');
      const s = await financeSummary({ from: D1, to: '2031-12-31' });
      // ทั้งช่วงมีแค่เชนนี้ (วันที่ไม่ชนกับเทสต์อื่น): ปล่อยจริง 1,800, เก็บกลับ 2,000+500
      // กำไร = ดอกหักก่อน 200 · ตรวจว่า net_cash ของช่วง = net_profit ของช่วง
      assert.equal(s.net_cash, s.net_profit,
        `เงินสดสุทธิ (${s.net_cash}) ต้องเท่ากำไร (${s.net_profit}) — ยอดยกห้ามหายจากบัญชี`);
    } finally {
      await setSetting('reyod_cash_basis', 'new_money');
    }
  });
});
