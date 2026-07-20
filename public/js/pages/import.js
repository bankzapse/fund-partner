// นำเข้าข้อมูลเริ่มต้นจาก Excel / CSV — SRS ข้อ 19
import {
  api, el, clear, table, badge, stat, field, toast, toastError, baht, thaiDate,
  readFileAsDataUrl,
} from '../core.js';

const KINDS = {
  contracts: 'ลูกหนี้ + สัญญา (ยอดยกมา)',
  debtors: 'ลูกหนี้อย่างเดียว',
};

export async function renderImport() {
  const wrap = el('div', {});

  // สถานะของตัวช่วยนำเข้าทีละขั้น
  const st = {
    kind: 'contracts',
    fileName: '',
    dataUrl: null,
    sheets: [],
    sheetIndex: 0,
    headerRow: 0,
    mapping: {},
    fields: [],
  };

  const stepBox = el('div', {});

  wrap.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h2', {}, 'นำเข้าข้อมูลจาก Excel'),
        el('div', { class: 'sub' }, 'ย้ายข้อมูลลูกหนี้และสัญญาที่เดินอยู่แล้วเข้าสู่ระบบ'),
      ),
      el(
        'div',
        { class: 'btn-row' },
        el('a', {
          href: '/api/import/template?kind=contracts',
          class: 'btn ghost sm',
          style: 'text-decoration:none',
        }, 'ดาวน์โหลดไฟล์ตัวอย่าง'),
      ),
    ),
    el(
      'div',
      { class: 'info' },
      'ระบบจะบันทึกเป็น “ยอดยกมา” เท่านั้น — ไม่สร้างรายการเงินสดย้อนหลัง ' +
      '(ค่าทำเอกสาร เงินปล่อยใหม่ งวดแรก) เพราะเงินเหล่านั้นเคลื่อนไหวไปก่อนเริ่มใช้ระบบแล้ว ' +
      'กำไรและกระแสเงินสดของงวดปัจจุบันจึงไม่ผิด',
    ),
    stepBox,
  );

  // ---------- ขั้นที่ 1: เลือกชนิดและอัปโหลดไฟล์ ----------
  function stepUpload() {
    const kindSel = el(
      'select',
      { onchange: (e) => { st.kind = e.target.value; } },
      Object.entries(KINDS).map(([v, l]) => el('option', { value: v, selected: st.kind === v }, l)),
    );
    const fileInput = el('input', { type: 'file', accept: '.xlsx,.csv,.txt' });
    const go = el('button', { class: 'btn' }, 'อ่านไฟล์ →');

    go.addEventListener('click', async () => {
      const file = fileInput.files[0];
      if (!file) return toast('กรุณาเลือกไฟล์ก่อน', 'err');
      go.disabled = true;
      try {
        st.fileName = file.name;
        st.dataUrl = await readFileAsDataUrl(file);
        const res = await api.post('/api/import/analyze', {
          kind: st.kind,
          file_name: st.fileName,
          data_url: st.dataUrl,
        });
        st.sheets = res.sheets;
        st.fields = res.fields;
        st.sheetIndex = 0;
        const s = st.sheets[0];
        st.headerRow = s.header_row;
        st.mapping = { ...s.mapping };
        clear(stepBox).append(stepMap());
      } catch (err) {
        toastError(err);
      }
      go.disabled = false;
    });

    return el(
      'div',
      { class: 'card' },
      el('h3', {}, 'ขั้นที่ 1 — เลือกไฟล์'),
      field('ต้องการนำเข้าอะไร', kindSel),
      field('ไฟล์ (.xlsx หรือ .csv)', fileInput, 'ไฟล์ .xls รุ่นเก่า ให้เปิดด้วย Excel แล้ว Save As เป็น .xlsx ก่อน'),
      el('div', { class: 'mt' }, go),
    );
  }

  // ---------- ขั้นที่ 2: จับคู่คอลัมน์ ----------
  function stepMap() {
    const sheet = st.sheets[st.sheetIndex];

    const sheetSel = el(
      'select',
      {
        onchange: (e) => {
          st.sheetIndex = Number(e.target.value);
          const s = st.sheets[st.sheetIndex];
          st.headerRow = s.header_row;
          st.mapping = { ...s.mapping };
          clear(stepBox).append(stepMap());
        },
      },
      st.sheets.map((s, i) =>
        el('option', { value: i, selected: i === st.sheetIndex }, `${s.name} (${s.total_rows} แถว)`),
      ),
    );

    const headerRowInput = el('input', {
      type: 'number',
      min: '0',
      value: String(st.headerRow),
      style: 'width:6rem',
      onchange: (e) => { st.headerRow = Number(e.target.value); },
    });

    // แถวจับคู่: ฟิลด์ของระบบ ← คอลัมน์ในไฟล์
    const mapRows = st.fields.map((f) => {
      const sel = el(
        'select',
        {
          onchange: (e) => {
            if (e.target.value === '') delete st.mapping[f.key];
            else st.mapping[f.key] = Number(e.target.value);
          },
        },
        el('option', { value: '' }, '— ไม่ใช้ —'),
        sheet.headers.map((h, i) =>
          el('option', { value: i, selected: st.mapping[f.key] === i }, `${colName(i)}: ${h || '(ว่าง)'}`),
        ),
      );
      const mapped = st.mapping[f.key] !== undefined;
      return el(
        'tr',
        {},
        el('td', {}, f.label, f.required ? el('span', { style: 'color:var(--red)' }, ' *') : null),
        el('td', {}, sel),
        el('td', {}, mapped
          ? badge('normal', 'จับคู่แล้ว')
          : f.required
            ? badge('overdue', 'ต้องระบุ')
            : badge('void', 'ข้าม')),
      );
    });

    const next = el('button', { class: 'btn' }, 'ตรวจสอบข้อมูล →');
    next.addEventListener('click', async () => {
      const missing = st.fields.filter((f) => f.required && st.mapping[f.key] === undefined);
      if (missing.length) {
        return toast(`ยังไม่ได้จับคู่: ${missing.map((f) => f.label).join(', ')}`, 'err');
      }
      next.disabled = true;
      try {
        const res = await api.post('/api/import/dry-run', payload());
        clear(stepBox).append(stepReview(res));
      } catch (err) {
        toastError(err);
      }
      next.disabled = false;
    });

    // ตัวอย่างข้อมูลจากไฟล์
    const previewRows = sheet.sample.map((r, i) =>
      el('tr', {}, sheet.headers.map((_, ci) => el('td', { class: 'small' }, r[ci] ?? ''))),
    );

    return el(
      'div',
      {},
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'ขั้นที่ 2 — จับคู่คอลัมน์'),
        el('div', { class: 'hint' }, `ไฟล์: ${st.fileName} · ระบบเดาการจับคู่ให้แล้ว ตรวจและแก้ได้`),
        el('div', { class: 'grid k2' },
          field('ชีตที่ใช้', sheetSel),
          field('หัวตารางอยู่แถวที่ (เริ่มนับ 0)', headerRowInput)),
        el(
          'div',
          { class: 'table-wrap mt' },
          el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'ข้อมูลในระบบ'), el('th', {}, 'คอลัมน์ในไฟล์'), el('th', {}, 'สถานะ'))),
            el('tbody', {}, mapRows)),
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'ตัวอย่างข้อมูลในไฟล์'),
        el('div', { class: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {}, sheet.headers.map((h, i) =>
              el('th', {}, `${colName(i)}: ${h || '(ว่าง)'}`)))),
            el('tbody', {}, previewRows))),
      ),
      el('div', { class: 'btn-row' },
        next,
        el('button', { class: 'btn ghost', onclick: () => clear(stepBox).append(stepUpload()) }, '← เลือกไฟล์ใหม่')),
    );
  }

  // ---------- ขั้นที่ 3: ตรวจสอบผล ----------
  function stepReview(res) {
    const hasError = res.error_count > 0;

    const rows = res.rows.map((r) =>
      el(
        'tr',
        { style: r.errors.length ? 'background:var(--red-soft)' : '' },
        el('td', { class: 'num small' }, String(r.row_number)),
        el('td', {}, r.data.debtor_name || el('span', { class: 'muted' }, '(ไม่มีชื่อ)'),
          r.existing_debtor ? el('div', { class: 'small muted' }, 'มีในระบบแล้ว — จะใช้รายเดิม') : null),
        el('td', { class: 'small' }, r.data.debtor_code ?? '-'),
        res.kind === 'contracts' ? el('td', { class: 'small' }, r.data.type ?? '-') : null,
        res.kind === 'contracts' ? el('td', { class: 'num' }, r.data.principal_amount ? baht(r.data.principal_amount) : '-') : null,
        res.kind === 'contracts' ? el('td', { class: 'num' }, r.data.principal_remaining !== null && r.data.principal_remaining !== undefined ? baht(r.data.principal_remaining) : '-') : null,
        res.kind === 'contracts' ? el('td', { class: 'small nowrap' }, thaiDate(r.data.start_date)) : null,
        el('td', {}, r.errors.length
          ? el('div', { class: 'small', style: 'color:var(--red)' }, r.errors.join(' · '))
          : badge('normal', 'พร้อมนำเข้า')),
      ),
    );

    const headers = res.kind === 'contracts'
      ? ['แถว', 'ลูกหนี้', 'รหัส', 'ประเภท', { label: 'เงินต้น', num: true }, { label: 'ยอดยกมา', num: true }, 'วันเริ่ม', 'ผล']
      : ['แถว', 'ลูกหนี้', 'รหัส', 'ผล'];

    const commit = el(
      'button',
      { class: 'btn gold', disabled: res.ok_count === 0 },
      `นำเข้า ${res.ok_count} แถวที่ผ่านการตรวจ`,
    );
    commit.addEventListener('click', async () => {
      commit.disabled = true;
      commit.textContent = 'กำลังนำเข้า…';
      try {
        const out = await api.post('/api/import/commit', payload());
        clear(stepBox).append(stepDone(out.summary));
      } catch (err) {
        toastError(err);
        commit.disabled = false;
        commit.textContent = `นำเข้า ${res.ok_count} แถวที่ผ่านการตรวจ`;
      }
    });

    return el(
      'div',
      {},
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'ขั้นที่ 3 — ตรวจสอบก่อนนำเข้า'),
        el('div', { class: 'hint' }, 'ยังไม่มีอะไรถูกบันทึกลงระบบในขั้นนี้'),
        el('div', { class: 'grid k4' },
          stat('ทั้งหมด', String(res.total_rows), { small: true }),
          stat('พร้อมนำเข้า', String(res.ok_count), { small: true, tone: 'pos' }),
          stat('มีปัญหา', String(res.error_count), { small: true, tone: res.error_count ? 'neg' : '' }),
          stat('ลูกหนี้ใหม่', String(res.new_debtors), { small: true }),
          res.kind === 'contracts' ? stat('เงินต้นรวม', baht(res.total_principal), { small: true }) : null,
          res.kind === 'contracts' ? stat('ยอดยกมารวม', baht(res.total_remaining), { small: true, tone: 'gold' }) : null,
          stat('ใช้ลูกหนี้เดิม', String(res.existing_debtors), { small: true })),
        hasError
          ? el('div', { class: 'warn mt' },
              `มี ${res.error_count} แถวที่มีปัญหา — แถวเหล่านี้จะถูกข้าม ` +
              'แก้ไฟล์แล้วนำเข้าใหม่อีกครั้งได้ (ระบบจะใช้ลูกหนี้เดิมถ้ารหัสตรงกัน)')
          : null,
        res.truncated ? el('div', { class: 'hint' }, 'แสดง 200 แถวแรก — การนำเข้าจริงจะทำครบทุกแถว') : null,
      ),
      el('div', { class: 'card' }, table(headers, rows, 'ไม่มีข้อมูล')),
      el('div', { class: 'btn-row' },
        commit,
        el('button', { class: 'btn ghost', onclick: () => clear(stepBox).append(stepMap()) }, '← แก้การจับคู่')),
    );
  }

  // ---------- ขั้นที่ 4: เสร็จสิ้น ----------
  function stepDone(summary) {
    return el(
      'div',
      { class: 'card' },
      el('h3', {}, 'นำเข้าเรียบร้อย'),
      el('div', { class: 'grid k4' },
        stat('ลูกหนี้ที่สร้างใหม่', String(summary.debtors_created), { small: true, tone: 'pos' }),
        stat('ใช้ลูกหนี้เดิม', String(summary.debtors_reused), { small: true }),
        stat('สัญญาที่สร้าง', String(summary.contracts_created), { small: true, tone: 'pos' }),
        stat('ข้ามไป', String(summary.skipped), { small: true, tone: summary.skipped ? 'neg' : '' })),
      summary.errors.length
        ? el(
            'div',
            { class: 'mt' },
            el('div', { class: 'hint' }, 'แถวที่ถูกข้าม'),
            table(['แถว', 'สาเหตุ'], summary.errors.map((e) =>
              el('tr', {},
                el('td', { class: 'num small' }, String(e.row_number)),
                el('td', { class: 'small' }, e.errors.join(' · '))))),
          )
        : null,
      el('div', { class: 'btn-row mt' },
        el('a', { href: '#/debtors', class: 'btn', style: 'text-decoration:none' }, 'ไปหน้าลูกหนี้'),
        el('button', { class: 'btn ghost', onclick: () => clear(stepBox).append(stepUpload()) }, 'นำเข้าไฟล์อื่น')),
    );
  }

  function payload() {
    return {
      kind: st.kind,
      file_name: st.fileName,
      data_url: st.dataUrl,
      sheet_index: st.sheetIndex,
      header_row: st.headerRow,
      mapping: st.mapping,
      options: {},
    };
  }

  clear(stepBox).append(stepUpload());
  return wrap;
}

/** ลำดับคอลัมน์ -> ชื่อแบบ Excel (A, B, ... AA) */
function colName(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
