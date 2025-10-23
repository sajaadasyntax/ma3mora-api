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

// Middleware to check if balance is closed
async function checkBalanceOpen(req: AuthRequest, res: any, next: any) {
  try {
    const openBalance = await prisma.openingBalance.findFirst({
      where: { isClosed: false },
    });

    if (!openBalance) {
      return res.status(400).json({ 
        error: 'الحساب مغلق. يرجى فتح حساب جديد قبل إجراء أي معاملات.' 
      });
    }

    next();
  } catch (error) {
    console.error('Check balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

router.post('/expenses', requireRole('ACCOUNTANT'), checkBalanceOpen, createAuditLog('Expense'), async (req: AuthRequest, res) => {
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

router.get('/liquid-cash', requireRole('ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;

    // Get all payments grouped by method
    const payments = await prisma.salesPayment.findMany({
      where: {
        invoice: {
          ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
          ...(section ? { section: section as any } : {}),
        }
      },
      include: {
        invoice: {
          include: {
            inventory: true
          }
        }
      }
    });

    // Calculate totals by payment method
    const cashTotal = payments
      .filter(p => p.method === 'CASH')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankTotal = payments
      .filter(p => p.method === 'BANK')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankNileTotal = payments
      .filter(p => p.method === 'BANK_NILE')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const totalLiquid = cashTotal.add(bankTotal).add(bankNileTotal);

    // Get expenses by method
    const expenses = await prisma.expense.findMany({
      where: {
        ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
        ...(section ? { section: section as any } : {}),
      }
    });

    const cashExpenses = expenses
      .filter(e => e.method === 'CASH')
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const bankExpenses = expenses
      .filter(e => e.method === 'BANK')
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const bankNileExpenses = expenses
      .filter(e => e.method === 'BANK_NILE')
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    // Calculate net liquid cash
    const netCash = cashTotal.sub(cashExpenses);
    const netBank = bankTotal.sub(bankExpenses);
    const netBankNile = bankNileTotal.sub(bankNileExpenses);
    const netTotal = netCash.add(netBank).add(netBankNile);

    res.json({
      payments: {
        cash: {
          total: cashTotal.toFixed(2),
          count: payments.filter(p => p.method === 'CASH').length
        },
        bank: {
          total: bankTotal.toFixed(2),
          count: payments.filter(p => p.method === 'BANK').length
        },
        bankNile: {
          total: bankNileTotal.toFixed(2),
          count: payments.filter(p => p.method === 'BANK_NILE').length
        },
        total: totalLiquid.toFixed(2)
      },
      expenses: {
        cash: {
          total: cashExpenses.toFixed(2),
          count: expenses.filter(e => e.method === 'CASH').length
        },
        bank: {
          total: bankExpenses.toFixed(2),
          count: expenses.filter(e => e.method === 'BANK').length
        },
        bankNile: {
          total: bankNileExpenses.toFixed(2),
          count: expenses.filter(e => e.method === 'BANK_NILE').length
        }
      },
      net: {
        cash: netCash.toFixed(2),
        bank: netBank.toFixed(2),
        bankNile: netBankNile.toFixed(2),
        total: netTotal.toFixed(2)
      }
    });
  } catch (error) {
    console.error('Get liquid cash error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/balance/close', requireRole('ACCOUNTANT'), async (req: AuthRequest, res) => {
  try {
    // Close all opening balances
    await prisma.openingBalance.updateMany({
      where: { isClosed: false },
      data: {
        isClosed: true,
        closedAt: new Date(),
      },
    });

    res.json({ message: 'تم إقفال الحساب بنجاح' });
  } catch (error) {
    console.error('Close balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/balance/open', requireRole('ACCOUNTANT'), async (req: AuthRequest, res) => {
  try {
    const { amount, notes } = req.body;

    // Clear all financial data when opening new balance
    await prisma.$transaction(async (tx) => {
      // Delete all sales invoices and related data
      await tx.salesPayment.deleteMany({});
      await tx.salesInvoice.deleteMany({});
      
      // Delete all procurement orders
      await tx.procOrder.deleteMany({});
      
      // Delete all expenses
      await tx.expense.deleteMany({});
      
      // Create new opening balance
      const openingBalance = await tx.openingBalance.create({
        data: {
          scope: 'CASHBOX',
          amount: new Prisma.Decimal(amount),
          notes: notes || 'رصيد افتتاحي جديد',
        },
      });
      
      return openingBalance;
    });

    res.json({ message: 'تم فتح حساب جديد بنجاح وتم مسح جميع البيانات المالية السابقة' });
  } catch (error) {
    console.error('Open balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/balance/status', requireRole('ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    // Check if any balance is open
    const openBalance = await prisma.openingBalance.findFirst({
      where: { isClosed: false },
      orderBy: { openedAt: 'desc' },
    });

    res.json({
      isOpen: !!openBalance,
      lastBalance: openBalance,
    });
  } catch (error) {
    console.error('Get balance status error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/balance/sessions', requireRole('ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    // Get all balance sessions (closed balances)
    const sessions = await prisma.openingBalance.findMany({
      where: { isClosed: true },
      orderBy: { closedAt: 'desc' },
      include: {
        salesInvoices: {
          select: { id: true }
        },
        procOrders: {
          select: { id: true }
        },
        expenses: {
          select: { id: true }
        }
      }
    });

    // Calculate summary for each session
    const sessionsWithSummary = await Promise.all(
      sessions.map(async (session) => {
        // Get sales data for this session
        const salesInvoices = await prisma.salesInvoice.findMany({
          where: {
            createdAt: {
              gte: session.openedAt,
              lte: session.closedAt || new Date(),
            }
          },
          include: {
            payments: true,
          }
        });

        const totalSales = salesInvoices.reduce((sum, inv) => 
          sum.add(inv.total), new Prisma.Decimal(0)
        );
        const totalReceived = salesInvoices.reduce((sum, inv) => 
          sum.add(inv.payments.reduce((pSum, p) => pSum.add(p.amount), new Prisma.Decimal(0))), 
          new Prisma.Decimal(0)
        );
        const totalDebt = totalSales.sub(totalReceived);

        // Get procurement data for this session
        const procurementOrders = await prisma.procOrder.findMany({
          where: {
            createdAt: {
              gte: session.openedAt,
              lte: session.closedAt || new Date(),
            }
          }
        });

        const totalProcurement = procurementOrders.reduce((sum: Prisma.Decimal, order: any) => 
          sum.add(order.total), new Prisma.Decimal(0)
        );

        // Get expenses data for this session
        const expenses = await prisma.expense.findMany({
          where: {
            createdAt: {
              gte: session.openedAt,
              lte: session.closedAt || new Date(),
            }
          }
        });

        const totalExpenses = expenses.reduce((sum, exp) => 
          sum.add(exp.amount), new Prisma.Decimal(0)
        );

        const profit = totalReceived.sub(totalProcurement).sub(totalExpenses);

        return {
          ...session,
          summary: {
            sales: {
              total: totalSales.toFixed(2),
              received: totalReceived.toFixed(2),
              debt: totalDebt.toFixed(2),
              count: salesInvoices.length,
            },
            procurement: {
              total: totalProcurement.toFixed(2),
              count: procurementOrders.length,
            },
            expenses: {
              total: totalExpenses.toFixed(2),
              count: expenses.length,
            },
            profit: profit.toFixed(2),
            netBalance: session.amount.add(profit).toFixed(2),
          }
        };
      })
    );

    res.json(sessionsWithSummary);
  } catch (error) {
    console.error('Get balance sessions error:', error);
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

