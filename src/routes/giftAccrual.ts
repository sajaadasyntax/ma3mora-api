import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { AuthRequest } from '../types';
import { prisma } from '../lib/prisma';

const router = Router();

router.use(requireAuth);
router.use(blockAuditorWrites);

// ─── Schemas ────────────────────────────────────────────────────────────────

const createRuleSchema = z.object({
  itemId: z.string().min(1),
  supplierId: z.string().min(1),
  giftItemId: z.string().min(1),
  triggerQty: z.number().int().positive(),
  giftQty: z.number().int().positive(),
});

const updateRuleSchema = z.object({
  giftItemId: z.string().min(1).optional(),
  triggerQty: z.number().int().positive().optional(),
  giftQty: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

const ledgerEntrySchema = z.object({
  supplierId: z.string().min(1),
  ruleId: z.string().optional(),
  itemId: z.string().min(1),
  quantity: z.number().int().positive(),
  description: z.string().optional(),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
});

// ─── POST /gift-accrual/rules — Create a gift accrual rule ──────────────────

router.post(
  '/gift-accrual/rules',
  requireRole('MANAGER'),
  async (req: AuthRequest, res) => {
    try {
      const data = createRuleSchema.parse(req.body);

      const existing = await prisma.giftAccrualRule.findUnique({
        where: { itemId_supplierId: { itemId: data.itemId, supplierId: data.supplierId } },
      });

      if (existing) {
        return res.status(409).json({ error: 'قاعدة الهدية موجودة بالفعل لهذا الصنف والمورد' });
      }

      const rule = await prisma.giftAccrualRule.create({
        data,
        include: {
          item: true,
          supplier: true,
          giftItem: true,
        },
      });

      res.status(201).json(rule);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Create gift accrual rule error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء إنشاء قاعدة الهدية' });
    }
  }
);

// ─── GET /gift-accrual/rules — List all active rules ────────────────────────

router.get(
  '/gift-accrual/rules',
  async (req: AuthRequest, res) => {
    try {
      const { supplierId, itemId, includeInactive } = req.query;

      const where: any = {};
      if (!includeInactive) {
        where.isActive = true;
      }
      if (supplierId) where.supplierId = supplierId as string;
      if (itemId) where.itemId = itemId as string;

      const rules = await prisma.giftAccrualRule.findMany({
        where,
        include: {
          item: true,
          supplier: true,
          giftItem: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json(rules);
    } catch (error) {
      console.error('List gift accrual rules error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء جلب قواعد الهدايا' });
    }
  }
);

// ─── PUT /gift-accrual/rules/:id — Update rule ──────────────────────────────

router.put(
  '/gift-accrual/rules/:id',
  requireRole('MANAGER'),
  async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;
      const data = updateRuleSchema.parse(req.body);

      const rule = await prisma.giftAccrualRule.findUnique({ where: { id } });
      if (!rule) {
        return res.status(404).json({ error: 'قاعدة الهدية غير موجودة' });
      }

      const updated = await prisma.giftAccrualRule.update({
        where: { id },
        data,
        include: {
          item: true,
          supplier: true,
          giftItem: true,
        },
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Update gift accrual rule error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء تحديث قاعدة الهدية' });
    }
  }
);

// ─── DELETE /gift-accrual/rules/:id — Deactivate rule ───────────────────────

router.delete(
  '/gift-accrual/rules/:id',
  requireRole('MANAGER'),
  async (req: AuthRequest, res) => {
    try {
      const { id } = req.params;

      const rule = await prisma.giftAccrualRule.findUnique({ where: { id } });
      if (!rule) {
        return res.status(404).json({ error: 'قاعدة الهدية غير موجودة' });
      }

      const deactivated = await prisma.giftAccrualRule.update({
        where: { id },
        data: { isActive: false },
        include: {
          item: true,
          supplier: true,
          giftItem: true,
        },
      });

      res.json(deactivated);
    } catch (error) {
      console.error('Deactivate gift accrual rule error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء تعطيل قاعدة الهدية' });
    }
  }
);

// ─── POST /gift-accrual/accrue — Manual accrual entry ───────────────────────

router.post(
  '/gift-accrual/accrue',
  requireRole('MANAGER', 'PROCUREMENT'),
  async (req: AuthRequest, res) => {
    try {
      const data = ledgerEntrySchema.parse(req.body);

      const entry = await prisma.supplierGiftLedger.create({
        data: {
          supplierId: data.supplierId,
          ruleId: data.ruleId || null,
          entryType: 'ACCRUAL',
          itemId: data.itemId,
          quantity: data.quantity,
          description: data.description || null,
          referenceId: data.referenceId || null,
          referenceType: data.referenceType || null,
          createdById: req.user!.id,
        },
        include: {
          supplier: true,
          rule: true,
          item: true,
          createdBy: {
            select: { id: true, username: true, role: true },
          },
        },
      });

      res.status(201).json(entry);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Gift accrual error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء تسجيل استحقاق الهدية' });
    }
  }
);

// ─── POST /gift-accrual/deduct — Gift deduction when received ───────────────

router.post(
  '/gift-accrual/deduct',
  requireRole('MANAGER', 'PROCUREMENT'),
  async (req: AuthRequest, res) => {
    try {
      const data = ledgerEntrySchema.parse(req.body);

      const entry = await prisma.supplierGiftLedger.create({
        data: {
          supplierId: data.supplierId,
          ruleId: data.ruleId || null,
          entryType: 'DEDUCTION',
          itemId: data.itemId,
          quantity: data.quantity,
          description: data.description || null,
          referenceId: data.referenceId || null,
          referenceType: data.referenceType || null,
          createdById: req.user!.id,
        },
        include: {
          supplier: true,
          rule: true,
          item: true,
          createdBy: {
            select: { id: true, username: true, role: true },
          },
        },
      });

      res.status(201).json(entry);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Gift deduction error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء تسجيل خصم الهدية' });
    }
  }
);

// ─── GET /gift-accrual/ledger — Supplier gift ledger with filters ───────────

router.get(
  '/gift-accrual/ledger',
  async (req: AuthRequest, res) => {
    try {
      const { supplierId, dateFrom, dateTo } = req.query;

      if (!supplierId) {
        return res.status(400).json({ error: 'معرف المورد مطلوب' });
      }

      const where: any = { supplierId: supplierId as string };

      if (dateFrom || dateTo) {
        where.date = {};
        if (dateFrom) {
          where.date.gte = new Date(dateFrom as string);
        }
        if (dateTo) {
          const endDate = new Date(dateTo as string);
          endDate.setHours(23, 59, 59, 999);
          where.date.lte = endDate;
        }
      }

      const entries = await prisma.supplierGiftLedger.findMany({
        where,
        include: {
          supplier: true,
          rule: { include: { item: true, giftItem: true } },
          item: true,
          createdBy: {
            select: { id: true, username: true, role: true },
          },
        },
        orderBy: { date: 'asc' },
      });

      let runningBalance = 0;
      const entriesWithBalance = entries.map((entry) => {
        if (entry.entryType === 'ACCRUAL' || entry.entryType === 'ADJUSTMENT') {
          runningBalance += entry.quantity;
        } else if (entry.entryType === 'DEDUCTION') {
          runningBalance -= entry.quantity;
        }
        return { ...entry, runningBalance };
      });

      res.json(entriesWithBalance);
    } catch (error) {
      console.error('Gift ledger error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء جلب سجل الهدايا' });
    }
  }
);

// ─── GET /gift-accrual/due-balance — Due To/From gift balances per supplier ─

router.get(
  '/gift-accrual/due-balance',
  async (req: AuthRequest, res) => {
    try {
      const { supplierId } = req.query;

      const where: any = {};
      if (supplierId) where.supplierId = supplierId as string;

      const accruals = await prisma.supplierGiftLedger.groupBy({
        by: ['supplierId', 'entryType'],
        where,
        _sum: { quantity: true },
      });

      const supplierMap: Record<string, { accrued: number; deducted: number }> = {};

      for (const row of accruals) {
        if (!supplierMap[row.supplierId]) {
          supplierMap[row.supplierId] = { accrued: 0, deducted: 0 };
        }
        const qty = row._sum.quantity || 0;
        if (row.entryType === 'ACCRUAL' || row.entryType === 'ADJUSTMENT') {
          supplierMap[row.supplierId].accrued += qty;
        } else if (row.entryType === 'DEDUCTION') {
          supplierMap[row.supplierId].deducted += qty;
        }
      }

      const supplierIds = Object.keys(supplierMap);
      const suppliers = await prisma.supplier.findMany({
        where: { id: { in: supplierIds } },
      });

      const supplierLookup: Record<string, typeof suppliers[0]> = {};
      for (const s of suppliers) {
        supplierLookup[s.id] = s;
      }

      const balances = supplierIds.map((sid) => ({
        supplierId: sid,
        supplier: supplierLookup[sid] || null,
        accrued: supplierMap[sid].accrued,
        deducted: supplierMap[sid].deducted,
        outstanding: supplierMap[sid].accrued - supplierMap[sid].deducted,
      }));

      balances.sort((a, b) => b.outstanding - a.outstanding);

      res.json(balances);
    } catch (error) {
      console.error('Gift due balance error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء جلب أرصدة الهدايا المستحقة' });
    }
  }
);

export default router;
