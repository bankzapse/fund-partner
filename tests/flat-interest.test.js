// ดอกเบี้ยเหมารวมคงที่ต่อสัญญา และรายรับ "จ่ายฟรี/พักงวด"
//
// ทดสอบผ่าน API จริงเป็นหลัก เพราะสิ่งที่ต้องพิสูจน์คือพฤติกรรมที่ผู้ใช้เห็น
// ไม่ใช่ว่าฟังก์ชันคืนค่าถูก
process.env.FP_DB_PATH = ':memory:';

import { before, after, describe, it as test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { run, get, all, closeDb } from '../src/db/index.js';
import { hashPassword } from '../src/lib/auth.js';
import { nowISO, today } from '../src/lib/time.js';
import { buildFlatSchedule } from '../src/domain/contracts.js';

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
  return { status: res.status, body: json };
}

async function login(role, username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  sess[role] = (res.headers.get('set-cookie') ?? '').match(/fp_session=([^;]*)/)?.[1] ?? null;
}

before(async () => {
  const app = await createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const now = nowISO();
  for (const [u, role] of [['owner', 'owner'], ['collector', 'collector'], ['other', 'collector']]) {
    await run(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (:u, :h, :u, :r, 1, :now, :now)`,
      { u, h: hashPassword('Pass#12345'), r: role, now },
    );
  }
  await login('owner', 'owner', 'Pass#12345');
  await login('collector', 'collector', 'Pass#12345');
  await login('other', 'other', 'Pass#12345');

  // พนักงานสองคนคนละเขต เพื่อทดสอบว่าบันทึกข้ามเขตไม่ได้
  await run(`INSERT INTO employees (user_id, code, full_name, is_active, created_at, updated_at)
             VALUES (2, 'E0001', 'พนักงาน ก', 1, :now, :now)`, { now });
  await run(`INSERT INTO employees (user_id, code, full_name, is_active, created_at, updated_at)
             VALUES (3, 'E0002', 'พนักงาน ข', 1, :now, :now)`, { now });
  await run(`INSERT INTO debtors (code, full_name, employee_id, status, created_at, updated_at)
             VALUES ('D00001', 'ลูกหนี้ ก', 1, 'normal', :now, :now)`, { now });
});

after(async () => {
  server?.close();
  await closeDb();
});

/** สร้างสัญญาโหมดดอกเหมารวมแล้วคืนตัวสัญญา */
async function makeFlatContract({ principal = 200000, rateBp = 2000, n = 24 } = {}) {
  const res = await api('owner', 'POST', '/api/contracts', {
    debtor_id: 1,
    type: 'daily24',
    principal_amount: principal,
    num_installments: n,
    interest_mode: 'flat_total',
    interest_rate_bp: rateBp,
    doc_fee: 0,
    deduct_first: false,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.contract;
}

describe('ดอกเบี้ยเหมารวมคงที่ต่อสัญญา', () => {
  test('ตัวอย่างตามข้อกำหนด: กู้ 2,000 ดอก 20% 24 งวด → ยอดรวม 2,400 งวดละ 100', async () => {
    const c = await makeFlatContract();
    assert.equal(c.total_due, 240000, 'ยอดหนี้รวมต้องเป็น 2,400 บาท');
    assert.equal(c.installment_amount, 10000, 'ค่างวดต้องเป็น 100 บาท');
    assert.equal(c.interest_mode, 'flat_total');
    assert.equal(c.interest_rate_bp, 2000);

    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id });
    assert.equal(inst.length, 24);
    assert.ok(inst.every((r) => r.due_amount === 10000), 'ทุกงวดต้องเป็น 100 บาทเท่ากัน');
  });

  test('ผลรวมของตารางงวดต้องตรงเป๊ะทั้งสามฝั่ง ไม่มีเศษหล่น', async () => {
    // ถ้าผลรวมเงินต้นต่างจากสัญญาแม้สตางค์เดียว สัญญาจะปิดเป็น "ครบสัญญา" ไม่ได้เลย
    const c = await makeFlatContract({ principal: 105000, rateBp: 2000, n: 24 });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c`, { c: c.id });
    const sumDue = inst.reduce((s, r) => s + r.due_amount, 0);
    const sumInt = inst.reduce((s, r) => s + r.interest_due, 0);
    const sumPri = inst.reduce((s, r) => s + r.principal_due, 0);

    assert.equal(sumPri, 105000, 'ผลรวมเงินต้นรายงวดต้องเท่าเงินต้นตามสัญญา');
    assert.equal(sumInt, 21000, 'ผลรวมดอกต้องเท่ากับ 20% ของเงินต้น');
    assert.equal(sumDue, 126000, 'ผลรวมค่างวดต้องเท่ายอดหนี้รวม');
    assert.equal(sumDue, c.total_due);
  });

  test('ทุกงวด ดอก + ต้น ต้องเท่ากับค่างวด (ข้อบังคับของฐานข้อมูล)', async () => {
    const c = await makeFlatContract({ principal: 333300, rateBp: 1500, n: 30 });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c`, { c: c.id });
    for (const r of inst) {
      assert.equal(r.interest_due + r.principal_due, r.due_amount, `งวดที่ ${r.seq} แยกยอดไม่ลงตัว`);
      assert.ok(r.interest_due >= 0 && r.principal_due >= 0, `งวดที่ ${r.seq} มีค่าติดลบ`);
    }
  });

  test('ค่างวดเป็นบาทถ้วนเสมอ ยกเว้นงวดสุดท้ายที่รับเศษ', async () => {
    // พนักงานเก็บเงินสดหน้างาน ถ้าเป็นเศษสตางค์จะปัดเอง แล้วยอดจะเพี้ยน
    const c = await makeFlatContract({ principal: 105000, rateBp: 2000, n: 24 });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id });
    for (const r of inst.slice(0, -1)) {
      assert.equal(r.due_amount % 100, 0, `งวดที่ ${r.seq} ไม่เป็นบาทถ้วน`);
    }
    assert.equal(inst.at(-1).due_amount % 100, 0, 'งวดสุดท้ายก็ควรเป็นบาทถ้วน');
  });

  test('เตือนเมื่องวดสุดท้ายไม่เท่างวดอื่น จะได้ไม่ไปเก็บผิดยอด', async () => {
    const res = await api('owner', 'POST', '/api/contracts/preview', {
      debtor_id: 1, type: 'daily24', principal_amount: 105000, num_installments: 24,
      interest_mode: 'flat_total', interest_rate_bp: 2000, doc_fee: 0,
    });
    assert.equal(res.status, 200);
    const w = res.body.preview.warnings.join(' ');
    assert.match(w, /งวดสุดท้าย/, 'ต้องเตือนเรื่องงวดสุดท้าย');
  });

  test('สัญญาโหมดเดิมยังทำงานเหมือนเดิมทุกอย่าง', async () => {
    const res = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 100000,
      installment_amount: 5000, interest_per_inst: 2000, num_installments: 24,
      doc_fee: 10000, deduct_first: true,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.contract.interest_mode, 'per_installment', 'ไม่ระบุโหมด = โหมดเดิม');
    assert.equal(res.body.contract.interest_rate_bp, 0);
  });

  test('รียอดสืบทอดโหมดและอัตราจากสัญญาเดิม ไม่ถอยกลับไปโหมดเก่า', async () => {
    const c = await makeFlatContract({ principal: 100000, rateBp: 2000, n: 24 });
    const res = await api('owner', 'POST', '/api/contracts/reyod/preview', {
      from_contract_id: c.id, new_money: 0,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.preview.preview.interestMode, 'flat_total');
    assert.equal(res.body.preview.preview.interestRateBp, 2000);
  });

  test('ดอกลอยยังใช้โหมดเหมารวมไม่ได้ ต้องบอกเหตุผลชัดเจน', async () => {
    const res = await api('owner', 'POST', '/api/contracts/preview', {
      debtor_id: 1, type: 'floating', principal_amount: 100000, num_installments: 12,
      interest_mode: 'flat_total', interest_rate_bp: 2000,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ดอกลอย/);
  });

  test('เงินต้นน้อยเกินไปเทียบกับจำนวนงวด ต้องปฏิเสธ ไม่ใช่สร้างตารางที่มีงวด 0 บาท', async () => {
    // ถ้าปล่อยผ่าน จะได้ตาราง 23 งวดเป็น 0 บาท แล้วไปกองที่งวดสุดท้ายงวดเดียว
    // ผลรวมถูกทางคณิตศาสตร์ แต่ใช้เก็บเงินจริงไม่ได้เลย
    const res = await api('owner', 'POST', '/api/contracts/preview', {
      debtor_id: 1, type: 'daily24', principal_amount: 500, num_installments: 24,
      interest_mode: 'flat_total', interest_rate_bp: 2000,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ค่างวดต่ำกว่า 1 บาท/);
  });

  test('อัตราดอกเบี้ยเกินช่วงที่รับได้ ต้องถูกปฏิเสธ', async () => {
    for (const bp of [-100, 200000]) {
      const res = await api('owner', 'POST', '/api/contracts/preview', {
        debtor_id: 1, type: 'daily24', principal_amount: 100000, num_installments: 24,
        interest_mode: 'flat_total', interest_rate_bp: bp,
      });
      assert.equal(res.status, 400, `อัตรา ${bp} ควรถูกปฏิเสธ`);
    }
  });
});

describe('รายรับ จ่ายฟรี/พักงวด', () => {
  test('บันทึกได้ และไม่แตะยอดสัญญาเลย', async () => {
    const c = await makeFlatContract();
    const before = await get(`SELECT * FROM contracts WHERE id = :i`, { i: c.id });

    const res = await api('owner', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 4000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const after = await get(`SELECT * FROM contracts WHERE id = :i`, { i: c.id });
    assert.equal(after.principal_remaining, before.principal_remaining, 'ห้ามตัดเงินต้น');
    assert.equal(after.total_due, before.total_due, 'ห้ามลดยอดหนี้ตามสัญญา');
    assert.equal(after.num_installments, before.num_installments, 'ห้ามลดจำนวนงวด');
    assert.equal(after.status, 'active');
  });

  test('ไม่ไปโผล่ในตารางรับชำระ จึงไม่กระทบยอดเก็บได้และยอดค้าง', async () => {
    const c = await makeFlatContract();
    await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });

    const pays = await all(`SELECT * FROM payments WHERE contract_id = :c`, { c: c.id });
    assert.equal(pays.length, 0, 'ต้องไม่มีรายการในตารางรับชำระ');

    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c`, { c: c.id });
    assert.ok(inst.every((r) => r.interest_paid === 0 && r.principal_paid === 0), 'ห้ามตัดงวดใด ๆ');
    assert.ok(inst.every((r) => r.status === 'pending'), 'ทุกงวดต้องยังรอชำระ');
  });

  test('เก็บเป็นรายรับคนละหมวดกับดอกเบี้ยตามสัญญา', async () => {
    const c = await makeFlatContract();
    await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    const row = await get(
      `SELECT * FROM income_entries WHERE contract_id = :c ORDER BY id DESC`, { c: c.id },
    );
    assert.equal(row.amount, 4000);
    assert.equal(row.category, 'จ่ายฟรี/พักงวด');
    assert.equal(row.debtor_id, 1, 'ต้องผูกกับลูกหนี้ด้วย เพื่อดูย้อนหลังได้');
  });

  test('กันบันทึกซ้ำวันเดียวกัน เพราะรายการนี้ไม่โผล่ในประวัติรับชำระ', async () => {
    const c = await makeFlatContract();
    const first = await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    assert.equal(first.status, 201);
    const dup = await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    assert.equal(dup.status, 400, 'ครั้งที่สองในวันเดียวกันต้องเตือน');
    assert.match(dup.body.error, /บันทึกจ่ายฟรีของสัญญานี้ไปแล้ว/);

    // ยืนยันแล้วบันทึกซ้ำได้ เผื่อลูกค้าจ่ายสองรอบจริง ๆ
    const forced = await api('owner', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 2000, allow_duplicate: true,
    });
    assert.equal(forced.status, 201);
  });

  test('พนักงานเก็บเงินบันทึกได้ เพราะเป็นคนกดหน้างานจริง', async () => {
    const c = await makeFlatContract();
    const res = await api('collector', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 4000,
    });
    assert.equal(res.status, 201, 'พนักงานเก็บเงินต้องบันทึกได้');
  });

  test('พนักงานคนอื่นบันทึกข้ามเขตไม่ได้', async () => {
    const c = await makeFlatContract();
    const res = await api('other', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 4000,
    });
    assert.equal(res.status, 403, 'ลูกหนี้รายนี้ไม่ใช่ของพนักงานคนนี้');
  });

  test('สัญญาที่ปิดแล้วบันทึกจ่ายฟรีไม่ได้', async () => {
    const c = await makeFlatContract();
    await run(`UPDATE contracts SET status = 'completed' WHERE id = :i`, { i: c.id });
    const res = await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ปิดไปแล้ว/);
  });

  test('จำนวนเงินต้องมากกว่า 0', async () => {
    const c = await makeFlatContract();
    for (const amt of [0, -100]) {
      const res = await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: amt });
      assert.equal(res.status, 400, `จำนวน ${amt} ควรถูกปฏิเสธ`);
    }
  });

  test('ดูรายการจ่ายฟรีของสัญญาได้ เพื่อไม่ให้พนักงานบันทึกซ้ำโดยไม่รู้', async () => {
    const c = await makeFlatContract();
    await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    const res = await api('owner', 'GET', `/api/payments/free/${c.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].amount, 4000);
  });

  test('บันทึกลง Audit Log เพื่อตรวจย้อนหลังได้', async () => {
    const c = await makeFlatContract();
    await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    const rows = await all(`SELECT * FROM audit_logs WHERE entity = 'free_payment' ORDER BY id DESC`);
    assert.ok(rows.length > 0, 'ต้องมีร่องรอย');
  });
});

describe('สูตรกระจายยอด', () => {
  test('ผลรวมตรงเป๊ะทุกกรณีที่เป็นไปได้จริงในธุรกิจ', () => {
    let checked = 0;
    for (let baht = 100; baht <= 50000; baht += 700) {
      for (const bp of [1000, 1500, 2000, 2500, 3000]) {
        for (const n of [12, 24, 30, 40, 60]) {
          const p = baht * 100;
          const r = buildFlatSchedule({
            type: 'daily24', startDate: '2026-01-01',
            numInstallments: n, principalAmount: p, interestRateBp: bp,
          });
          checked++;
          assert.equal(r.rows.reduce((s, x) => s + x.due_amount, 0), r.totalDue);
          assert.equal(r.rows.reduce((s, x) => s + x.interest_due, 0), r.interestTotal);
          assert.equal(r.rows.reduce((s, x) => s + x.principal_due, 0), p);
        }
      }
    }
    assert.ok(checked > 1000, `ทดสอบน้อยเกินไป (${checked} ชุด)`);
  });
});

describe('บั๊กที่พบจากการตรวจแบบปฏิปักษ์ (กันย้อนกลับ)', () => {
  test('ทุกงวดเป็นบาทถ้วน แม้ดอกคำนวณแล้วมีเศษสตางค์', async () => {
    // เงินต้น 3,333 ดอก 15% = 499.95 บาท ถ้าไม่ปัดดอกเป็นบาทถ้วน
    // งวดสุดท้ายจะมีเศษสตางค์ แล้วสัญญาจะปิดไม่ได้ตลอดไป
    const c = await makeFlatContract({ principal: 333300, rateBp: 1500, n: 30 });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id });
    for (const r of inst) {
      assert.equal(r.due_amount % 100, 0, `งวดที่ ${r.seq} มีเศษสตางค์ = เก็บเงินสดจริงไม่ได้`);
    }
    assert.equal(c.total_due % 100, 0, 'ยอดหนี้รวมต้องเป็นบาทถ้วน');
  });

  test('สัญญาโหมดเหมารวมต้องปิดเป็นครบสัญญาได้จริงเมื่อจ่ายครบ', async () => {
    // บั๊กเดิม: เหลือเศษสตางค์ค้าง เงินต้นคงเหลือไม่เป็น 0 สัญญาจึงค้าง active ตลอดไป
    const c = await makeFlatContract({ principal: 333300, rateBp: 1500, n: 30 });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id });
    for (const r of inst) {
      const res = await api('owner', 'POST', '/api/payments', {
        contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date,
      });
      assert.equal(res.status, 201, `งวดที่ ${r.seq} บันทึกไม่ได้: ${JSON.stringify(res.body)}`);
    }
    const after = await get(`SELECT * FROM contracts WHERE id = :i`, { i: c.id });
    assert.equal(after.principal_remaining, 0, 'เงินต้นต้องเหลือ 0 พอดี');
    assert.equal(after.status, 'completed', 'สัญญาต้องปิดเป็นครบสัญญา');
  });

  test('มีงวดเดียว ค่างวดที่บันทึกต้องตรงกับตารางงวดจริง', async () => {
    const c = await makeFlatContract({ principal: 100000, rateBp: 333, n: 1 });
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c`, { c: c.id });
    assert.equal(c.installment_amount, inst[0].due_amount, 'ค่างวดในสัญญาต้องเท่ายอดในตาราง');
  });

  test('จ่ายฟรีต้องติดด่านปิดยอดประจำวันเหมือนการรับชำระปกติ', async () => {
    const c = await makeFlatContract();
    const d = today();
    await api('owner', 'POST', '/api/cashbook/closing', { closing_date: d, actual_cash: 0 });
    const res = await api('collector', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 4000, paid_date: d,
    });
    assert.equal(res.status, 400, 'วันที่ปิดยอดแล้วต้องบันทึกไม่ได้');
    assert.match(res.body.error, /ปิดยอดประจำวันแล้ว/);
    await run(`DELETE FROM daily_closings WHERE closing_date = :d`, { d });
  });

  test('จ่ายฟรีรับวันที่ล่วงหน้าหรือก่อนเริ่มสัญญาไม่ได้', async () => {
    const c = await makeFlatContract();
    const future = await api('owner', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 4000, paid_date: '2099-12-31',
    });
    assert.equal(future.status, 400);
    assert.match(future.body.error, /ล่วงหน้า/);

    const past = await api('owner', 'POST', '/api/payments/free', {
      contract_id: c.id, amount: 4000, paid_date: '1990-01-01',
    });
    assert.equal(past.status, 400);
    assert.match(past.body.error, /ก่อนวันเริ่มสัญญา/);
  });

  test('พักงวดต้องเลื่อนวันครบกำหนดจริง ไม่ใช่ปล่อยให้ค้าง', async () => {
    const c = await makeFlatContract();
    const before = await all(
      `SELECT seq, due_date FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id },
    );
    const res = await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    assert.equal(res.status, 201);
    assert.ok(res.body.entry.installments_shifted > 0, 'ต้องรายงานว่าเลื่อนไปกี่งวด');

    const after = await all(
      `SELECT seq, due_date FROM installments WHERE contract_id = :c ORDER BY seq`, { c: c.id },
    );
    assert.notEqual(after[0].due_date, before[0].due_date, 'งวดแรกต้องถูกเลื่อน');

    // ยอดหนี้และจำนวนงวดต้องไม่เปลี่ยน — พักคือเลื่อน ไม่ใช่ลด
    const ct = await get(`SELECT * FROM contracts WHERE id = :i`, { i: c.id });
    assert.equal(ct.total_due, c.total_due);
    assert.equal(ct.num_installments, c.num_installments);
    assert.equal(after.length, before.length);
  });

  test('รายรับจ่ายฟรีต้องไม่รั่วไปโผล่ในรายงานของพนักงานคนอื่น', async () => {
    const c = await makeFlatContract();
    await api('owner', 'POST', '/api/payments/free', { contract_id: c.id, amount: 4000 });
    const d = today();
    const { financeSummary } = await import('../src/domain/reports.js');
    const mine = await financeSummary({ from: d, to: d, employeeId: 1 });
    const other = await financeSummary({ from: d, to: d, employeeId: 2 });
    assert.ok(mine.other_income > 0, 'พนักงานเจ้าของสัญญาต้องเห็น');
    assert.equal(other.other_income, 0, 'พนักงานคนอื่นต้องไม่เห็น');
  });

  test('เตือนเมื่องวดแรกที่หักมากกว่าเงินที่ปล่อยจริง', async () => {
    const res = await api('owner', 'POST', '/api/contracts/preview', {
      debtor_id: 1, type: 'daily24', principal_amount: 200000, num_installments: 2,
      interest_mode: 'flat_total', interest_rate_bp: 100000, doc_fee: 0, deduct_first: true,
    });
    assert.equal(res.status, 200);
    assert.match(res.body.preview.warnings.join(' '), /มากกว่าเงินที่จ่ายออกจริง/);
  });

  test('ฐานข้อมูลเดิมที่ยังไม่มีคอลัมน์ใหม่ ต้องอัปเกรดได้', async () => {
    // ถ้าไม่มีบล็อก ALTER ในไฟล์โครงสร้าง production จะสร้างสัญญาไม่ได้เลย
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    assert.match(sql, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS interest_mode/);
    assert.match(sql, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS interest_rate_bp/);
    assert.match(sql, /ALTER TABLE contracts ADD COLUMN IF NOT EXISTS total_due/);
  });
});

describe('เฟส 2 — รียอดยกยอดคงเหลือสัญญาเดิม', () => {
  /** สร้างสัญญา จ่ายไป n งวด แล้วคืนสัญญา */
  async function payInstallments(contractId, count) {
    const inst = await all(
      `SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT :n`,
      { c: contractId, n: count },
    );
    for (const r of inst) {
      const res = await api('owner', 'POST', '/api/payments', {
        contract_id: contractId, amount_paid: r.due_amount, paid_date: r.due_date,
      });
      assert.equal(res.status, 201, `งวดที่ ${r.seq}: ${JSON.stringify(res.body)}`);
    }
  }

  test('ตัวอย่างตามข้อกำหนด: ยอดรวม 2,400 ชำระ 1,000 → ยกยอด 1,400', async () => {
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    await payInstallments(c.id, 10);   // 10 งวด × 100 = 1,000 บาท

    const res = await api('owner', 'POST', '/api/contracts/reyod/preview', {
      from_contract_id: c.id, new_money: 0,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.preview.carried_outstanding, 140000, 'ต้องยกยอด 1,400 ไม่ใช่เงินต้นคงเหลือ');
  });

  test('ยอดที่ยกไปต้องไม่ตัดดอกเบี้ยที่ยังไม่ถึงงวดออก', async () => {
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    await payInstallments(c.id, 10);
    const contract = await get(`SELECT * FROM contracts WHERE id = :i`, { i: c.id });
    const paid = await get(
      `SELECT COALESCE(SUM(amount_paid),0) p FROM payments WHERE contract_id = :i AND is_void = 0`,
      { i: c.id },
    );
    const res = await api('owner', 'POST', '/api/contracts/reyod/preview', {
      from_contract_id: c.id, new_money: 0,
    });
    // ยอดยก = ยอดหนี้รวม − ชำระสะสม ตรง ๆ ไม่ใช่เงินต้นคงเหลือ
    assert.equal(res.body.preview.carried_outstanding, contract.total_due - Number(paid.p));
    assert.notEqual(
      res.body.preview.carried_outstanding, contract.principal_remaining,
      'ต้องต่างจากเงินต้นคงเหลือ ไม่งั้นแปลว่ายังใช้สูตรเก่า',
    );
  });

  test('เติมเงินใหม่: ฐานสัญญาใหม่ = ยอดคงเหลือเดิม + เงินเพิ่ม', async () => {
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    await payInstallments(c.id, 10);
    const res = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 60000, deduct_first: false, doc_fee: 0,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const nc = res.body.new_contract;
    assert.equal(nc.principal_amount, 140000 + 60000, 'ฐาน = 1,400 + 600 = 2,000');
    assert.equal(nc.total_due, 200000 + 40000, 'ดอกใหม่คิดจากฐานใหม่ทั้งก้อน');
  });

  test('เงินไม่หายไปจากรายงาน — ดอกที่รับรู้รวมต้องเท่ากำไรจริง', async () => {
    // นี่คือค่าคงที่ที่สำคัญที่สุดของเฟส 2
    // ยอดที่ยกไปกลายเป็น "เงินต้น" ของสัญญาใหม่ ซึ่งเงินต้นรับคืนไม่ใช่รายได้
    // ถ้าไม่รับรู้ดอกเดิม ณ วันรียอด ดอกก้อนนั้นจะหายจากรายงานตลอดกาล
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    await payInstallments(c.id, 10);

    const res = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0, deduct_first: false, doc_fee: 0,
    });
    assert.equal(res.status, 201);
    const nc = res.body.new_contract;

    // จ่ายสัญญาใหม่จนครบ
    const inst = await all(`SELECT * FROM installments WHERE contract_id = :c ORDER BY seq`, { c: nc.id });
    for (const r of inst) {
      const p = await api('owner', 'POST', '/api/payments', {
        contract_id: nc.id, amount_paid: r.due_amount, paid_date: r.due_date,
      });
      assert.equal(p.status, 201);
    }

    const cash = await get(`SELECT COALESCE(SUM(amount_paid),0) s FROM payments WHERE is_void = 0
                            AND contract_id IN (:a, :b)`, { a: c.id, b: nc.id });
    const intFromPayments = await get(`SELECT COALESCE(SUM(interest_amount),0) s FROM payments
                                       WHERE is_void = 0 AND contract_id IN (:a, :b)`, { a: c.id, b: nc.id });
    const intAtReyod = await get(
      `SELECT COALESCE(SUM(amount),0) s FROM income_entries
       WHERE category = 'ดอกเบี้ยรับรู้ตอนรียอด' AND contract_id = :a`, { a: c.id },
    );

    const realProfit = Number(cash.s) - 200000;              // เก็บกลับ − เงินสดที่ปล่อยไป
    const recognised = Number(intFromPayments.s) + Number(intAtReyod.s);
    assert.equal(recognised, realProfit, 'ดอกที่รับรู้รวมต้องเท่ากำไรจริงเป๊ะ ไม่มีตกหล่น');

    const after = await get(`SELECT status FROM contracts WHERE id = :i`, { i: nc.id });
    assert.equal(after.status, 'completed', 'สัญญาใหม่ต้องปิดได้');
  });

  test('บันทึกไว้ว่ายอดที่ยกไปเป็นเงินต้นเท่าไร ดอกเท่าไร เพื่อตรวจย้อนหลัง', async () => {
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    await payInstallments(c.id, 10);
    await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0, deduct_first: false, doc_fee: 0,
    });
    const link = await get(`SELECT * FROM contract_links WHERE from_contract_id = :i`, { i: c.id });
    assert.ok(link.carried_interest > 0, 'ต้องบันทึกดอกที่ยกไปด้วย');
    assert.equal(
      link.carried_principal + link.carried_interest, 140000,
      'เงินต้นที่ยก + ดอกที่ยก ต้องเท่ายอดคงเหลือทั้งก้อน',
    );
  });

  test('สัญญาโหมดเดิมยังยกเงินต้นคงเหลือเหมือนเดิม ไม่เปลี่ยนพฤติกรรม', async () => {
    const res = await api('owner', 'POST', '/api/contracts', {
      debtor_id: 1, type: 'daily24', principal_amount: 100000,
      installment_amount: 5000, interest_per_inst: 2000, num_installments: 24,
      doc_fee: 0, deduct_first: false,
    });
    assert.equal(res.status, 201);
    const c = res.body.contract;
    const prev = await api('owner', 'POST', '/api/contracts/reyod/preview', {
      from_contract_id: c.id, new_money: 0,
    });
    assert.equal(prev.status, 200);
    assert.equal(
      prev.body.preview.carried_outstanding, c.principal_remaining,
      'โหมดเดิมต้องยกเงินต้นคงเหลือ ไม่ใช่ยอดหนี้รวม',
    );
  });
});

describe('เฟส 2 — บั๊กที่พบจากการตรวจแบบปฏิปักษ์', () => {
  test('ดอกที่รับรู้ตอนรียอดต้องไม่ถูกนับเป็นเงินสด', async () => {
    // เป็นรายการทางบัญชีล้วน ลูกหนี้ไม่ได้จ่ายเงินเข้ามา
    // ถ้านับรวมในกระแสเงินสด ปิดยอดประจำวันจะขาดทุกครั้งที่รียอด
    const { financeSummary } = await import('../src/domain/reports.js');
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    const inst = await all(
      `SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 10`, { c: c.id },
    );
    for (const r of inst) {
      await api('owner', 'POST', '/api/payments', {
        contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date,
      });
    }
    const d = today();
    const before = await financeSummary({ from: d, to: d });
    const res = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0, deduct_first: false, doc_fee: 0, start_date: d,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const after = await financeSummary({ from: d, to: d });

    assert.equal(after.total_in, before.total_in, 'เงินสดเข้าต้องไม่เปลี่ยน');
    assert.equal(after.net_cash, before.net_cash, 'เงินสดสุทธิต้องไม่เปลี่ยน');
    assert.ok(after.net_profit > before.net_profit, 'แต่กำไรต้องเพิ่มขึ้น');
    assert.ok(after.reyod_interest_income > 0, 'ต้องแยกยอดนี้ออกมาให้เห็น');
  });

  test('ยกเลิกรายการดอกที่รับรู้ตอนรียอดจากสมุดเงินสดไม่ได้', async () => {
    // ถ้ายกเลิกได้ ดอกก้อนนั้นหายจากรายงานถาวร ทั้งที่หนี้ยังอยู่ในสัญญาใหม่
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    const inst = await all(
      `SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`, { c: c.id },
    );
    for (const r of inst) {
      await api('owner', 'POST', '/api/payments', {
        contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date,
      });
    }
    await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0, deduct_first: false, doc_fee: 0,
    });
    const entry = await get(
      `SELECT * FROM income_entries WHERE category = 'ดอกเบี้ยรับรู้ตอนรียอด'
       ORDER BY id DESC`,
    );
    assert.ok(entry, 'ต้องมีรายการนี้');
    const res = await api('owner', 'POST', `/api/cashbook/income/${entry.id}/void`, {
      reason: 'ลองยกเลิก',
    });
    assert.equal(res.status, 400, 'ต้องยกเลิกไม่ได้');
    assert.match(res.body.error, /ยกเลิกเดี่ยวไม่ได้/);
  });

  test('รายการดอกรียอดลงวันที่ของสัญญาใหม่ ไม่ใช่วันนี้', async () => {
    const c = await makeFlatContract({ principal: 200000, rateBp: 2000, n: 24 });
    const inst = await all(
      `SELECT * FROM installments WHERE contract_id = :c ORDER BY seq LIMIT 5`, { c: c.id },
    );
    for (const r of inst) {
      await api('owner', 'POST', '/api/payments', {
        contract_id: c.id, amount_paid: r.due_amount, paid_date: r.due_date,
      });
    }
    const startDate = '2026-07-05';
    const res = await api('owner', 'POST', '/api/contracts/reyod', {
      from_contract_id: c.id, new_money: 0, deduct_first: false, doc_fee: 0, start_date: startDate,
    });
    assert.equal(res.status, 201);
    const entry = await get(
      `SELECT * FROM income_entries WHERE category = 'ดอกเบี้ยรับรู้ตอนรียอด' ORDER BY id DESC`,
    );
    assert.equal(entry.entry_date, startDate, 'ต้องลงวันเดียวกับสัญญาใหม่');
  });
});
