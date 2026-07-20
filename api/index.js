/**
 * จุดเข้าใช้งานสำหรับ Vercel Serverless Function
 *
 * Vercel จะเรียกไฟล์นี้ทุก request โดย process อาจถูกสร้างใหม่ได้ตลอด
 * จึงเก็บ app ไว้ในตัวแปรระดับโมดูล เพื่อให้ instance ที่ยังอุ่นอยู่ใช้ซ้ำได้
 * และไม่ต้องต่อฐานข้อมูลใหม่ทุกครั้ง
 */
import { createApp } from '../src/server.js';

let appPromise = null;

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = createApp().catch((err) => {
      appPromise = null; // ให้ request ถัดไปลองใหม่ได้ถ้าต่อฐานข้อมูลไม่ติด
      throw err;
    });
  }
  const app = await appPromise;
  return app(req, res);
}
