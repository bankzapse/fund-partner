import { rmSync, existsSync } from 'node:fs';
import { db, get, run, insert, all, pgliteDir, databaseUrl, setSetting, closeDb } from './index.js';
import { hashPassword } from '../lib/auth.js';
import { nowISO, today, addDays } from '../lib/time.js';
import { createContract } from '../domain/contracts.js';
import { recordPayment } from '../domain/payments.js';

const RESET = process.argv.includes('--reset');
const DEMO = process.argv.includes('--demo') || RESET;

/**
 * โหมดใช้งานจริง: สร้างเฉพาะบัญชีเจ้าของ โดยใช้รหัสผ่านที่ผู้ใช้กำหนดเอง
 * ไม่สร้างบัญชีตัวอย่างและไม่ใช้รหัสผ่านตั้งต้นที่เปิดเผยอยู่ใน repo สาธารณะ
 */
const MINIMAL = process.argv.includes('--minimal') || process.env.FP_SEED_MINIMAL === '1';
const OWNER_PASSWORD = process.env.FP_OWNER_PASSWORD || null;

if (MINIMAL && !OWNER_PASSWORD) {
  console.error('โหมด --minimal ต้องกำหนด FP_OWNER_PASSWORD ด้วย');
  process.exit(1);
}

const TARGET = databaseUrl() ? 'Supabase (DATABASE_URL)' : pgliteDir();

