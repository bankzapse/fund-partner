-- พันธมิตรเงินทุน :: Migration สำหรับ Supabase
-- รันใน Supabase Dashboard > SQL Editor (หรือปล่อยให้ระบบสร้างเองตอนเชื่อมต่อครั้งแรก)
-- ไฟล์นี้สร้างจาก src/db/schema.sql จึงตรงกันเสมอ

-- พันธมิตรเงินทุน :: โครงสร้างฐานข้อมูล PostgreSQL (SRS ข้อ 13)
-- ใช้ได้ทั้ง Supabase (production) และ PGlite (dev/test) — dialect เดียวกันทั้งหมด
--
-- หน่วยเงินทุกคอลัมน์เก็บเป็น "สตางค์" แบบ BIGINT เพื่อไม่ให้ใช้ Float ตาม SRS ข้อ 19
-- วันที่เก็บเป็น TEXT 'YYYY-MM-DD', เวลาเก็บเป็น TEXT พร้อมออฟเซ็ต +07:00 (Asia/Bangkok)

-- 13.1 users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  full_name      TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('owner','manager','collector','accountant')),
  extra_perms    TEXT    NOT NULL DEFAULT '{}',
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
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  code          TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  phone         TEXT,
  area          TEXT,
  supervisor_id INTEGER REFERENCES employees(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 13.3 debtors ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS debtors (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  full_name    TEXT NOT NULL,
  phone        TEXT,
  address      TEXT,
  note         TEXT,
  employee_id  INTEGER REFERENCES employees(id),
  area         TEXT,
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
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  debtor_id   INTEGER NOT NULL REFERENCES debtors(id),
  kind        TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  mime_type   TEXT,
  note        TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

-- 13.5 contracts --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contracts (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_no         TEXT    NOT NULL UNIQUE,       -- ข้อ 14: ห้ามซ้ำ
  debtor_id           INTEGER NOT NULL REFERENCES debtors(id),
  employee_id         INTEGER REFERENCES employees(id),
  type                TEXT    NOT NULL CHECK (type IN ('daily24','monthly','floating')),
  principal_amount    BIGINT  NOT NULL,
  installment_amount  BIGINT  NOT NULL,
  interest_per_inst   BIGINT  NOT NULL,
  num_installments    INTEGER NOT NULL,
  period_unit         TEXT    NOT NULL CHECK (period_unit IN ('day','month')),
  start_date          TEXT    NOT NULL,
  doc_fee             BIGINT  NOT NULL DEFAULT 0,
  first_inst_deducted BIGINT  NOT NULL DEFAULT 0,
  cash_disbursed      BIGINT  NOT NULL DEFAULT 0,
  principal_remaining BIGINT  NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','completed','closed_reyod','cancelled')),
  closed_at           TEXT,
  note                TEXT,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- ข้อ 14: เงินต้นคงเหลือต้องไม่ต่ำกว่า 0 (บังคับที่ระดับฐานข้อมูลอีกชั้น)
  CONSTRAINT principal_remaining_non_negative CHECK (principal_remaining >= 0)
);
CREATE INDEX IF NOT EXISTS idx_contracts_debtor ON contracts(debtor_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- 13.6 contract_links (รียอด) --------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_links (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_contract_id  INTEGER NOT NULL REFERENCES contracts(id),
  to_contract_id    INTEGER NOT NULL REFERENCES contracts(id),
  link_type         TEXT    NOT NULL DEFAULT 'reyod',
  carried_principal BIGINT  NOT NULL,
  new_money         BIGINT  NOT NULL,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL
);

-- 13.7 installments -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS installments (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id     INTEGER NOT NULL REFERENCES contracts(id),
  seq             INTEGER NOT NULL,
  due_date        TEXT    NOT NULL,
  due_amount      BIGINT  NOT NULL,
  interest_due    BIGINT  NOT NULL,
  principal_due   BIGINT  NOT NULL,
  interest_paid   BIGINT  NOT NULL DEFAULT 0,
  principal_paid  BIGINT  NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','partial','interest_only')),
  UNIQUE (contract_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_inst_due ON installments(due_date, status);
CREATE INDEX IF NOT EXISTS idx_inst_contract ON installments(contract_id, seq);

-- 13.8 payments ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no       TEXT    NOT NULL UNIQUE,          -- ข้อ 14: ห้ามซ้ำ
  contract_id      INTEGER NOT NULL REFERENCES contracts(id),
  debtor_id        INTEGER NOT NULL REFERENCES debtors(id),
  paid_date        TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  received_by      INTEGER REFERENCES users(id),
  due_amount       BIGINT  NOT NULL,
  amount_paid      BIGINT  NOT NULL,
  interest_amount  BIGINT  NOT NULL,
  principal_amount BIGINT  NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('full','interest_only','partial','unpaid')),
  source           TEXT    NOT NULL DEFAULT 'collection'
                   CHECK (source IN ('collection','first_installment')),
  proof_path       TEXT,
  note             TEXT,
  is_void          INTEGER NOT NULL DEFAULT 0,
  void_reason      TEXT,
  voided_by        INTEGER REFERENCES users(id),
  voided_at        TEXT,
  allocations      TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  -- ข้อ 14: ห้ามรับยอดติดลบ และผลรวมต้น+ดอกต้องเท่ากับยอดรับจริง
  CONSTRAINT amount_paid_non_negative CHECK (amount_paid >= 0),
  CONSTRAINT split_matches_amount CHECK (interest_amount + principal_amount = amount_paid)
);
CREATE INDEX IF NOT EXISTS idx_payments_date     ON payments(paid_date);
CREATE INDEX IF NOT EXISTS idx_payments_contract ON payments(contract_id);

-- 13.9 expenses ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date   TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  amount       BIGINT  NOT NULL CHECK (amount >= 0),
  description  TEXT,
  paid_by      INTEGER REFERENCES users(id),
  employee_id  INTEGER REFERENCES employees(id),
  contract_id  INTEGER REFERENCES contracts(id),
  receipt_path TEXT,
  approved_by  INTEGER REFERENCES users(id),
  is_void      INTEGER NOT NULL DEFAULT 0,
  void_reason  TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(entry_date);

-- 13.10 income_entries --------------------------------------------------------
CREATE TABLE IF NOT EXISTS income_entries (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date   TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  amount       BIGINT  NOT NULL CHECK (amount >= 0),
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
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  closing_date   TEXT   NOT NULL UNIQUE,
  system_cash    BIGINT NOT NULL,
  actual_cash    BIGINT NOT NULL,
  difference     BIGINT NOT NULL,
  total_in       BIGINT NOT NULL,
  total_out      BIGINT NOT NULL,
  real_income    BIGINT NOT NULL,
  net_profit     BIGINT NOT NULL,
  principal_back BIGINT NOT NULL,
  note           TEXT,
  closed_by      INTEGER REFERENCES users(id),
  closed_at      TEXT NOT NULL
);

-- 13.12 audit_logs ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
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

-- ตัวนับเลขเอกสาร (กันเลขซ้ำเมื่อใช้งานพร้อมกัน - SRS ข้อ 19) ------------------
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value BIGINT NOT NULL
);

-- การจำกัดจำนวนครั้งที่เข้าสู่ระบบผิด (ป้องกันการเดารหัสผ่าน) -------------------
--
-- เก็บในฐานข้อมูล ไม่ใช่ในหน่วยความจำ เพราะบน Serverless แต่ละ request
-- อาจทำงานคนละ instance กัน ตัวนับในหน่วยความจำจึงนับไม่ครบและถูกข้ามได้
CREATE TABLE IF NOT EXISTS login_attempts (
  scope        TEXT    NOT NULL,          -- 'user' หรือ 'ip'
  key          TEXT    NOT NULL,          -- ชื่อผู้ใช้ที่กรอก หรือหมายเลข IP
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT    NOT NULL,          -- เริ่มนับหน้าต่างเวลานี้เมื่อไร
  locked_until TEXT,                      -- ล็อกถึงเมื่อไร (ว่าง = ไม่ถูกล็อก)
  lock_count   INTEGER NOT NULL DEFAULT 0,-- เคยถูกล็อกมาแล้วกี่รอบ (ใช้ถ่วงเวลาเพิ่ม)
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until);

-- คำขออนุมัติ (ข้อ 12) --------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by  INTEGER REFERENCES users(id),
  requested_at  TEXT NOT NULL,
  decided_by    INTEGER REFERENCES users(id),
  decided_at    TEXT,
  decision_note TEXT
);

-- ---------------------------------------------------------------------------
-- ความปลอดภัยระดับแถว (Row Level Security)
--
-- แอปเชื่อมต่อจากฝั่งเซิร์ฟเวอร์ในฐานะเจ้าของตาราง (ซึ่งข้าม RLS ได้) และตรวจสิทธิ์เองในโค้ด
-- การเปิด RLS โดยไม่สร้าง policy ใด ๆ จึงเป็นการปิดประตูไม่ให้ anon key
-- เข้าถึงข้อมูลการเงินได้โดยตรงจากฝั่งเบราว์เซอร์
--
-- บังคับจากตัวแอปเอง ไม่พึ่งการตั้งค่าในหน้าจอ Supabase เพื่อให้ปลอดภัยเสมอ
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','sessions','employees','debtors','debtor_documents','contracts',
    'contract_links','installments','payments','expenses','income_entries',
    'daily_closings','audit_logs','settings','counters','approvals','login_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
