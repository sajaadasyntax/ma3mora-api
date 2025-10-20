import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(blockAuditorWrites);

const createExpenseSchema = z.object({
  inventoryId: z.string().optional(),
  section: z.enum(['GROCERY', 'BAKERY']).optional(),
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANK']),
  description: z.string().min(1),
});

const createOpeningBalanceSchema = z.object({
  scope: z.enum(['CASHBOX', 'CUSTOMER', 'SUPPLIER']),
  refId: z.string().optional(),
  amount: z.number(),
  notes: z.string().optional(),
});

router.get('/expenses', async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;
    const where: any = {};

    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    const expenses = await prisma.expense.findMany({
      where,
      include: {
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(expenses);
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/expenses', requireRole('ACCOUNTANT'), createAuditLog('Expense'), async (req: AuthRequest, res) => {
  try {
    const data = createExpenseSchema.parse(req.body);

    const expense = await prisma.expense.create({
      data: {
        ...data,
        createdBy: req.user!.id,
      },
      include: {
        inventory: true,
      },
    });

    res.status(201).json(expense);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create expense error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/opening-balances', async (req: AuthRequest, res) => {
  try {
    const { scope } = req.query;
    const where: any = {};

    if (scope) where.scope = scope;

    const balances = await prisma.openingBalance.findMany({
      where,
      include: {
        customer: true,
        supplier: true,
      },
      orderBy: { openedAt: 'desc' },
    });

    res.json(balances);
  } catch (error) {
    console.error('Get opening balances error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/opening-balances', requireRole('ACCOUNTANT'), createAuditLog('OpeningBalance'), async (req: AuthRequest, res) => {
  try {
    const data = createOpeningBalanceSchema.parse(req.body);

    const balance = await prisma.openingBalance.create({
      data,
      include: {
        customer: true,
        supplier: true,
      },
    });

    res.status(201).json(balance);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create opening balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/balance/summary', requireRole('ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;

    // Sales summary
    const salesWhere: any = {};
    if (inventoryId) salesWhere.inventoryId = inventoryId;
    if (section) salesWhere.section = section;

    const salesInvoices = await prisma.salesInvoice.findMany({
      where: salesWhere,
    });

    const totalSales = salesInvoices.reduce(
      (sum, inv) => sum.add(inv.total),
      new Prisma.Decimal(0)
    );

    const totalReceived = salesInvoices.reduce(
      (sum, inv) => sum.add(inv.paidAmount),
      new Prisma.Decimal(0)
    );

    const totalSalesDebt = totalSales.sub(totalReceived);

    // Procurement summary
    const procWhere: any = {};
    if (inventoryId) procWhere.inventoryId = inventoryId;
    if (section) procWhere.section = section;

    const procOrders = await prisma.procOrder.findMany({
      where: procWhere,
    });

    const totalProcurement = procOrders.reduce(
      (sum, order) => sum.add(order.total),
      new Prisma.Decimal(0)
    );

    // Expenses summary
    const expensesWhere: any = {};
    if (inventoryId) expensesWhere.inventoryId = inventoryId;
    if (section) expensesWhere.section = section;

    const expenses = await prisma.expense.findMany({
      where: expensesWhere,
    });

    const totalExpenses = expenses.reduce(
      (sum, exp) => sum.add(exp.amount),
      new Prisma.Decimal(0)
    );

    // Opening balances
    const openingBalances = await prisma.openingBalance.findMany({
      where: { scope: 'CASHBOX' },
    });

    const totalOpeningBalance = openingBalances.reduce(
      (sum, bal) => sum.add(bal.amount),
      new Prisma.Decimal(0)
    );

    const netBalance = totalOpeningBalance
      .add(totalReceived)
      .sub(totalProcurement)
      .sub(totalExpenses);

    res.json({
      sales: {
        total: totalSales.toFixed(2),
        received: totalReceived.toFixed(2),
        debt: totalSalesDebt.toFixed(2),
        count: salesInvoices.length,
      },
      procurement: {
        total: totalProcurement.toFixed(2),
        count: procOrders.length,
      },
      expenses: {
        total: totalExpenses.toFixed(2),
        count: expenses.length,
      },
      balance: {
        opening: totalOpeningBalance.toFixed(2),
        net: netBalance.toFixed(2),
      },
    });
  } catch (error) {
    console.error('Get balance summary error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/audit', requireRole('AUDITOR', 'ACCOUNTANT'), async (req: AuthRequest, res) => {
  try {
    const { entity, entityId, userId } = req.query;
    const where: any = {};

    if (entity) where.entity = entity;
    if (entityId) where.entityId = entityId;
    if (userId) where.userId = userId;

    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: { id: true, username: true, role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json(logs);
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