if (RESET) {
  if (databaseUrl()) {
    // ฐานข้อมูลบนคลาวด์: ล้างเฉพาะตาราง ไม่ลบทั้งฐาน
    await db();
    await run(`TRUNCATE TABLE
      audit_logs, approvals, daily_closings, income_entries, expenses, payments,
      installments, contract_links, contracts, debtor_documents, debtors,
      employees, sessions, users, settings, counters
      RESTART IDENTITY CASCADE`);
    console.log('ล้างข้อมูลเดิมบน Supabase แล้ว');
  } else {
    const dir = pgliteDir();
    if (dir !== ':memory:' && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    console.log('ลบฐานข้อมูลเดิมในเครื่องแล้ว');
  }
}

await db();

/** ผู้ใช้เริ่มต้นครบทุกตำแหน่งตามตารางสิทธิ์ ข้อ 12 */
const DEFAULT_USERS = [
  { username: 'owner', password: 'owner1234', full_name: 'เจ้าของกิจการ', role: 'owner' },
  { username: 'manager', password: 'manager1234', full_name: 'ผู้จัดการสาขา', role: 'manager' },
  { username: 'collector', password: 'collect1234', full_name: 'สมชาย เก็บเงิน', role: 'collector' },
  { username: 'account', password: 'account1234', full_name: 'ฝ่ายบัญชี', role: 'accountant' },
];

export async function seedUsers() {
  const now = nowISO();

  // โหมดใช้งานจริง: บัญชีเจ้าของบัญชีเดียว รหัสผ่านที่ผู้ใช้กำหนด
  const users = MINIMAL
    ? [{ username: 'owner', password: OWNER_PASSWORD, full_name: 'เจ้าของกิจการ', role: 'owner' }]
    : DEFAULT_USERS.map((u) =>
        u.role === 'owner' && OWNER_PASSWORD ? { ...u, password: OWNER_PASSWORD } : u,
      );

  for (const u of users) {
    if (await get(`SELECT id FROM users WHERE username = :u`, { u: u.username })) continue;
    await run(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (:u, :h, :name, :role, 1, :now, :now)`,
      { u: u.username, h: hashPassword(u.password), name: u.full_name, role: u.role, now },
    );
    // ไม่พิมพ์รหัสผ่านออกมาถ้าเป็นรหัสที่ผู้ใช้กำหนดเอง
    const shown = u.password === OWNER_PASSWORD ? '(รหัสผ่านที่คุณกำหนด)' : u.password;
    console.log(`สร้างผู้ใช้ ${u.username} / ${shown}`);
  }

  if (MINIMAL) return; // ไม่สร้างพนักงานตัวอย่างในโหมดใช้งานจริง

  // ผูกพนักงานเก็บเงินกับผู้ใช้ เพื่อให้เห็นเฉพาะลูกหนี้ที่ตนดูแล (ข้อ 12)
  const collectorUser = await get(`SELECT id FROM users WHERE username = 'collector'`);
  if (collectorUser && !(await get(`SELECT id FROM employees WHERE user_id = :uid`, { uid: collectorUser.id }))) {
    const now2 = nowISO();
    await run(
      `INSERT INTO employees (user_id, code, full_name, phone, area, is_active, created_at, updated_at)
       VALUES (:uid, 'E001', 'สมชาย เก็บเงิน', '081-000-0001', 'สายเหนือ', 1, :now, :now)`,
      { uid: collectorUser.id, now: now2 },
    );
    await run(
      `INSERT INTO employees (code, full_name, phone, area, is_active, created_at, updated_at)
       VALUES ('E002', 'สมหญิง เก็บเงิน', '081-000-0002', 'สายใต้', 1, :now, :now)`,
      { now: now2 },
    );
    console.log('สร้างพนักงาน E001, E002');
  }
}

export async function seedDemo() {
  if (await get(`SELECT id FROM debtors LIMIT 1`)) {
    console.log('มีข้อมูลลูกหนี้อยู่แล้ว — ข้ามการสร้างข้อมูลตัวอย่าง');
    return;
  }
  const owner = await get(`SELECT * FROM users WHERE username = 'owner'`);
  const ctx = { user: owner, ip: '127.0.0.1' };
  const emp1 = (await get(`SELECT id FROM employees WHERE code = 'E001'`)).id;
  const emp2 = (await get(`SELECT id FROM employees WHERE code = 'E002'`)).id;
  const now = nowISO();

  const people = [
    ['D00001', 'สมศรี ใจดี', '081-111-1111', 'กรุงเทพฯ', emp1],
    ['D00002', 'มานะ อดทน', '082-222-2222', 'นนทบุรี', emp1],
    ['D00003', 'ปรีชา ขยัน', '083-333-3333', 'ปทุมธานี', emp2],
    ['D00004', 'วิภา รักงาน', '084-444-4444', 'สมุทรปราการ', emp2],
  ];
  const debtorIds = [];
  for (const [code, name, phone, addr, emp] of people) {
    const newId = await insert(
      `INSERT INTO debtors (code, full_name, phone, address, employee_id, status, created_at, updated_at)
       VALUES (:code, :name, :phone, :addr, :emp, 'normal', :now, :now)`,
      { code, name, phone, addr, emp, now },
    );
    debtorIds.push(newId);
  }

  // เงินทุนตั้งต้นของกิจการ (ไม่ใช่รายได้ — เป็นการนำทุนเข้า)
  await run(
    `INSERT INTO income_entries (entry_date, category, amount, description, created_by, created_at)
     VALUES (:d, 'capital', 5000000, 'เงินทุนตั้งต้นของกิจการ', :uid, :now)`,
    { d: addDays(today(), -60), uid: owner.id, now },
  );

  // เดินตัวนับรหัสลูกหนี้ให้ตรงกับข้อมูลตัวอย่างที่เพิ่งใส่ไป
  await run(
    `INSERT INTO counters (name, value) VALUES ('debtor', :v)
     ON CONFLICT (name) DO UPDATE SET value = GREATEST(counters.value, :v)`,
    { v: people.length },
  );

  const collectorUser = await get(`SELECT * FROM users WHERE username = 'collector'`);

  const start = addDays(today(), -10);

  // สัญญารายวัน 24 งวด: เงินต้น 1,000 ค่างวด 50 (ดอก 20 + ต้น 30) ตามตัวอย่าง SRS ข้อ 3.1/7.2
  const c1 = await createContract(
    {
      debtorId: debtorIds[0],
      employeeId: emp1,
      type: 'daily24',
      principalAmount: 100000,
      installmentAmount: 5000,
      interestPerInst: 2000,
      numInstallments: 24,
      startDate: start,
    },
    ctx,
  );

  const c2 = await createContract(
    {
      debtorId: debtorIds[1],
      employeeId: emp1,
      type: 'daily24',
      principalAmount: 200000,
      installmentAmount: 10000,
      interestPerInst: 4000,
      numInstallments: 24,
      startDate: addDays(today(), -6),
    },
    ctx,
  );

  // สัญญารายเดือน
  await createContract(
    {
      debtorId: debtorIds[2],
      employeeId: emp2,
      type: 'monthly',
      principalAmount: 1000000,
      installmentAmount: 120000,
      interestPerInst: 20000,
      numInstallments: 10,
      startDate: addDays(today(), -40),
    },
    ctx,
  );

  // สัญญาดอกลอย
  await createContract(
    {
      debtorId: debtorIds[3],
      employeeId: emp2,
      type: 'floating',
      principalAmount: 500000,
      installmentAmount: 0,
      interestPerInst: 25000,
      numInstallments: 12,
      startDate: addDays(today(), -35),
    },
    ctx,
  );

  // จำลองการเก็บเงินหลายรูปแบบ: เต็มงวด / เฉพาะดอก / บางส่วน / ไม่จ่าย
  const pattern = [5000, 5000, 2000, 3000, 5000, 0, 5000, 2000];
  for (let i = 1; i <= 8; i++) {
    const amount = pattern[i - 1];
    if (amount === 0) continue;
    await recordPayment(
      { contractId: c1.contract.id, amountPaid: amount, paidDate: addDays(start, i) },
      { user: collectorUser, ip: '127.0.0.1' },
    );
  }
  for (let i = 1; i <= 4; i++) {
    await recordPayment(
      { contractId: c2.contract.id, amountPaid: 10000, paidDate: addDays(addDays(today(), -6), i) },
      { user: collectorUser, ip: '127.0.0.1' },
    );
  }

  // ค่าใช้จ่ายตัวอย่าง
  const expenses = [
    ['ค่าน้ำมัน', 30000, 'เติมน้ำมันรถเก็บเงิน'],
    ['เงินเดือน/ค่าแรง', 1500000, 'เงินเดือนพนักงาน'],
    ['อุปกรณ์สำนักงาน', 45000, 'กระดาษและหมึกพิมพ์'],
  ];
  for (const [cat, amt, desc] of expenses) {
    await run(
      `INSERT INTO expenses (entry_date, category, amount, description, employee_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :emp, :uid, :now)`,
      { d: today(), cat, amt, desc, emp: emp1, uid: owner.id, now },
    );
  }

  console.log(`สร้างข้อมูลตัวอย่าง: ลูกหนี้ ${people.length} ราย, สัญญา 4 ฉบับ`);
}

await seedUsers();
const ownerRow = await get(`SELECT id FROM users WHERE username = 'owner'`);
await setSetting('company_name', 'พันธมิตรเงินทุน', ownerRow?.id);
if (DEMO) await seedDemo();

console.log(`\nฐานข้อมูล: ${TARGET}`);
console.log(
  MINIMAL || OWNER_PASSWORD
    ? 'เข้าสู่ระบบด้วย owner และรหัสผ่านที่คุณกำหนดไว้'
    : 'เข้าสู่ระบบด้วย owner / owner1234 แล้วเปลี่ยนรหัสผ่านทันที',
);
await closeDb();
