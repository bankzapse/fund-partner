// คำนวณอัตราดอกเบี้ยที่แท้จริงต่อปี จากโครงสร้างค่างวดที่กำหนด
//
//   node scripts/interest-rate.mjs                    ← แสดงตัวอย่างมาตรฐาน 4 แบบ
//   node scripts/interest-rate.mjs --help             ← วิธีใส่ตัวเลขของตัวเอง
//
// ทำไมต้องมีเครื่องมือนี้:
// ตัวเลขหน้าสัญญา ("ดอก 20 จากค่างวด 50") ไม่ใช่อัตราที่แท้จริง เพราะ
//   1) ลูกค้าได้เงินไปน้อยกว่าเงินต้น เมื่อหักค่าทำเอกสารและงวดแรก
//   2) เงินต้นลดลงทุกงวด แต่ดอกยังคิดคงที่
//   3) ตารางงวดอาจตัดเงินต้นไม่ครบ เหลือยอดค้างตอนจบ
// ทั้งสามอย่างทำให้อัตราจริงสูงกว่าที่ตาเห็น ซึ่งเป็นตัวเลขที่ทนายต้องใช้ตัดสิน
//
// ใช้ตารางงวดจาก src/domain/contracts.js ตัวเดียวกับที่ระบบใช้จริง
// ตัวเลขที่ได้จึงตรงกับสิ่งที่จะเกิดขึ้นกับลูกค้าจริง ไม่ใช่สูตรแยกต่างหาก

import { buildSchedule } from '../src/domain/contracts.js';

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const say = (s = '') => console.log(s);
const money = (n) => n.toLocaleString('th-TH');

/**
 * หาอัตราผลตอบแทนต่อคาบจากกระแสเงินสด (IRR) ด้วยวิธี Newton-Raphson
 * flows[0] = เงินที่ลูกค้าได้รับ (บวก), flows[t] = เงินที่ลูกค้าจ่ายคืน (ลบ)
 */
function irr(flows) {
  let r = 0.01;
  for (let i = 0; i < 500; i++) {
    let f = 0, df = 0;
    flows.forEach((c, t) => {
      f += c / (1 + r) ** t;
      df += -t * c / (1 + r) ** (t + 1);
    });
    if (Math.abs(f) < 1e-10) break;
    if (df === 0) break;
    r = Math.max(-0.9999, r - f / df);
  }
  return r;
}

export function analyse({ type, principal, installment, interestPerInst, n, docFee = 0, deductFirst = false }) {
  const schedule = buildSchedule({
    type,
    startDate: '2026-01-01',
    numInstallments: n,
    installmentAmount: installment,
    interestPerInst,
    principalAmount: principal,
  });

  const principalScheduled = schedule.reduce((s, r) => s + r.principal_due, 0);
  const balloon = Math.max(0, principal - principalScheduled); // เงินต้นค้างเมื่อครบงวด
  const firstInst = deductFirst ? schedule[0].due_amount : 0;
  const cash = principal - docFee - firstInst;               // เงินที่ลูกค้าได้ถือจริง

  const flows = [cash];
  schedule.forEach((r, i) => flows.push(deductFirst && i === 0 ? 0 : -r.due_amount));
  if (balloon > 0) flows[flows.length - 1] -= balloon;

  const perPeriod = irr(flows);
  const periodsPerYear = type === 'daily24' ? 365 : 12;
  const apr = perPeriod * periodsPerYear * 100;
  const totalPaid = schedule.reduce((s, r) => s + r.due_amount, 0) - firstInst + balloon;

  return {
    cash, totalPaid, balloon,
    cost: totalPaid - cash,
    costPct: cash > 0 ? ((totalPaid - cash) / cash) * 100 : 0,
    perPeriodPct: perPeriod * 100,
    apr,
    days: type === 'daily24' ? n : n * 30,
  };
}

