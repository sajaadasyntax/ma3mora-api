import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';
import { prisma } from '../lib/prisma';

const router = Router();

router.use(requireAuth);
router.use(blockAuditorWrites);

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const expenseGroupSchema = z.object({
  name: z.string().min(1, 'اسم المجموعة مطلوب'),
});

const expenseHeadSchema = z.object({
  name: z.string().min(1, 'اسم البند مطلوب'),
});

// ── 1. GET /expense-groups — List all expense groups with their heads ─────────

router.get('/', async (req: AuthRequest, res) => {
  try {
    const groups = await prisma.expenseGroup.findMany({
      include: {
        heads: {
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(groups);
  } catch (error) {
    console.error('Get expense groups error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── 2. POST /expense-groups — Create expense group ───────────────────────────

router.post('/', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ExpenseGroup'), async (req: AuthRequest, res) => {
  try {
    const data = expenseGroupSchema.parse(req.body);

    // Check uniqueness
    const existing = await prisma.expenseGroup.findUnique({
      where: { name: data.name },
    });
    if (existing) {
      return res.status(400).json({ error: 'اسم المجموعة موجود بالفعل' });
    }

    const group = await prisma.expenseGroup.create({
      data: { name: data.name },
      include: { heads: true },
    });

    res.status(201).json(group);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create expense group error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── 3. POST /expense-groups/:id/heads — Add expense head under a group ───────

router.post('/:id/heads', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ExpenseHead'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = expenseHeadSchema.parse(req.body);

    // Check group exists
    const group = await prisma.expenseGroup.findUnique({ where: { id } });
    if (!group) {
      return res.status(404).json({ error: 'المجموعة غير موجودة' });
    }

    // Check uniqueness of [groupId, name]
    const existing = await prisma.expenseHead.findUnique({
      where: { groupId_name: { groupId: id, name: data.name } },
    });
    if (existing) {
      return res.status(400).json({ error: 'اسم البند موجود بالفعل في هذه المجموعة' });
    }

    const head = await prisma.expenseHead.create({
      data: {
        name: data.name,
        groupId: id,
      },
      include: { group: true },
    });

    res.status(201).json(head);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create expense head error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── 4. PUT /expense-groups/:id — Update expense group ────────────────────────

router.put('/:id', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ExpenseGroup'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = expenseGroupSchema.parse(req.body);

    // Check uniqueness (exclude current record)
    const existing = await prisma.expenseGroup.findFirst({
      where: { name: data.name, id: { not: id } },
    });
    if (existing) {
      return res.status(400).json({ error: 'اسم المجموعة موجود بالفعل' });
    }

    const group = await prisma.expenseGroup.update({
      where: { id },
      data: { name: data.name },
      include: { heads: true },
    });

    res.json(group);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Update expense group error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── 5. DELETE /expense-groups/:id — Delete expense group (cascade heads) ─────

router.delete('/:id', requireRole('MANAGER'), createAuditLog('ExpenseGroup'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Check no expenses are linked to any of its heads
    const linkedExpenses = await prisma.expense.findFirst({
      where: {
        expenseHead: {
          groupId: id,
        },
      },
    });
    if (linkedExpenses) {
      return res.status(400).json({ error: 'لا يمكن حذف المجموعة لوجود مصروفات مرتبطة ببنودها' });
    }

    await prisma.expenseGroup.delete({ where: { id } });

    res.json({ message: 'تم حذف المجموعة بنجاح' });
  } catch (error) {
    console.error('Delete expense group error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── 6. GET /expenses/report/monthly — Monthly Expense Summary by category ────

router.get('/expenses/report/monthly', async (req: AuthRequest, res) => {
  try {
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'الشهر والسنة مطلوبان' });
    }

    const m = parseInt(month as string);
    const y = parseInt(year as string);

    if (isNaN(m) || isNaN(y) || m < 1 || m > 12) {
      return res.status(400).json({ error: 'قيم الشهر أو السنة غير صالحة' });
    }

    const startDate = new Date(y, m - 1, 1);
    const endDate = new Date(y, m, 0, 23, 59, 59, 999);

    // Fetch all expenses in the period with their head & group
    const expenses = await prisma.expense.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
      },
      include: {
        expenseHead: {
          include: { group: true },
        },
        creator: { select: { username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group expenses by group -> head
    const groupMap = new Map<string, {
      groupId: string;
      groupName: string;
      heads: Map<string, {
        headId: string;
        headName: string;
        total: number;
        count: number;
      }>;
      total: number;
      count: number;
    }>();

    let uncategorizedTotal = 0;
    let uncategorizedCount = 0;
    let grandTotal = 0;
    let grandCount = 0;

    for (const expense of expenses) {
      const amount = parseFloat(expense.amount.toString());
      grandTotal += amount;
      grandCount += 1;

      if (!expense.expenseHead) {
        uncategorizedTotal += amount;
        uncategorizedCount += 1;
        continue;
      }

      const group = expense.expenseHead.group;
      const head = expense.expenseHead;

      if (!groupMap.has(group.id)) {
        groupMap.set(group.id, {
          groupId: group.id,
          groupName: group.name,
          heads: new Map(),
          total: 0,
          count: 0,
        });
      }

      const g = groupMap.get(group.id)!;
      g.total += amount;
      g.count += 1;

      if (!g.heads.has(head.id)) {
        g.heads.set(head.id, {
          headId: head.id,
          headName: head.name,
          total: 0,
          count: 0,
        });
      }

      const h = g.heads.get(head.id)!;
      h.total += amount;
      h.count += 1;
    }

    // Build response
    const groups = Array.from(groupMap.values()).map((g) => ({
      groupId: g.groupId,
      groupName: g.groupName,
      total: g.total,
      count: g.count,
      heads: Array.from(g.heads.values()),
    }));

    res.json({
      month: m,
      year: y,
      groups,
      uncategorized: {
        total: uncategorizedTotal,
        count: uncategorizedCount,
      },
      grandTotal: {
        total: grandTotal,
        count: grandCount,
      },
    });
  } catch (error) {
    console.error('Monthly expense report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── 7. GET /expenses/report/categorized — Detailed Expense Report by group/head

router.get('/expenses/report/categorized', async (req: AuthRequest, res) => {
  try {
    const { dateFrom, dateTo, groupId } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'تاريخ البداية والنهاية مطلوبان' });
    }

    const start = new Date(dateFrom as string);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateTo as string);
    end.setHours(23, 59, 59, 999);

    // Build where clause
    const where: Prisma.ExpenseWhereInput = {
      createdAt: { gte: start, lte: end },
    };

    if (groupId) {
      where.expenseHead = { groupId: groupId as string };
    }

    const expenses = await prisma.expense.findMany({
      where,
      include: {
        expenseHead: {
          include: { group: true },
        },
        creator: { select: { username: true } },
        inventory: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group expenses by group -> head
    const groupMap = new Map<string, {
      groupId: string;
      groupName: string;
      heads: Map<string, {
        headId: string;
        headName: string;
        total: number;
        count: number;
        expenses: typeof expenses;
      }>;
      total: number;
      count: number;
    }>();

    const uncategorizedExpenses: typeof expenses = [];
    let uncategorizedTotal = 0;
    let grandTotal = 0;
    let grandCount = 0;

    for (const expense of expenses) {
      const amount = parseFloat(expense.amount.toString());
      grandTotal += amount;
      grandCount += 1;

      if (!expense.expenseHead) {
        uncategorizedExpenses.push(expense);
        uncategorizedTotal += amount;
        continue;
      }

      const group = expense.expenseHead.group;
      const head = expense.expenseHead;

      if (!groupMap.has(group.id)) {
        groupMap.set(group.id, {
          groupId: group.id,
          groupName: group.name,
          heads: new Map(),
          total: 0,
          count: 0,
        });
      }

      const g = groupMap.get(group.id)!;
      g.total += amount;
      g.count += 1;

      if (!g.heads.has(head.id)) {
        g.heads.set(head.id, {
          headId: head.id,
          headName: head.name,
          total: 0,
          count: 0,
          expenses: [],
        });
      }

      const h = g.heads.get(head.id)!;
      h.total += amount;
      h.count += 1;
      h.expenses.push(expense);
    }

    // Build response
    const groups = Array.from(groupMap.values()).map((g) => ({
      groupId: g.groupId,
      groupName: g.groupName,
      total: g.total,
      count: g.count,
      heads: Array.from(g.heads.values()).map((h) => ({
        headId: h.headId,
        headName: h.headName,
        total: h.total,
        count: h.count,
        expenses: h.expenses,
      })),
    }));

    res.json({
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      groups,
      uncategorized: {
        total: uncategorizedTotal,
        count: uncategorizedExpenses.length,
        expenses: uncategorizedExpenses,
      },
      grandTotal: {
        total: grandTotal,
        count: grandCount,
      },
    });
  } catch (error) {
    console.error('Categorized expense report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
