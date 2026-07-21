// สร้างหน้าแนะนำระบบ (SEO) พร้อมเติมราคาที่ผู้ดูแลตั้งไว้ในหน้าตั้งค่า
//
// ทำไมต้องเติมที่ฝั่งเซิร์ฟเวอร์ ไม่ใช่ให้เบราว์เซอร์ไปดึงเอง:
// หน้านี้มีไว้ให้ Google เก็บ ถ้าราคาถูกเติมด้วย JavaScript ทีหลัง
// Google อาจเก็บได้แต่โครงหน้าที่ยังไม่มีราคา หรือเก็บได้ช้ากว่าที่ควร
// ราคาเป็นข้อมูลที่คนค้นหาสนใจที่สุดอย่างหนึ่ง จึงต้องอยู่ใน HTML ตั้งแต่แรก
//
// ผลข้างเคียงคือหน้าแรกไม่ใช่ไฟล์นิ่งอีกต่อไป จึงตั้ง Cache-Control ให้ CDN
// เก็บไว้ช่วงสั้น ๆ เพื่อไม่ให้ทุกคนที่เข้าเว็บต้องปลุกเซิร์ฟเวอร์ทุกครั้ง

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting } from '../db/index.js';

/** กัน HTML injection จากข้อความที่ผู้ดูแลพิมพ์เองในหน้าตั้งค่า */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** อ่านแพ็กเกจจากการตั้งค่า ถ้าข้อมูลเสียให้คืนรายการว่างแทนที่จะพังทั้งหน้า */
export async function readPlans() {
  try {
    const raw = await getSetting('pricing_plans');
    const parsed = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p === 'object');
  } catch {
    return [];
  }
}

export async function pricingData() {
  return {
    heading: (await getSetting('pricing_heading')) ?? 'แพ็กเกจการใช้งาน',
    subheading: (await getSetting('pricing_subheading')) ?? '',
    note: (await getSetting('pricing_note')) ?? '',
    plans: await readPlans(),
  };
}

/** แปลงข้อมูลแพ็กเกจเป็น HTML ของส่วนราคา */
export function renderPricing({ heading, subheading, note, plans }) {
  // ไม่มีแพ็กเกจเลย = ตั้งใจซ่อนส่วนราคา (เช่น ยังไม่พร้อมประกาศราคา)
  // ซ่อนทั้งส่วนดีกว่าโชว์หัวข้อโล่ง ๆ และต้องเอาลิงก์ในเมนูออกด้วย
  if (!plans.length) return '';

  const cards = plans
    .map((p) => {
      const best = p.best ? ' best' : '';
      const btn = p.best ? 'gold' : 'ghost';
      const features = (Array.isArray(p.features) ? p.features : [])
        .map((f) => `          <li>${escapeHtml(f)}</li>`)
        .join('\n');
      return `      <div class="price${best}">
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="amt">${escapeHtml(p.price)}</div>
        <div class="per">${escapeHtml(p.per)}</div>
        <ul>
${features}
        </ul>
        <a class="btn ${btn} block" href="/app">${escapeHtml(p.cta || 'เลือกแพ็กเกจนี้')}</a>
      </div>`;
    })
    .join('\n');

  // ใช้ c4 เมื่อมี 4 แพ็กเกจขึ้นไป ไม่งั้นการ์ดจะยืดจนดูโหวง
  const cols = plans.length >= 4 ? 'c4' : plans.length === 3 ? 'c3' : 'c2';

  return `<section id="pricing">
  <div class="wrap">
    <div class="center" style="max-width:42rem;margin:0 auto 2rem">
      <h2>${escapeHtml(heading)}</h2>
      ${subheading ? `<p class="lead">${escapeHtml(subheading)}</p>` : ''}
    </div>
    <div class="grid ${cols}">
${cards}
    </div>
    ${note ? `<p class="center muted" style="margin-top:1.2rem;font-size:.88rem">${escapeHtml(note)}</p>` : ''}
  </div>
</section>`;
}

let template = null;

/** คืน HTML ของหน้าแนะนำระบบทั้งหน้า พร้อมราคาล่าสุด */
export async function renderLanding(publicDir) {
  // อ่านไฟล์ครั้งเดียวแล้วจำไว้ ตัวไฟล์ไม่เปลี่ยนระหว่างรัน มีแต่ราคาที่เปลี่ยน
  if (template === null) {
    template = readFileSync(join(publicDir, 'landing.html'), 'utf8');
  }
  const data = await pricingData();
  const html = template.replace('<!--PRICING-->', renderPricing(data));
  // ไม่มีราคาให้แสดง ก็เอาลิงก์ "ราคา" ในเมนูออกด้วย ไม่งั้นกดแล้วไม่ไปไหน
  // ลิงก์นี้อยู่ 2 ที่: เมนูบนสุด และรายการในส่วนท้ายเว็บที่ห่อด้วย <li>
  // ต้องเก็บ <li> ออกไปด้วย ไม่งั้นจะเหลือจุดหัวข้อว่าง ๆ ค้างอยู่
  if (data.plans.length) return html;
  return html
    .replace(/<li>\s*<a[^>]*href="#pricing"[^>]*>[\s\S]*?<\/a>\s*<\/li>\s*/g, '')
    .replace(/<a[^>]*href="#pricing"[^>]*>[\s\S]*?<\/a>\s*/g, '');
}
