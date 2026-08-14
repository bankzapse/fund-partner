// เมนูถอนเงิน (สเปกข้อ 33-40, 49) — ถอนดอกเบี้ย / ถอนรายได้ดอกลอย / ประวัติ
//
// สิทธิ์: settings_manage = เจ้าของเท่านั้น (ข้อ 45: Admin เป็นผู้ถอนดอกเบี้ย)
// การยกเลิกรายการถอนใช้เส้นทาง void ของสมุดเงินสด (ไม่ลบถาวร ยอดคืนอัตโนมัติ — ข้อ 40)
import { Router } from 'express';
import {
  withdrawOverview,
  withdrawHistory,
  recordWithdrawal,
  SOURCES,
} from '../domain/withdraw.js';
import { wrap, need, intParam } from './_helpers.js';

const router = Router();

router.get(
  '/',
  need('settings_manage'),
  wrap(async (_req, res) => {
    res.json({
      ...(await withdrawOverview()),
      history: await withdrawHistory(100),
      sources: Object.fromEntries(
        Object.entries(SOURCES).map(([k, v]) => [k, v.label]),
      ),
    });
  }),
);

router.post(
  '/',
  need('settings_manage'),
  wrap(async (req, res) => {
    const entry = await recordWithdrawal(
      {
        source: req.body?.source,
        amount: intParam(req.body?.amount, 0),
        withdrawDate: req.body?.withdraw_date,
        employeeId: intParam(req.body?.employee_id, null),
        method: req.body?.method,
        note: req.body?.note,
        ownerOverride: req.body?.owner_override === true,
        reason: req.body?.reason,
      },
      req.ctx,
    );
    res.status(201).json({ entry });
  }),
);

export default router;