function show(label, input) {
  const r = analyse(input);
  say();
  say('  ' + C.b(label));
  say(`    ลูกค้าได้รับจริง      ${money(r.cash)} บาท` +
      C.dim(`  (เงินต้น ${money(input.principal)}` +
        (input.docFee ? ` − ค่าเอกสาร ${money(input.docFee)}` : '') +
        (input.deductFirst ? ` − งวดแรก ${money(input.principal - input.docFee - r.cash)}` : '') + ')'));
  say(`    จ่ายคืนรวม           ${money(r.totalPaid)} บาท` +
      (r.balloon ? C.warn(`  (รวม${input.type === 'floating' ? 'การปิดเงินต้น' : 'ยอดต้นค้างตอนจบ'} ${money(r.balloon)} บาท)`) : ''));
  say(`    ต้นทุนของลูกค้า      ${money(r.cost)} บาท = ${r.costPct.toFixed(0)}% ของเงินที่ได้รับ ใน ${r.days} วัน`);
  const color = r.apr > 100 ? C.bad : r.apr > 36 ? C.warn : C.ok;
  say(`    ${C.b('อัตราต่อปี')}           ${color(C.b(r.apr.toLocaleString('th-TH', { maximumFractionDigits: 0 }) + '%'))}` +
      C.dim(`   (ต่อคาบ ${r.perPeriodPct.toFixed(3)}%)`));
  // ดอกลอยตั้งใจให้เงินต้นคงอยู่จนกว่าจะปิดสัญญา จึงไม่ใช่ความผิดปกติ
  if (r.balloon && input.type !== 'floating') {
    say(C.warn(`    ⚠ ตารางงวดตัดเงินต้นไม่ครบ เหลือค้าง ${money(r.balloon)} บาท ต้องรียอดหรือชำระเพิ่ม`));
  }
}

// ส่วนด้านล่างเป็นการทำงานแบบสั่งจากบรรทัดคำสั่ง
// ต้องกันไม่ให้ทำงานตอนถูก import จากไฟล์ทดสอบ ไม่งั้นผลทดสอบจะรกไปด้วยตัวอย่าง
if (!import.meta.main) {
  // ถูก import มาใช้ฟังก์ชัน analyse เท่านั้น ไม่ต้องพิมพ์อะไร
} else {

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  say(`
  คำนวณอัตราดอกเบี้ยที่แท้จริงต่อปี

  ใส่ตัวเลขของตัวเอง:
    node scripts/interest-rate.mjs --type=daily24 --principal=1000 \\
         --installment=50 --interest=20 --n=24 --fee=100 --deduct-first

  ตัวเลือก
    --type          daily24 (รายวัน) | monthly (รายเดือน) | floating (ดอกลอย)
    --principal     เงินต้นตามสัญญา (บาท)
    --installment   ค่างวด (บาท)
    --interest      ดอกเบี้ยต่องวด (บาท)
    --n             จำนวนงวด
    --fee           ค่าทำเอกสารที่หักตอนจ่ายเงิน (บาท) ค่าเริ่มต้น 0
    --deduct-first  หักงวดแรกออกจากเงินที่จ่ายให้ลูกค้า
`);
  process.exit(0);
}

const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};

say();
say('  ' + C.b('อัตราดอกเบี้ยที่แท้จริง'));
say(C.dim('  คำนวณจากตารางงวดที่ระบบสร้างเอง หักค่าธรรมเนียมและงวดแรกที่ลูกค้าไม่เคยได้ถือออกแล้ว'));

if (args.some((a) => a.startsWith('--principal='))) {
  const typeArg = args.find((a) => a.startsWith('--type='))?.split('=')[1] ?? 'daily24';
  show('ตามตัวเลขที่คุณกำหนด', {
    type: typeArg,
    principal: opt('principal', 1000),
    installment: opt('installment', 50),
    interestPerInst: opt('interest', 20),
    n: opt('n', 24),
    docFee: opt('fee', 0),
    deductFirst: args.includes('--deduct-first'),
  });
} else {
  show('ก) ตัวอย่างตรงตาม SRS · รายวัน 24 งวด งวดละ 50 (ดอก 20 + ต้น 30)',
    { type: 'daily24', principal: 1000, installment: 50, interestPerInst: 20, n: 24, docFee: 100, deductFirst: true });
  show('ข) รายวัน 24 งวด · ไม่มีค่าธรรมเนียม ตารางตัดต้นครบพอดี',
    { type: 'daily24', principal: 720, installment: 50, interestPerInst: 20, n: 24 });
  show('ค) รายเดือน 12 งวด · เงินต้น 10,000 ดอก 300/เดือน',
    { type: 'monthly', principal: 10000, installment: 1134, interestPerInst: 300, n: 12 });
  show('ง) ดอกลอย · เงินต้น 10,000 จ่ายดอก 500/เดือน 12 เดือน แล้วปิดต้น',
    { type: 'floating', principal: 10000, installment: 500, interestPerInst: 500, n: 12 });
  say();
  say(C.dim('  ใส่ตัวเลขของตัวเองได้ — node scripts/interest-rate.mjs --help'));
}

say();
say(C.warn('  ตัวเลขนี้เป็นผลการคำนวณ ไม่ใช่ความเห็นทางกฎหมาย'));
say(C.warn('  ให้ทนายเทียบกับเพดานที่กฎหมายกำหนดก่อนใช้จริง (ดู docs/legal-checklist.md หัวข้อ 2.1)'));
say();

} // จบส่วนสั่งจากบรรทัดคำสั่ง
