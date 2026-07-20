-- พันธมิตรเงินทุน :: โครงสร้างฐานข้อมูล (SRS ข้อ 13)
-- หน่วยเงินทุกคอลัมน์เก็บเป็น "สตางค์" (INTEGER) เพื่อไม่ให้ใช้ Float ตาม SRS ข้อ 19
-- วันที่เก็บเป็น TEXT 'YYYY-MM-DD', เวลาเก็บเป็น ISO string โซนเวลา Asia/Bangkok

PRAGMA foreign_keys = ON;

-- 13.1 users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  full_name      TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('owner','manager','collector','accountant')),
  extra_perms    TEXT    NOT NULL DEFAULT '{}',   -- สิทธิ์ย่อยรายบุคคล (JSON)
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- 13.2 employees --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id),
  code          TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  area          TEXT,                       -- พื้นที่ / เส้นทาง
  supervisor_id INTEGER REFERENCES employees(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 13.3 debtors ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS debtors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,        -- รหัสลูกหนี้
  full_name    TEXT NOT NULL,
  phone        TEXT,
  address      TEXT,
  note         TEXT,
  employee_id  INTEGER REFERENCES employees(id),   -- พนักงานผู้ดูแล
  area         TEXT,                                -- พื้นที่ / เส้นทาง / กลุ่ม
  status       TEXT NOT NULL DEFAULT 'normal'
               CHECK (status IN ('normal','overdue','closed','disabled')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debtors_name  ON debtors(full_name);
CREATE INDEX IF NOT EXISTS idx_debtors_phone ON debtors(phone);
CREATE INDEX IF NOT EXISTS idx_debtors_emp   ON debtors(employee_id);

-- 13.4 debtor_documents -------------------------------------------------------
CREATE TABLE IF NOT EXISTS debtor_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  debtor_id   INTEGER NOT NULL REFERENCES debtors(id),
  kind        TEXT NOT NULL,               -- photo | id_card | document | other
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  mime_type   TEXT,
  note        TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

-- 13.5 contracts --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contracts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no         TEXT    NOT NULL UNIQUE,       -- ข้อ 14: ห้ามซ้ำ
  debtor_id           INTEGER NOT NULL REFERENCES debtors(id),
  employee_id         INTEGER REFERENCES employees(id),
  type                TEXT    NOT NULL CHECK (type IN ('daily24','monthly','floating')),
  principal_amount    INTEGER NOT NULL,             -- เงินต้นตามสัญญา (สตางค์)
  installment_amount  INTEGER NOT NULL,             -- ค่างวด
  interest_per_inst   INTEGER NOT NULL,             -- ดอกเบี้ยต่องวด
  num_installments    INTEGER NOT NULL,
  period_unit         TEXT    NOT NULL CHECK (period_unit IN ('day','month')),
  start_date          TEXT    NOT NULL,
  doc_fee             INTEGER NOT NULL DEFAULT 0,   -- ค่าทำเอกสาร
  first_inst_deducted INTEGER NOT NULL DEFAULT 0,   -- งวดแรกที่หัก ณ วันทำสัญญา
  cash_disbursed      INTEGER NOT NULL DEFAULT 0,   -- เงินสดที่จ่ายให้ลูกค้าจริง
  principal_remaining INTEGER NOT NULL,             -- เงินต้นคงเหลือ (>= 0 ตามข้อ 14)
  status              TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','completed','closed_reyod','cancelled')),
  closed_at           TEXT,
  note                TEXT,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_debtor ON contracts(debtor_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- 13.6 contract_links (รียอด: เชื่อมสัญญาเดิม -> สัญญาใหม่) ------------------
CREATE TABLE IF NOT EXISTS contract_links (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  from_contract_id    INTEGER NOT NULL REFERENCES contracts(id),
  to_contract_id      INTEGER NOT NULL REFERENCES contracts(id),
  link_type           TEXT    NOT NULL DEFAULT 'reyod',
  carried_principal   INTEGER NOT NULL,   -- เงินต้นคงเหลือที่ยกไป
  new_money           INTEGER NOT NULL,   -- เงินเพิ่มใหม่
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL
);

-- 13.7 installments -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS installments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id),
  seq             INTEGER NOT NULL,
  due_date        TEXT    NOT NULL,
  due_amount      INTEGER NOT NULL,   -- ยอดที่ควรจ่ายของงวดนี้
  interest_due    INTEGER NOT NULL,
  principal_due   INTEGER NOT NULL,
  interest_paid   INTEGER NOT NULL DEFAULT 0,
  principal_paid  INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','partial','interest_only')),
  UNIQUE (contract_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_inst_due ON installments(due_date, status);

-- 13.8 payments ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no      TEXT    NOT NULL UNIQUE,   -- ข้อ 14: ห้ามซ้ำ
  contract_id     INTEGER NOT NULL REFERENCES contracts(id),
  debtor_id       INTEGER NOT NULL REFERENCES debtors(id),
  paid_date       TEXT    NOT NULL,          -- วันที่รับเงิน
  recorded_at     TEXT    NOT NULL,          -- เวลาที่บันทึก
  received_by     INTEGER REFERENCES users(id),
  due_amount      INTEGER NOT NULL,          -- ยอดที่ควรจ่าย
  amount_paid     INTEGER NOT NULL,          -- ยอดจ่ายจริง
  interest_amount INTEGER NOT NULL,          -- ตัดดอกเบี้ย
  principal_amount INTEGER NOT NULL,         -- ตัดเงินต้น
  status          TEXT    NOT NULL CHECK (status IN ('full','interest_only','partial','unpaid')),
  source          TEXT    NOT NULL DEFAULT 'collection'
                  CHECK (source IN ('collection','first_installment')),
  proof_path      TEXT,
  note            TEXT,
  is_void         INTEGER NOT NULL DEFAULT 0,   -- ข้อ 14/15: ไม่ลบถาวร ใช้การยกเลิก
  void_reason     TEXT,
  voided_by       INTEGER REFERENCES users(id),
  voided_at       TEXT,
  allocations     TEXT NOT NULL DEFAULT '[]',   -- JSON: การตัดแต่ละงวด (ใช้ย้อนกลับตอนยกเลิก)
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_date     ON payments(paid_date);
CREATE INDEX IF NOT EXISTS idx_payments_contract ON payments(contract_id);

-- 13.9 expenses ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date   TEXT    NOT NULL,
  category     TEXT    NOT NULL,   -- อ้างอิง settings.expense_categories
  amount       INTEGER NOT NULL,
  description  TEXT,
  paid_by      INTEGER REFERENCES users(id),
  employee_id  INTEGER REFERENCES employees(id),
  contract_id  INTEGER REFERENCES contracts(id),   -- ใช้กับ "เงินสดจ่ายให้ลูกค้า"
  receipt_path TEXT,
  approved_by  INTEGER REFERENCES users(id),
  is_void      INTEGER NOT NULL DEFAULT 0,
  void_reason  TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(entry_date);

-- 13.10 income_entries (รายรับนอกระบบรับชำระ) ---------------------------------
CREATE TABLE IF NOT EXISTS income_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date   TEXT    NOT NULL,
  category     TEXT    NOT NULL,   -- doc_fee | fee | other
  amount       INTEGER NOT NULL,
  description  TEXT,
  contract_id  INTEGER REFERENCES contracts(id),
  debtor_id    INTEGER REFERENCES debtors(id),
  is_void      INTEGER NOT NULL DEFAULT 0,
  void_reason  TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_income_date ON income_entries(entry_date);

-- 13.11 daily_closings --------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_closings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  closing_date   TEXT    NOT NULL UNIQUE,
  system_cash    INTEGER NOT NULL,   -- เงินสดสุทธิตามระบบ
  actual_cash    INTEGER NOT NULL,   -- เงินสดจริงที่นับได้
  difference     INTEGER NOT NULL,   -- actual - system
  total_in       INTEGER NOT NULL,
  total_out      INTEGER NOT NULL,
  real_income    INTEGER NOT NULL,
  net_profit     INTEGER NOT NULL,
  principal_back INTEGER NOT NULL,
  note           TEXT,
  closed_by      INTEGER REFERENCES users(id),
  closed_at      TEXT NOT NULL
);

-- 13.12 audit_logs ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,       -- create | update | void | approve | login | close_day ...
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs(entity, entity_id);

-- settings --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- ตัวนับเลขเอกสาร (กันเลขซ้ำเมื่อใช้งานพร้อมกันหลายคน - SRS ข้อ 19) ----------
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- คำขออนุมัติ (ผู้จัดการ "รออนุมัติ" ตามตารางสิทธิ์ ข้อ 12) --------------------
CREATE TABLE IF NOT EXISTS approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,          -- void_payment | reyod | edit_closed_day
  payload      TEXT NOT NULL,          -- JSON
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL,
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  decision_note TEXT
);
