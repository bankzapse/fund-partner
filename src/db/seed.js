import { existsSync, unlinkSync } from 'node:fs';
import { db, get, run, all, dbPath, setSetting } from './index.js';
import { hashPassword } from '../lib/auth.js';
import { nowISO, today, addDays } from '../lib/time.js';
import { createContract } from '../domain/contracts.js';
import { recordPayment } from '../domain/payments.js';

const RESET = process.argv.includes('--reset');
const DEMO = process.argv.includes('--demo') || RESET;

const DB_FILE = dbPath();
if (RESET && DB_FILE !== ':memory:') {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
  console.log('ลบฐานข้อมูลเดิมแล้ว');
}

db();

/** ผู้ใช้เริ่มต้นครบทุกตำแหน่งตามตารางสิทธิ์ ข้อ 12 */
const DEFAULT_USERS = [
  { username: 'owner', password: 'owner1234', full_name: 'เจ้าของกิจการ', role: 'owner' },
  { username: 'manager', password: 'manager1234', full_name: 'ผู้จัดการสาขา', role: 'manager' },
  { username: 'collector', password: 'collect1234', full_name: 'สมชาย เก็บเงิน', role: 'collector' },
  { username: 'account', password: 'account1234', full_name: 'ฝ่ายบัญชี', role: 'accountant' },
];

export function seedUsers() {
  const now = nowISO();
  for (const u of DEFAULT_USERS) {
    if (get(`SELECT id FROM users WHERE username = :u`, { u: u.username })) continue;
    run(
      `INSERT INTO users (username, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES (:u, :h, :name, :role, 1, :now, :now)`,
      { u: u.username, h: hashPassword(u.password), name: u.full_name, role: u.role, now },
    );
    console.log(`สร้างผู้ใช้ ${u.username} / ${u.password}`);
  }

  // ผูกพนักงานเก็บเงินกับผู้ใช้ เพื่อให้เห็นเฉพาะลูกหนี้ที่ตนดูแล (ข้อ 12)
  const collectorUser = get(`SELECT id FROM users WHERE username = 'collector'`);
  if (collectorUser && !get(`SELECT id FROM employees WHERE user_id = :uid`, { uid: collectorUser.id })) {
    const now2 = nowISO();
    run(
      `INSERT INTO employees (user_id, code, full_name, phone, area, is_active, created_at, updated_at)
       VALUES (:uid, 'E001', 'สมชาย เก็บเงิน', '081-000-0001', 'สายเหนือ', 1, :now, :now)`,
      { uid: collectorUser.id, now: now2 },
    );
    run(
      `INSERT INTO employees (code, full_name, phone, area, is_active, created_at, updated_at)
       VALUES ('E002', 'สมหญิง เก็บเงิน', '081-000-0002', 'สายใต้', 1, :now, :now)`,
      { now: now2 },
    );
    console.log('สร้างพนักงาน E001, E002');
  }
}

export function seedDemo() {
  if (get(`SELECT id FROM debtors LIMIT 1`)) {
    console.log('มีข้อมูลลูกหนี้อยู่แล้ว — ข้ามการสร้างข้อมูลตัวอย่าง');
    return;
  }
  const owner = get(`SELECT * FROM users WHERE username = 'owner'`);
  const ctx = { user: owner, ip: '127.0.0.1' };
  const emp1 = get(`SELECT id FROM employees WHERE code = 'E001'`).id;
  const emp2 = get(`SELECT id FROM employees WHERE code = 'E002'`).id;
  const now = nowISO();

  const people = [
    ['D00001', 'สมศรี ใจดี', '081-111-1111', 'กรุงเทพฯ', emp1],
    ['D00002', 'มานะ อดทน', '082-222-2222', 'นนทบุรี', emp1],
    ['D00003', 'ปรีชา ขยัน', '083-333-3333', 'ปทุมธานี', emp2],
    ['D00004', 'วิภา รักงาน', '084-444-4444', 'สมุทรปราการ', emp2],
  ];
  const debtorIds = [];
  for (const [code, name, phone, addr, emp] of people) {
    const info = run(
      `INSERT INTO debtors (code, full_name, phone, address, employee_id, status, created_at, updated_at)
       VALUES (:code, :name, :phone, :addr, :emp, 'normal', :now, :now)`,
      { code, name, phone, addr, emp, now },
    );
    debtorIds.push(Number(info.lastInsertRowid));
  }

  // เงินทุนตั้งต้นของกิจการ (ไม่ใช่รายได้ — เป็นการนำทุนเข้า)
  run(
    `INSERT INTO income_entries (entry_date, category, amount, description, created_by, created_at)
     VALUES (:d, 'capital', 5000000, 'เงินทุนตั้งต้นของกิจการ', :uid, :now)`,
    { d: addDays(today(), -60), uid: owner.id, now },
  );

  const start = addDays(today(), -10);

  // สัญญารายวัน 24 งวด: เงินต้น 1,000 ค่างวด 50 (ดอก 20 + ต้น 30) ตามตัวอย่าง SRS ข้อ 3.1/7.2
  const c1 = createContract(
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

  const c2 = createContract(
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
  createContract(
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
  createContract(
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
    recordPayment(
      { contractId: c1.contract.id, amountPaid: amount, paidDate: addDays(start, i) },
      { user: get(`SELECT * FROM users WHERE username='collector'`), ip: '127.0.0.1' },
    );
  }
  for (let i = 1; i <= 4; i++) {
    recordPayment(
      { contractId: c2.contract.id, amountPaid: 10000, paidDate: addDays(addDays(today(), -6), i) },
      { user: get(`SELECT * FROM users WHERE username='collector'`), ip: '127.0.0.1' },
    );
  }

  // ค่าใช้จ่ายตัวอย่าง
  const expenses = [
    ['ค่าน้ำมัน', 30000, 'เติมน้ำมันรถเก็บเงิน'],
    ['เงินเดือน/ค่าแรง', 1500000, 'เงินเดือนพนักงาน'],
    ['อุปกรณ์สำนักงาน', 45000, 'กระดาษและหมึกพิมพ์'],
  ];
  for (const [cat, amt, desc] of expenses) {
    run(
      `INSERT INTO expenses (entry_date, category, amount, description, employee_id, created_by, created_at)
       VALUES (:d, :cat, :amt, :desc, :emp, :uid, :now)`,
      { d: today(), cat, amt, desc, emp: emp1, uid: owner.id, now },
    );
  }

  console.log(`สร้างข้อมูลตัวอย่าง: ลูกหนี้ ${people.length} ราย, สัญญา 4 ฉบับ`);
}

seedUsers();
setSetting('company_name', 'พันธมิตรเงินทุน', get(`SELECT id FROM users WHERE username='owner'`)?.id);
if (DEMO) seedDemo();

console.log(`\nฐานข้อมูล: ${DB_FILE}`);
console.log('เข้าสู่ระบบด้วย owner / owner1234 แล้วเปลี่ยนรหัสผ่านทันที');
