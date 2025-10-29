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
  method: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  description: z.string().min(1),
});

const createOpeningBalanceSchema = z.object({
  scope: z.enum(['CASHBOX', 'CUSTOMER', 'SUPPLIER']),
  refId: z.string().optional(),
  amount: z.number(),
  paymentMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']).default('CASH'),
  notes: z.string().optional(),
});

const createCashExchangeSchema = z.object({
  amount: z.number().positive(),
  fromMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  toMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  receiptNumber: z.string().optional(),
  receiptUrl: z.string().optional(),
  notes: z.string().optional(),
}).refine((data) => {
  // fromMethod and toMethod must be different
  return data.fromMethod !== data.toMethod;
}, {
  message: 'من و إلى يجب أن يكونا مختلفين',
  path: ['toMethod'],
}).refine((data) => {
  // Receipt number is required when exchanging TO a bank (fromMethod is CASH and toMethod is BANK/BANK_NILE)
  // OR when exchanging FROM a bank (fromMethod is BANK/BANK_NILE and toMethod is CASH)
  const exchangingToBank = data.fromMethod === 'CASH' && (data.toMethod === 'BANK' || data.toMethod === 'BANK_NILE');
  const exchangingFromBank = (data.fromMethod === 'BANK' || data.fromMethod === 'BANK_NILE') && data.toMethod === 'CASH';
  
  if (exchangingToBank || exchangingFromBank) {
    return !!data.receiptNumber && data.receiptNumber.length > 0;
  }
  return true; // Receipt number optional when exchanging between banks
}, {
  message: 'رقم الإيصال مطلوب عند صرف نقد إلى بنك أو استرجاع من بنك',
  path: ['receiptNumber'],
});

router.get('/expenses', async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;
    
    // Get regular expenses
    const expenseWhere: any = {};
    if (inventoryId) expenseWhere.inventoryId = inventoryId;
    if (section) expenseWhere.section = section;

    const expenses = await prisma.expense.findMany({
      where: expenseWhere,
      include: {
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get paid salaries (only where paidAt is not null)
    const paidSalaries = await prisma.salary.findMany({
      where: {
        paidAt: { not: null },
      },
      include: {
        employee: {
          select: { name: true, position: true },
        },
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Get paid advances (only where paidAt is not null)
    const paidAdvances = await prisma.advance.findMany({
      where: {
        paidAt: { not: null },
      },
      include: {
        employee: {
          select: { name: true, position: true },
        },
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Transform salaries to expense-like format
    const salaryExpenses = paidSalaries.map(salary => ({
      id: salary.id,
      type: 'SALARY',
      description: `راتب - ${salary.employee.name} (${salary.month}/${salary.year})`,
      amount: salary.amount.toString(),
      method: (salary as any).paymentMethod,
      creator: salary.creator,
      createdAt: salary.paidAt || salary.createdAt,
      employee: salary.employee,
      month: salary.month,
      year: salary.year,
      notes: salary.notes,
    }));

    // Transform advances to expense-like format
    const advanceExpenses = paidAdvances.map(advance => ({
      id: advance.id,
      type: 'ADVANCE',
      description: `سلفية - ${advance.employee.name}${advance.reason ? ` (${advance.reason})` : ''}`,
      amount: advance.amount.toString(),
      method: (advance as any).paymentMethod,
      creator: advance.creator,
      createdAt: advance.paidAt || advance.createdAt,
      employee: advance.employee,
      reason: advance.reason,
      notes: advance.notes,
    }));

    // Transform regular expenses
    const regularExpenses = expenses.map(expense => ({
      id: expense.id,
      type: 'EXPENSE',
      description: expense.description,
      amount: expense.amount.toString(),
      method: expense.method,
      creator: expense.creator,
      createdAt: expense.createdAt,
      inventory: expense.inventory,
      inventoryId: expense.inventoryId,
      section: expense.section,
    }));

    // Combine all expenses (regular expenses, salaries, advances)
    // Note: Procurement payments (ProcOrderPayment) and Sales payments (SalesPayment) 
    // are explicitly excluded as they are not expenses but business transactions
    const allExpenses = [
      ...regularExpenses,
      ...salaryExpenses,
      ...advanceExpenses,
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(allExpenses);
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Middleware to check if balance is closed - optimized with indexed query
async function checkBalanceOpen(req: AuthRequest, res: any, next: any) {
  try {
    // Use indexed query for better performance
    const openBalance = await prisma.openingBalance.findFirst({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      orderBy: { openedAt: 'desc' },
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

// Helper to compute available balance per payment method (CASH, BANK, BANK_NILE)
async function getAvailableByMethod() {
  // Opening balances (open cashbox only)
  const openingBalances = await prisma.openingBalance.findMany({
    where: { scope: 'CASHBOX', isClosed: false },
  });

  const opening = {
    CASH: openingBalances.filter((b: any) => b.paymentMethod === 'CASH').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
    BANK: openingBalances.filter((b: any) => b.paymentMethod === 'BANK').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
    BANK_NILE: openingBalances.filter((b: any) => b.paymentMethod === 'BANK_NILE').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
  } as const;

  // Sales payments (only confirmed invoices)
  const salesPays = await prisma.salesPayment.findMany({
    where: { invoice: { paymentConfirmed: true } },
  });
  const salesIn = {
    CASH: salesPays.filter(p => p.method === 'CASH').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    BANK: salesPays.filter(p => p.method === 'BANK').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    BANK_NILE: salesPays.filter(p => p.method === 'BANK_NILE').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
  } as const;

  // Expenses
  const expenses = await prisma.expense.findMany();
  const expOut = {
    CASH: expenses.filter(e => e.method === 'CASH').reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
    BANK: expenses.filter(e => e.method === 'BANK').reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
    BANK_NILE: expenses.filter(e => e.method === 'BANK_NILE').reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
  } as const;

  // Salaries (paid)
  const paidSalaries = await prisma.salary.findMany({ where: { paidAt: { not: null } } });
  const salOut = {
    CASH: paidSalaries.filter((s: any) => s.paymentMethod === 'CASH').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
    BANK: paidSalaries.filter((s: any) => s.paymentMethod === 'BANK').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
    BANK_NILE: paidSalaries.filter((s: any) => s.paymentMethod === 'BANK_NILE').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
  } as const;

  // Advances (paid)
  const paidAdvances = await prisma.advance.findMany({ where: { paidAt: { not: null } } });
  const advOut = {
    CASH: paidAdvances.filter((a: any) => a.paymentMethod === 'CASH').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
    BANK: paidAdvances.filter((a: any) => a.paymentMethod === 'BANK').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
    BANK_NILE: paidAdvances.filter((a: any) => a.paymentMethod === 'BANK_NILE').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
  } as const;

  // Procurement payments (only confirmed orders)
  const procPays = await prisma.procOrderPayment.findMany({ where: { order: { paymentConfirmed: true } } });
  const procOut = {
    CASH: procPays.filter(p => p.method === 'CASH').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    BANK: procPays.filter(p => p.method === 'BANK').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    BANK_NILE: procPays.filter(p => p.method === 'BANK_NILE').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
  } as const;

  // Cash exchanges
  const exchanges = await (prisma as any).cashExchange.findMany();
  const exImpact = { CASH: new Prisma.Decimal(0), BANK: new Prisma.Decimal(0), BANK_NILE: new Prisma.Decimal(0) } as Record<'CASH'|'BANK'|'BANK_NILE', Prisma.Decimal>;
  exchanges.forEach((e: any) => {
    const fromM = e.fromMethod as 'CASH'|'BANK'|'BANK_NILE';
    const toM = e.toMethod as 'CASH'|'BANK'|'BANK_NILE';
    exImpact[fromM] = exImpact[fromM].sub(e.amount);
    exImpact[toM] = exImpact[toM].add(e.amount);
  });

  return {
    CASH: opening.CASH.add(salesIn.CASH).add(exImpact.CASH).sub(expOut.CASH).sub(salOut.CASH).sub(advOut.CASH).sub(procOut.CASH),
    BANK: opening.BANK.add(salesIn.BANK).add(exImpact.BANK).sub(expOut.BANK).sub(salOut.BANK).sub(advOut.BANK).sub(procOut.BANK),
    BANK_NILE: opening.BANK_NILE.add(salesIn.BANK_NILE).add(exImpact.BANK_NILE).sub(expOut.BANK_NILE).sub(salOut.BANK_NILE).sub(advOut.BANK_NILE).sub(procOut.BANK_NILE),
  };
}

router.post('/expenses', requireRole('ACCOUNTANT', 'MANAGER'), checkBalanceOpen, createAuditLog('Expense'), async (req: AuthRequest, res) => {
  try {
    const data = createExpenseSchema.parse(req.body);

    // Enforce sufficient balance for chosen payment method
    const available = await getAvailableByMethod();
    const method = data.method as 'CASH'|'BANK'|'BANK_NILE';
    if (available[method].lessThan(data.amount)) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ لطريقة الدفع المحددة' });
    }

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

router.post('/opening-balances', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('OpeningBalance'), async (req: AuthRequest, res) => {
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

router.get('/balance/summary', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
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
      (sum, inv) => sum.add(inv.paidAmount || 0),
      new Prisma.Decimal(0)
    );

    const totalSalesDebt = totalSales.sub(totalReceived);

    // Procurement summary - exclude cancelled orders
    const procWhere: any = {
      status: { not: 'CANCELLED' }
    };
    if (inventoryId) procWhere.inventoryId = inventoryId;
    if (section) procWhere.section = section;

    const procOrders = await prisma.procOrder.findMany({
      where: procWhere,
    });

    // Get cancelled orders separately for reporting
    const cancelledProcWhere: any = {
      status: 'CANCELLED'
    };
    if (inventoryId) cancelledProcWhere.inventoryId = inventoryId;
    if (section) cancelledProcWhere.section = section;

    const cancelledProcOrders = await prisma.procOrder.findMany({
      where: cancelledProcWhere,
    });

    const totalProcurement = procOrders.reduce(
      (sum, order) => sum.add(order.total),
      new Prisma.Decimal(0)
    );

    const totalCancelledProcurement = cancelledProcOrders.reduce(
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

    // Get paid salaries (only where paidAt is not null)
    const paidSalaries = await prisma.salary.findMany({
      where: {
        paidAt: { not: null },
      },
    });

    // Get paid advances (only where paidAt is not null)
    const paidAdvances = await prisma.advance.findMany({
      where: {
        paidAt: { not: null },
      },
    });

    const totalExpenses = expenses.reduce(
      (sum, exp) => sum.add(exp.amount),
      new Prisma.Decimal(0)
    );

    const totalSalaries = paidSalaries.reduce(
      (sum, salary) => sum.add(salary.amount),
      new Prisma.Decimal(0)
    );

    const totalAdvances = paidAdvances.reduce(
      (sum, advance) => sum.add(advance.amount),
      new Prisma.Decimal(0)
    );

    const totalAllExpenses = totalExpenses.add(totalSalaries).add(totalAdvances);

    // Opening balances - optimized query for open balances only
    const openingBalances = await prisma.openingBalance.findMany({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      orderBy: { openedAt: 'desc' },
    });

    // Calculate total opening balance by payment method
    const openingBalanceByMethod = {
      CASH: openingBalances.filter(bal => (bal as any).paymentMethod === 'CASH').reduce((sum, bal) => sum.add(bal.amount), new Prisma.Decimal(0)),
      BANK: openingBalances.filter(bal => (bal as any).paymentMethod === 'BANK').reduce((sum, bal) => sum.add(bal.amount), new Prisma.Decimal(0)),
      BANK_NILE: openingBalances.filter(bal => (bal as any).paymentMethod === 'BANK_NILE').reduce((sum, bal) => sum.add(bal.amount), new Prisma.Decimal(0)),
    };
    
    const totalOpeningBalance = openingBalanceByMethod.CASH.add(openingBalanceByMethod.BANK).add(openingBalanceByMethod.BANK_NILE);

    const netBalance = totalOpeningBalance
      .add(totalReceived)
      .sub(totalProcurement)
      .sub(totalAllExpenses);

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
        cancelled: {
          total: totalCancelledProcurement.toFixed(2),
          count: cancelledProcOrders.length,
        },
      },
      expenses: {
        total: totalAllExpenses.toFixed(2),
        count: expenses.length + paidSalaries.length + paidAdvances.length,
        regular: totalExpenses.toFixed(2),
        salaries: totalSalaries.toFixed(2),
        advances: totalAdvances.toFixed(2),
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

router.get('/liquid-cash', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;

    // Get all payments grouped by method with invoice items
    const payments = await prisma.salesPayment.findMany({
      where: {
        invoice: {
          ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
          ...(section ? { section: section as any } : {}),
          paymentConfirmed: true,
        }
      },
      include: {
        invoice: {
          include: {
            inventory: true,
            customer: true,
            items: {
              include: {
                item: true
              }
            }
          }
        }
      },
      orderBy: {
        paidAt: 'desc'
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
      },
      orderBy: {
        createdAt: 'desc'
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

    // Get paid salaries (only where paidAt is not null)
    const paidSalaries = await prisma.salary.findMany({
      where: {
        paidAt: { not: null },
      },
      orderBy: {
        paidAt: 'desc'
      }
    });

    const cashSalaries = paidSalaries
      .filter(s => (s as any).paymentMethod === 'CASH')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));

    const bankSalaries = paidSalaries
      .filter(s => (s as any).paymentMethod === 'BANK')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));

    const bankNileSalaries = paidSalaries
      .filter(s => (s as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));

    // Get paid advances (only where paidAt is not null)
    const paidAdvances = await prisma.advance.findMany({
      where: {
        paidAt: { not: null },
      },
      orderBy: {
        paidAt: 'desc'
      }
    });

    const cashAdvances = paidAdvances
      .filter(a => (a as any).paymentMethod === 'CASH')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    const bankAdvances = paidAdvances
      .filter(a => (a as any).paymentMethod === 'BANK')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    const bankNileAdvances = paidAdvances
      .filter(a => (a as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    // Get cash exchanges (transfers between payment methods)
    const cashExchanges = await (prisma as any).cashExchange.findMany({
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Calculate cash exchanges impact on each method
    let cashExchangeImpact = {
      CASH: new Prisma.Decimal(0),
      BANK: new Prisma.Decimal(0),
      BANK_NILE: new Prisma.Decimal(0)
    };

    cashExchanges.forEach((exchange: any) => {
      // Subtract from fromMethod
      cashExchangeImpact[exchange.fromMethod as keyof typeof cashExchangeImpact] = 
        cashExchangeImpact[exchange.fromMethod as keyof typeof cashExchangeImpact].sub(exchange.amount);
      // Add to toMethod
      cashExchangeImpact[exchange.toMethod as keyof typeof cashExchangeImpact] = 
        cashExchangeImpact[exchange.toMethod as keyof typeof cashExchangeImpact].add(exchange.amount);
    });

    // Get procurement payments
    const procPayments = await prisma.procOrderPayment.findMany({
      where: {
        order: {
          status: { not: 'CANCELLED' },
          paymentConfirmed: true,
          ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
          ...(section ? { section: section as any } : {}),
        }
      },
      include: {
        order: {
          include: {
            inventory: true,
            supplier: true
          }
        },
        recordedByUser: {
          select: { id: true, username: true }
        }
      },
      orderBy: {
        paidAt: 'desc'
      }
    });

    const cashProcPayments = procPayments
      .filter(p => p.method === 'CASH')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankProcPayments = procPayments
      .filter(p => p.method === 'BANK')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankNileProcPayments = procPayments
      .filter(p => p.method === 'BANK_NILE')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    // Get procurement orders with items for expenses tracking - exclude cancelled orders
    const procOrders = await prisma.procOrder.findMany({
      where: {
        status: { not: 'CANCELLED' },
        ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
        ...(section ? { section: section as any } : {}),
      },
      include: {
        supplier: true,
        inventory: true,
        items: {
          include: {
            item: true
          }
        },
        payments: {
          include: {
            recordedByUser: {
              select: { id: true, username: true }
            }
          },
          orderBy: { paidAt: 'desc' }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Aggregate items from sales invoices by payment method
    const itemsByMethod: any = {
      CASH: {},
      BANK: {},
      BANK_NILE: {}
    };

    payments.forEach(payment => {
      const method = payment.method;
      payment.invoice.items.forEach(invoiceItem => {
        const itemName = invoiceItem.item.name;
        if (!itemsByMethod[method][itemName]) {
          itemsByMethod[method][itemName] = {
            quantity: new Prisma.Decimal(0),
            totalAmount: new Prisma.Decimal(0),
            unitPrice: invoiceItem.unitPrice,
            count: 0
          };
        }
        itemsByMethod[method][itemName].quantity = itemsByMethod[method][itemName].quantity.add(invoiceItem.quantity);
        itemsByMethod[method][itemName].totalAmount = itemsByMethod[method][itemName].totalAmount.add(invoiceItem.lineTotal);
        itemsByMethod[method][itemName].count += 1;
      });
    });

    // Aggregate items from procurement orders
    const procItems: any = {};
    procOrders.forEach(order => {
      order.items.forEach(orderItem => {
        const itemName = orderItem.item.name;
        if (!procItems[itemName]) {
          procItems[itemName] = {
            quantity: new Prisma.Decimal(0),
            totalAmount: new Prisma.Decimal(0),
            unitCost: orderItem.unitCost,
            count: 0
          };
        }
        procItems[itemName].quantity = procItems[itemName].quantity.add(orderItem.quantity);
        procItems[itemName].totalAmount = procItems[itemName].totalAmount.add(orderItem.lineTotal);
        procItems[itemName].count += 1;
      });
    });

    // Get opening balances by payment method - optimized query
    const openingBalances = await prisma.openingBalance.findMany({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      orderBy: { openedAt: 'desc' },
    });

    const openingCash = openingBalances
      .filter(b => (b as any).paymentMethod === 'CASH')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    
    const openingBank = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    
    const openingBankNile = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    // Calculate net liquid cash (opening balance + payments - expenses - salaries - advances - proc payments + cash exchanges)
    const netCash = openingCash
      .add(cashTotal)
      .sub(cashExpenses)
      .sub(cashSalaries)
      .sub(cashAdvances)
      .sub(cashProcPayments)
      .add(cashExchangeImpact.CASH);
    
    const netBank = openingBank
      .add(bankTotal)
      .sub(bankExpenses)
      .sub(bankSalaries)
      .sub(bankAdvances)
      .sub(bankProcPayments)
      .add(cashExchangeImpact.BANK);
    
    const netBankNile = openingBankNile
      .add(bankNileTotal)
      .sub(bankNileExpenses)
      .sub(bankNileSalaries)
      .sub(bankNileAdvances)
      .sub(bankNileProcPayments)
      .add(cashExchangeImpact.BANK_NILE);
    
    const netTotal = netCash.add(netBank).add(netBankNile);

    // Format items data
    const formatItemsData = (items: any) => {
      return Object.entries(items).map(([itemName, itemData]: [string, any]) => ({
        name: itemName,
        quantity: itemData.quantity.toString(),
        totalAmount: itemData.totalAmount.toFixed(2),
        unitPrice: itemData.unitPrice ? itemData.unitPrice.toFixed(2) : itemData.unitCost ? itemData.unitCost.toFixed(2) : '0.00',
        count: itemData.count
      }));
    };

    res.json({
      payments: {
        cash: {
          total: cashTotal.toFixed(2),
          count: payments.filter(p => p.method === 'CASH').length,
          items: formatItemsData(itemsByMethod.CASH)
        },
        bank: {
          total: bankTotal.toFixed(2),
          count: payments.filter(p => p.method === 'BANK').length,
          items: formatItemsData(itemsByMethod.BANK)
        },
        bankNile: {
          total: bankNileTotal.toFixed(2),
          count: payments.filter(p => p.method === 'BANK_NILE').length,
          items: formatItemsData(itemsByMethod.BANK_NILE)
        },
        total: totalLiquid.toFixed(2),
        details: payments.map(p => ({
          id: p.id,
          invoiceNumber: p.invoice.invoiceNumber,
          customer: p.invoice.customer?.name || 'غير محدد',
          amount: p.amount.toFixed(2),
          method: p.method,
          paidAt: p.paidAt,
          receiptNumber: (p as any).receiptNumber || null,
          receiptUrl: p.receiptUrl || null,
          items: p.invoice.items.map(item => ({
            name: item.item.name,
            quantity: item.quantity.toString(),
            unitPrice: item.unitPrice.toFixed(2),
            lineTotal: item.lineTotal.toFixed(2)
          }))
        }))
      },
      expenses: {
        cash: {
          total: cashExpenses.toFixed(2),
          count: expenses.filter(e => e.method === 'CASH').length,
          items: expenses.filter(e => e.method === 'CASH').map(e => ({
            description: e.description,
            amount: e.amount.toFixed(2),
            createdAt: e.createdAt
          }))
        },
        bank: {
          total: bankExpenses.toFixed(2),
          count: expenses.filter(e => e.method === 'BANK').length,
          items: expenses.filter(e => e.method === 'BANK').map(e => ({
            description: e.description,
            amount: e.amount.toFixed(2),
            createdAt: e.createdAt
          }))
        },
        bankNile: {
          total: bankNileExpenses.toFixed(2),
          count: expenses.filter(e => e.method === 'BANK_NILE').length,
          items: expenses.filter(e => e.method === 'BANK_NILE').map(e => ({
            description: e.description,
            amount: e.amount.toFixed(2),
            createdAt: e.createdAt
          }))
        }
      },
      salaries: {
        cash: {
          total: cashSalaries.toFixed(2),
          count: paidSalaries.filter(s => (s as any).paymentMethod === 'CASH').length
        },
        bank: {
          total: bankSalaries.toFixed(2),
          count: paidSalaries.filter(s => (s as any).paymentMethod === 'BANK').length
        },
        bankNile: {
          total: bankNileSalaries.toFixed(2),
          count: paidSalaries.filter(s => (s as any).paymentMethod === 'BANK_NILE').length
        },
        total: cashSalaries.add(bankSalaries).add(bankNileSalaries).toFixed(2)
      },
      advances: {
        cash: {
          total: cashAdvances.toFixed(2),
          count: paidAdvances.filter(a => (a as any).paymentMethod === 'CASH').length
        },
        bank: {
          total: bankAdvances.toFixed(2),
          count: paidAdvances.filter(a => (a as any).paymentMethod === 'BANK').length
        },
        bankNile: {
          total: bankNileAdvances.toFixed(2),
          count: paidAdvances.filter(a => (a as any).paymentMethod === 'BANK_NILE').length
        },
        total: cashAdvances.add(bankAdvances).add(bankNileAdvances).toFixed(2)
      },
      procurementPayments: {
        cash: {
          total: cashProcPayments.toFixed(2),
          count: procPayments.filter(p => p.method === 'CASH').length
        },
        bank: {
          total: bankProcPayments.toFixed(2),
          count: procPayments.filter(p => p.method === 'BANK').length
        },
        bankNile: {
          total: bankNileProcPayments.toFixed(2),
          count: procPayments.filter(p => p.method === 'BANK_NILE').length
        },
        total: cashProcPayments.add(bankProcPayments).add(bankNileProcPayments).toFixed(2)
      },
      cashExchanges: {
        cash: cashExchangeImpact.CASH.toFixed(2),
        bank: cashExchangeImpact.BANK.toFixed(2),
        bankNile: cashExchangeImpact.BANK_NILE.toFixed(2),
        details: cashExchanges.map((e: any) => ({
          id: e.id,
          amount: e.amount.toString(),
          fromMethod: e.fromMethod,
          toMethod: e.toMethod,
          receiptNumber: e.receiptNumber,
          createdAt: e.createdAt,
          notes: e.notes
        }))
      },
      procurement: {
        items: formatItemsData(procItems),
        orders: procOrders.map(order => ({
          orderNumber: order.orderNumber,
          supplier: order.supplier.name,
          total: order.total.toFixed(2),
          paidAmount: order.paidAmount.toFixed(2),
          items: order.items.map(item => ({
            name: item.item.name,
            quantity: item.quantity.toString(),
            unitCost: item.unitCost.toFixed(2),
            lineTotal: item.lineTotal.toFixed(2)
          }))
        }))
      },
      opening: {
        cash: openingCash.toFixed(2),
        bank: openingBank.toFixed(2),
        bankNile: openingBankNile.toFixed(2),
        total: openingCash.add(openingBank).add(openingBankNile).toFixed(2)
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

// Receivables (له) and Payables (عليه) report
router.get('/receivables-payables', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { section } = req.query;

    // Customers receivables: sum invoices total - paidAmount
    const customers = await prisma.customer.findMany({
      include: {
        salesInvoices: section
          ? { where: { section: section as any }, select: { total: true, paidAmount: true } }
          : { select: { total: true, paidAmount: true } },
      },
    });

    const receivables = customers
      .map((c) => {
        const total = c.salesInvoices.reduce((sum: Prisma.Decimal, inv: any) => sum.add(inv.total), new Prisma.Decimal(0));
        const paid = c.salesInvoices.reduce((sum: Prisma.Decimal, inv: any) => sum.add(inv.paidAmount || 0), new Prisma.Decimal(0));
        const remaining = total.sub(paid);
        return {
          id: c.id,
          name: c.name,
          division: c.division,
          total: total.toFixed(2),
          paid: paid.toFixed(2),
          remaining: remaining.toFixed(2),
        };
      })
      .filter((r) => new Prisma.Decimal(r.remaining).greaterThan(0));

    // Suppliers payables: sum procurement orders total - paidAmount, excluding cancelled
    const suppliers = await prisma.supplier.findMany({
      include: {
        procOrders: section
          ? { where: { status: { not: 'CANCELLED' }, section: section as any }, select: { total: true, paidAmount: true } }
          : { where: { status: { not: 'CANCELLED' } }, select: { total: true, paidAmount: true } },
      },
    });

    const payables = suppliers
      .map((s) => {
        const total = s.procOrders.reduce((sum: Prisma.Decimal, o: any) => sum.add(o.total), new Prisma.Decimal(0));
        const paid = s.procOrders.reduce((sum: Prisma.Decimal, o: any) => sum.add(o.paidAmount || 0), new Prisma.Decimal(0));
        const remaining = total.sub(paid);
        return {
          id: s.id,
          name: s.name,
          total: total.toFixed(2),
          paid: paid.toFixed(2),
          remaining: remaining.toFixed(2),
        };
      })
      .filter((p) => new Prisma.Decimal(p.remaining).greaterThan(0));

    const totals = {
      receivables: receivables.reduce((sum, r) => sum.add(r.remaining), new Prisma.Decimal(0)).toFixed(2),
      payables: payables.reduce((sum, p) => sum.add(p.remaining), new Prisma.Decimal(0)).toFixed(2),
    };

    res.json({ receivables, payables, totals });
  } catch (error) {
    console.error('Get receivables/payables error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/balance/close', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    // Close all opening balances for CASHBOX scope only - optimized with indexed query
    const closedCount = await prisma.openingBalance.updateMany({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      data: {
        isClosed: true,
        closedAt: new Date(),
      },
    });

    res.json({ 
      message: 'تم إقفال الحساب بنجاح',
      closedBalances: closedCount.count 
    });
  } catch (error) {
    console.error('Close balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/balance/open', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { cash = 0, bank = 0, bankNile = 0, notes } = req.body;

    // Ensure at least one balance is provided
    if (!cash && !bank && !bankNile) {
      return res.status(400).json({ error: 'يرجى إدخال رصيد افتتاحي على الأقل لطريقة دفع واحدة' });
    }

    // Close any existing open balances first
    await prisma.openingBalance.updateMany({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      data: {
        isClosed: true,
        closedAt: new Date(),
      },
    });

    // Create new opening balances for each payment method - optimized transaction
    const openingBalances = await prisma.$transaction(async (tx) => {
      const balances = [];
      
      if (cash > 0) {
        balances.push(await (tx.openingBalance as any).create({
          data: {
            scope: 'CASHBOX',
            amount: new Prisma.Decimal(cash),
            paymentMethod: 'CASH',
            notes: notes ? `رصيد افتتاحي - كاش - ${notes}` : 'رصيد افتتاحي - كاش',
          },
        }));
      }
      
      if (bank > 0) {
        balances.push(await (tx.openingBalance as any).create({
          data: {
            scope: 'CASHBOX',
            amount: new Prisma.Decimal(bank),
            paymentMethod: 'BANK',
            notes: notes ? `رصيد افتتاحي - بنكك - ${notes}` : 'رصيد افتتاحي - بنكك',
          },
        }));
      }
      
      if (bankNile > 0) {
        balances.push(await (tx.openingBalance as any).create({
          data: {
            scope: 'CASHBOX',
            amount: new Prisma.Decimal(bankNile),
            paymentMethod: 'BANK_NILE',
            notes: notes ? `رصيد افتتاحي - بنك النيل - ${notes}` : 'رصيد افتتاحي - بنك النيل',
          },
        }));
      }
      
      return balances;
    });

    res.json({ 
      message: 'تم فتح حساب جديد بنجاح',
      balances: openingBalances 
    });
  } catch (error) {
    console.error('Open balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/balance/status', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    // Check if any balance is open - optimized with indexed query
    const openBalances = await prisma.openingBalance.findMany({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      orderBy: { openedAt: 'desc' },
    });

    // Group by payment method
    const balancesByMethod = {
      CASH: openBalances.filter(b => (b as any).paymentMethod === 'CASH').reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
      BANK: openBalances.filter(b => (b as any).paymentMethod === 'BANK').reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
      BANK_NILE: openBalances.filter(b => (b as any).paymentMethod === 'BANK_NILE').reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
    };

    const total = balancesByMethod.CASH.add(balancesByMethod.BANK).add(balancesByMethod.BANK_NILE);

    res.json({
      isOpen: openBalances.length > 0,
      balances: balancesByMethod,
      total: total.toString(),
      lastOpenedAt: openBalances[0]?.openedAt || null,
    });
  } catch (error) {
    console.error('Get balance status error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/balance/sessions', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    // Get all balance sessions (closed balances)
    const sessions = await prisma.openingBalance.findMany({
      where: { isClosed: true },
      orderBy: { closedAt: 'desc' }
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

        // Get procurement data for this session - exclude cancelled orders
        const procurementOrders = await prisma.procOrder.findMany({
          where: {
            createdAt: {
              gte: session.openedAt,
              lte: session.closedAt || new Date(),
            },
            status: { not: 'CANCELLED' }
          }
        });

        // Get cancelled orders separately
        const cancelledProcOrders = await prisma.procOrder.findMany({
          where: {
            createdAt: {
              gte: session.openedAt,
              lte: session.closedAt || new Date(),
            },
            status: 'CANCELLED'
          }
        });

        const totalProcurement = procurementOrders.reduce((sum: Prisma.Decimal, order: any) => 
          sum.add(order.total), new Prisma.Decimal(0)
        );

        const totalCancelledProcurement = cancelledProcOrders.reduce((sum: Prisma.Decimal, order: any) => 
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
              cancelled: {
                total: totalCancelledProcurement.toFixed(2),
                count: cancelledProcOrders.length,
              },
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

router.get('/cash-exchanges', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const exchanges = await (prisma as any).cashExchange.findMany({
      include: {
        createdByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(exchanges);
  } catch (error) {
    console.error('Get cash exchanges error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/cash-exchanges', requireRole('ACCOUNTANT', 'MANAGER'), checkBalanceOpen, createAuditLog('CashExchange'), async (req: AuthRequest, res) => {
  try {
    const data = createCashExchangeSchema.parse(req.body);

    // Check receipt number uniqueness only if provided
    if (data.receiptNumber) {
      // Check if receipt number already exists in cash exchanges
      const existingExchange = await (prisma as any).cashExchange.findUnique({
        where: { receiptNumber: data.receiptNumber },
        include: {
          createdByUser: {
            select: { id: true, username: true },
          },
        },
      });

      if (existingExchange) {
        return res.status(400).json({ 
          error: 'رقم الإيصال مستخدم بالفعل',
          existingTransaction: {
            id: existingExchange.id,
            amount: existingExchange.amount.toString(),
            fromMethod: existingExchange.fromMethod,
            toMethod: existingExchange.toMethod,
            receiptNumber: existingExchange.receiptNumber,
            receiptUrl: existingExchange.receiptUrl,
            createdAt: existingExchange.createdAt,
            createdBy: existingExchange.createdByUser.username,
            notes: existingExchange.notes,
          }
        });
      }

      // Check if receipt number exists in sales payments
      const existingPayment = await prisma.salesPayment.findUnique({
        where: { receiptNumber: data.receiptNumber } as any,
        include: {
          invoice: {
            include: {
              customer: true,
            },
          },
          recordedByUser: {
            select: { id: true, username: true },
          },
        },
      });

      if (existingPayment) {
        return res.status(400).json({ 
          error: 'رقم الإيصال مستخدم بالفعل في دفعة مبيعات',
          existingTransaction: {
            id: existingPayment.id,
            invoiceId: existingPayment.invoiceId,
            invoiceNumber: (existingPayment as any).invoice.invoiceNumber,
            customer: (existingPayment as any).invoice.customer.name,
            amount: existingPayment.amount.toString(),
            method: existingPayment.method,
            receiptNumber: (existingPayment as any).receiptNumber,
            receiptUrl: existingPayment.receiptUrl,
            paidAt: existingPayment.paidAt,
            recordedBy: (existingPayment as any).recordedByUser.username,
            notes: existingPayment.notes,
          }
        });
      }
    }

    // Ensure fromMethod has enough balance
    const available = await getAvailableByMethod();
    const fromMethod = data.fromMethod as 'CASH'|'BANK'|'BANK_NILE';
    if (available[fromMethod].lessThan(data.amount)) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ في طريقة الدفع المصدر' });
    }

    const exchange = await (prisma as any).cashExchange.create({
      data: {
        amount: data.amount,
        fromMethod: data.fromMethod,
        toMethod: data.toMethod,
        receiptNumber: data.receiptNumber || null,
        receiptUrl: data.receiptUrl,
        notes: data.notes,
        createdBy: req.user!.id,
      },
      include: {
        createdByUser: {
          select: { id: true, username: true },
        },
      },
    });

    res.status(201).json(exchange);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'رقم الإيصال مستخدم بالفعل' });
      }
    }
    console.error('Create cash exchange error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/audit', requireRole('AUDITOR', 'ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
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

// Daily Report endpoint for mobile app
router.get('/daily-report', requireRole('AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date as string) : new Date();
    
    // Set date range for the day
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Get sales data
    const salesInvoices = await prisma.salesInvoice.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        customer: true,
        inventory: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: true,
      },
    });

    // Get procurement data
    const procOrders = await prisma.procOrder.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        supplier: true,
        inventory: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: true,
      },
    });

    // Get expenses
    const expenses = await prisma.expense.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    // Calculate totals
    const totalSales = salesInvoices.reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0));
    const totalSalesReceived = salesInvoices.reduce((sum, inv) => sum.add(inv.paidAmount), new Prisma.Decimal(0));
    const totalProcurement = procOrders.reduce((sum, order) => sum.add(order.total), new Prisma.Decimal(0));
    const totalProcurementPaid = procOrders.reduce((sum, order) => sum.add(order.paidAmount), new Prisma.Decimal(0));
    const totalExpenses = expenses.reduce((sum, exp) => sum.add(exp.amount), new Prisma.Decimal(0));

    const report = {
      date: targetDate.toISOString().split('T')[0],
      sales: {
        invoices: salesInvoices.length,
        total: totalSales,
        received: totalSalesReceived,
        pending: totalSales.sub(totalSalesReceived),
        invoiceList: salesInvoices.map(inv => ({
          number: inv.invoiceNumber,
          customer: inv.customer?.name || 'غير محدد',
          total: inv.total,
          paid: inv.paidAmount,
          status: inv.paymentStatus,
        })),
      },
      procurement: {
        orders: procOrders.length,
        total: totalProcurement,
        paid: totalProcurementPaid,
        pending: totalProcurement.sub(totalProcurementPaid),
        orderList: procOrders.map(order => ({
          number: order.orderNumber,
          supplier: order.supplier.name,
          total: order.total,
          paid: order.paidAmount,
          status: order.paymentConfirmed ? 'CONFIRMED' : 'PENDING',
        })),
      },
      expenses: {
        count: expenses.length,
        total: totalExpenses,
        items: expenses.map(exp => ({
          description: exp.description,
          amount: exp.amount,
          method: exp.method,
        })),
      },
      summary: {
        netCashFlow: totalSalesReceived.sub(totalProcurementPaid).sub(totalExpenses),
        totalRevenue: totalSales,
        totalCosts: totalProcurement.add(totalExpenses),
      },
    };

    res.json(report);
  } catch (error) {
    console.error('Daily report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get outstanding fees report for customers and suppliers
router.get('/outstanding-fees', requireRole('ACCOUNTANT', 'MANAGER', 'SALES_GROCERY', 'SALES_BAKERY'), async (req: AuthRequest, res) => {
  try {
    const { section, period } = req.query;
    
    // Calculate date range based on period
    let startDate: Date | null = null;
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    
    if (period === 'today') {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 1);
      startDate.setHours(0, 0, 0, 0);
    } else if (period === 'year') {
      startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 1);
      startDate.setHours(0, 0, 0, 0);
    }
    
    // Get customers with outstanding balances
    const customerWhere: any = {};
    if (section) {
      customerWhere.division = section;
    }
    
    const customers = await prisma.customer.findMany({
      where: customerWhere,
      include: {
        salesInvoices: {
          where: startDate ? {
            createdAt: { gte: startDate, lte: endDate },
          } : undefined,
        },
        openingBalance: {
          where: {
            isClosed: false,
            openedAt: startDate ? { gte: startDate, lte: endDate } : undefined,
          },
        },
      },
    });
    
    // Get suppliers with outstanding balances
    const suppliers = await prisma.supplier.findMany({
      include: {
        procOrders: {
          where: startDate ? {
            createdAt: { gte: startDate, lte: endDate },
          } : undefined,
        },
        openingBalance: {
          where: {
            isClosed: false,
            openedAt: startDate ? { gte: startDate, lte: endDate } : undefined,
          },
        },
      },
    });
    
    // Calculate outstanding for customers
    const customersOutstanding = customers.map(customer => {
      // Accounts receivable (what customer owes us)
      const invoicesTotal = customer.salesInvoices.reduce((sum, inv) => 
        sum.add(new Prisma.Decimal(inv.total)), new Prisma.Decimal(0));
      const invoicesPaid = customer.salesInvoices.reduce((sum, inv) => 
        sum.add(new Prisma.Decimal(inv.paidAmount)), new Prisma.Decimal(0));
      const accountsReceivable = invoicesTotal.sub(invoicesPaid);
      
      // Opening balance (what we owe customer - negative means they owe us, positive means we owe them)
      const openingBalance = customer.openingBalance.reduce((sum, ob) => 
        sum.add(new Prisma.Decimal(ob.amount)), new Prisma.Decimal(0));
      
      // Net outstanding: positive = customer owes us, negative = we owe customer
      const netOutstanding = accountsReceivable.add(openingBalance);
      
      return {
        id: customer.id,
        name: customer.name,
        type: customer.type,
        division: customer.division,
        phone: customer.phone,
        address: customer.address,
        accountsReceivable: accountsReceivable.toString(),
        openingBalance: openingBalance.toString(),
        netOutstanding: netOutstanding.toString(),
        outstandingType: netOutstanding.greaterThan(0) ? 'OWES_US' : netOutstanding.lessThan(0) ? 'WE_OWE' : 'SETTLED',
      };
    }).filter(c => c.netOutstanding !== '0');
    
    // Calculate outstanding for suppliers
    const suppliersOutstanding = suppliers.map(supplier => {
      // Accounts payable (what we owe supplier)
      const ordersTotal = supplier.procOrders.reduce((sum, order) => 
        sum.add(new Prisma.Decimal(order.total)), new Prisma.Decimal(0));
      const ordersPaid = supplier.procOrders.reduce((sum, order) => 
        sum.add(new Prisma.Decimal(order.paidAmount)), new Prisma.Decimal(0));
      const accountsPayable = ordersTotal.sub(ordersPaid);
      
      // Opening balance (what supplier owes us - negative means we owe them, positive means they owe us)
      const openingBalance = supplier.openingBalance.reduce((sum, ob) => 
        sum.add(new Prisma.Decimal(ob.amount)), new Prisma.Decimal(0));
      
      // Net outstanding: positive = we owe supplier, negative = supplier owes us
      const netOutstanding = accountsPayable.sub(openingBalance);
      
      return {
        id: supplier.id,
        name: supplier.name,
        phone: supplier.phone,
        address: supplier.address,
        accountsPayable: accountsPayable.toString(),
        openingBalance: openingBalance.toString(),
        netOutstanding: netOutstanding.toString(),
        outstandingType: netOutstanding.greaterThan(0) ? 'WE_OWE' : netOutstanding.lessThan(0) ? 'OWES_US' : 'SETTLED',
      };
    }).filter(s => s.netOutstanding !== '0');
    
    res.json({
      section: section || 'ALL',
      period: period || 'ALL',
      customers: customersOutstanding,
      suppliers: suppliersOutstanding,
      summary: {
        customersOwesUs: customersOutstanding
          .filter(c => c.outstandingType === 'OWES_US')
          .reduce((sum, c) => sum.add(new Prisma.Decimal(c.netOutstanding)), new Prisma.Decimal(0))
          .toString(),
        weOweCustomers: customersOutstanding
          .filter(c => c.outstandingType === 'WE_OWE')
          .reduce((sum, c) => sum.add(new Prisma.Decimal(c.netOutstanding).abs()), new Prisma.Decimal(0))
          .toString(),
        weOweSuppliers: suppliersOutstanding
          .filter(s => s.outstandingType === 'WE_OWE')
          .reduce((sum, s) => sum.add(new Prisma.Decimal(s.netOutstanding)), new Prisma.Decimal(0))
          .toString(),
        suppliersOwesUs: suppliersOutstanding
          .filter(s => s.outstandingType === 'OWES_US')
          .reduce((sum, s) => sum.add(new Prisma.Decimal(s.netOutstanding).abs()), new Prisma.Decimal(0))
          .toString(),
      },
    });
  } catch (error) {
    console.error('Outstanding fees error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get all bank-related transactions (BANK and BANK_NILE)
router.get('/bank-transactions', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, method } = req.query;
    
    // Build date filter
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.gte = startDate ? new Date(startDate as string) : undefined;
      if (endDate) {
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);
        dateFilter.lte = end;
      }
    }

    // Filter by payment method if specified
    const methodFilter = method === 'BANK' ? ['BANK' as const] : method === 'BANK_NILE' ? ['BANK_NILE' as const] : ['BANK' as const, 'BANK_NILE' as const];

    // Get sales payments (BANK or BANK_NILE)
    const salesPayments = await prisma.salesPayment.findMany({
      where: {
        method: { in: methodFilter },
        ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
        invoice: { paymentConfirmed: true },
      },
      include: {
        invoice: {
          include: {
            customer: true,
            inventory: true,
          },
        },
        recordedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Get procurement payments (BANK or BANK_NILE)
    const procPayments = await prisma.procOrderPayment.findMany({
      where: {
        method: { in: methodFilter },
        ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
        order: { paymentConfirmed: true, status: { not: 'CANCELLED' } },
      },
      include: {
        order: {
          include: {
            supplier: true,
            inventory: true,
          },
        },
        recordedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Get cash exchanges involving banks
    const cashExchanges = await (prisma as any).cashExchange.findMany({
      where: {
        ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
        OR: [
          { fromMethod: { in: methodFilter } },
          { toMethod: { in: methodFilter } },
        ],
      },
      include: {
        createdByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get expenses (BANK or BANK_NILE)
    const expenses = await prisma.expense.findMany({
      where: {
        method: { in: methodFilter },
        ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
      },
      include: {
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get paid salaries (BANK or BANK_NILE)
    const salaries = await prisma.salary.findMany({
      where: {
        paymentMethod: { in: methodFilter },
        paidAt: { not: null },
        ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
      },
      include: {
        employee: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Get paid advances (BANK or BANK_NILE)
    const advances = await prisma.advance.findMany({
      where: {
        paymentMethod: { in: methodFilter },
        paidAt: { not: null },
        ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
      },
      include: {
        employee: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Transform all transactions into a unified format
    const transactions: any[] = [];

    // Sales payments
    salesPayments.forEach((payment: any) => {
      transactions.push({
        id: payment.id,
        type: 'SALES_PAYMENT',
        typeLabel: 'دفعة مبيعات',
        amount: payment.amount.toString(),
        method: payment.method,
        date: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
        details: {
          invoiceNumber: payment.invoice?.invoiceNumber || 'غير محدد',
          customer: payment.invoice?.customer?.name || 'غير محدد',
          inventory: payment.invoice?.inventory?.name || 'غير محدد',
          receiptNumber: payment.receiptNumber || null,
          receiptUrl: payment.receiptUrl || null,
          notes: payment.notes || null,
        },
      });
    });

    // Procurement payments
    procPayments.forEach((payment: any) => {
      transactions.push({
        id: payment.id,
        type: 'PROCUREMENT_PAYMENT',
        typeLabel: 'دفعة مشتريات',
        amount: payment.amount.toString(),
        method: payment.method,
        date: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
        details: {
          orderNumber: payment.order?.orderNumber || 'غير محدد',
          supplier: payment.order?.supplier?.name || 'غير محدد',
          inventory: payment.order?.inventory?.name || 'غير محدد',
          receiptNumber: payment.receiptNumber || null,
          receiptUrl: payment.receiptUrl || null,
          notes: payment.notes || null,
        },
      });
    });

    // Cash exchanges
    cashExchanges.forEach((exchange: any) => {
      transactions.push({
        id: exchange.id,
        type: 'CASH_EXCHANGE',
        typeLabel: 'صرف نقد/بنك',
        amount: exchange.amount.toString(),
        method: exchange.fromMethod === 'BANK' || exchange.fromMethod === 'BANK_NILE' ? exchange.fromMethod : exchange.toMethod,
        date: exchange.createdAt,
        recordedBy: exchange.createdByUser.username,
        details: {
          fromMethod: exchange.fromMethod,
          toMethod: exchange.toMethod,
          receiptNumber: exchange.receiptNumber || null,
          receiptUrl: exchange.receiptUrl || null,
          notes: exchange.notes || null,
        },
      });
    });

    // Expenses
    expenses.forEach((expense: any) => {
      transactions.push({
        id: expense.id,
        type: 'EXPENSE',
        typeLabel: 'منصرف',
        amount: expense.amount.toString(),
        method: expense.method,
        date: expense.createdAt,
        recordedBy: expense.creator?.username || 'غير محدد',
        details: {
          description: expense.description,
          inventory: expense.inventory?.name || null,
          section: expense.section || null,
        },
      });
    });

    // Salaries
    salaries.forEach((salary: any) => {
      transactions.push({
        id: salary.id,
        type: 'SALARY',
        typeLabel: 'راتب',
        amount: salary.amount.toString(),
        method: salary.paymentMethod,
        date: salary.paidAt || salary.createdAt,
        recordedBy: salary.creator?.username || 'غير محدد',
        details: {
          employee: salary.employee?.name || 'غير محدد',
          position: salary.employee?.position || 'غير محدد',
          month: salary.month,
          year: salary.year,
          notes: salary.notes || null,
        },
      });
    });

    // Advances
    advances.forEach((advance: any) => {
      transactions.push({
        id: advance.id,
        type: 'ADVANCE',
        typeLabel: 'سلفية',
        amount: advance.amount.toString(),
        method: advance.paymentMethod,
        date: advance.paidAt || advance.createdAt,
        recordedBy: advance.creator?.username || 'غير محدد',
        details: {
          employee: advance.employee?.name || 'غير محدد',
          position: advance.employee?.position || 'غير محدد',
          reason: advance.reason,
          notes: advance.notes || null,
        },
      });
    });

    // Sort by date (newest first)
    transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Calculate totals
    const totals = {
      BANK: transactions
        .filter(t => t.method === 'BANK')
        .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0)),
      BANK_NILE: transactions
        .filter(t => t.method === 'BANK_NILE')
        .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0)),
      total: transactions
        .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0)),
    };

    // Calculate totals by type
    const totalsByType: Record<string, Prisma.Decimal> = {};
    transactions.forEach(t => {
      if (!totalsByType[t.type]) {
        totalsByType[t.type] = new Prisma.Decimal(0);
      }
      totalsByType[t.type] = totalsByType[t.type].add(t.amount);
    });

    res.json({
      transactions,
      summary: {
        total: totals.total.toFixed(2),
        BANK: totals.BANK.toFixed(2),
        BANK_NILE: totals.BANK_NILE.toFixed(2),
        count: transactions.length,
        byType: Object.fromEntries(
          Object.entries(totalsByType).map(([type, amount]) => [type, amount.toFixed(2)])
        ),
      },
    });
  } catch (error) {
    console.error('Get bank transactions error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get daily income and loss report with all transaction details
router.get('/daily-income-loss', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    
    // Determine date range
    let startOfDay: Date;
    let endOfDay: Date;
    
    if (date) {
      // Single day
      startOfDay = new Date(date as string);
      startOfDay.setHours(0, 0, 0, 0);
      endOfDay = new Date(date as string);
      endOfDay.setHours(23, 59, 59, 999);
    } else if (startDate && endDate) {
      // Date range
      startOfDay = new Date(startDate as string);
      startOfDay.setHours(0, 0, 0, 0);
      endOfDay = new Date(endDate as string);
      endOfDay.setHours(23, 59, 59, 999);
    } else {
      // Default to today
      startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
    }
    
    // Get all income transactions (sales payments - only confirmed)
    const salesPayments = await prisma.salesPayment.findMany({
      where: {
        paidAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
        invoice: {
          paymentConfirmed: true,
        },
      },
      include: {
        invoice: {
          include: {
            customer: true,
            inventory: true,
          },
        },
        recordedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'asc' },
    });
    
    // Get all loss transactions - Procurement payments (only confirmed)
    const procPayments = await prisma.procOrderPayment.findMany({
      where: {
        paidAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
        order: {
          paymentConfirmed: true,
          status: { not: 'CANCELLED' },
        },
      },
      include: {
        order: {
          include: {
            supplier: {
              select: { name: true },
            },
            inventory: {
              select: { name: true },
            },
          },
        },
        recordedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'asc' },
    });
    
    // Get all expenses
    const expenses = await prisma.expense.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    
    // Get paid salaries
    const salaries = await prisma.salary.findMany({
      where: {
        paidAt: {
          gte: startOfDay,
          lte: endOfDay,
          not: null,
        },
      },
      include: {
        employee: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'asc' },
    });
    
    // Get paid advances
    const advances = await prisma.advance.findMany({
      where: {
        paidAt: {
          gte: startOfDay,
          lte: endOfDay,
          not: null,
        },
      },
      include: {
        employee: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { paidAt: 'asc' },
    });
    
    // Get cash exchanges
    const cashExchanges = await prisma.cashExchange.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        createdByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    
    // Group transactions by date
    const transactionsByDate: Record<string, any> = {};
    
    // Process sales payments (income)
    salesPayments.forEach((payment) => {
      const dateKey = new Date(payment.paidAt).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
        };
      }
      transactionsByDate[dateKey].income.push({
        type: 'SALES_PAYMENT',
        typeLabel: 'دفعة مبيعات',
        id: payment.id,
        amount: payment.amount.toString(),
        method: payment.method,
        date: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
        details: {
          invoiceNumber: payment.invoice?.invoiceNumber || 'غير محدد',
          customer: payment.invoice?.customer?.name || 'بدون عميل',
          inventory: payment.invoice?.inventory?.name || 'غير محدد',
          receiptNumber: payment.receiptNumber || null,
          receiptUrl: payment.receiptUrl || null,
          notes: payment.notes || null,
        },
      });
    });
    
    // Process procurement payments (loss)
    procPayments.forEach((payment) => {
      const dateKey = new Date(payment.paidAt).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
        };
      }
      transactionsByDate[dateKey].losses.push({
        type: 'PROCUREMENT_PAYMENT',
        typeLabel: 'دفعة مشتريات',
        id: payment.id,
        amount: payment.amount.toString(),
        method: payment.method,
        date: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
        details: {
          orderNumber: payment.order?.orderNumber || 'غير محدد',
          supplier: payment.order?.supplier?.name || 'غير محدد',
          inventory: payment.order?.inventory?.name || 'غير محدد',
          receiptNumber: (payment as any).receiptNumber || null,
          receiptUrl: payment.receiptUrl || null,
          notes: payment.notes || null,
        },
      });
    });
    
    // Process expenses (loss)
    expenses.forEach((expense) => {
      const dateKey = new Date(expense.createdAt).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
        };
      }
      transactionsByDate[dateKey].losses.push({
        type: 'EXPENSE',
        typeLabel: 'منصرف',
        id: expense.id,
        amount: expense.amount.toString(),
        method: expense.method,
        date: expense.createdAt,
        recordedBy: expense.creator?.username || 'غير محدد',
        details: {
          description: expense.description,
          inventory: expense.inventory?.name || null,
          section: expense.section || null,
        },
      });
    });
    
    // Process salaries (loss)
    salaries.forEach((salary) => {
      const dateKey = new Date(salary.paidAt!).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
        };
      }
      transactionsByDate[dateKey].losses.push({
        type: 'SALARY',
        typeLabel: 'راتب',
        id: salary.id,
        amount: salary.amount.toString(),
        method: salary.paymentMethod,
        date: salary.paidAt || salary.createdAt,
        recordedBy: salary.creator?.username || 'غير محدد',
        details: {
          employee: salary.employee?.name || 'غير محدد',
          position: salary.employee?.position || 'غير محدد',
          month: salary.month,
          year: salary.year,
          notes: salary.notes || null,
        },
      });
    });
    
    // Process advances (loss)
    advances.forEach((advance) => {
      const dateKey = new Date(advance.paidAt!).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
        };
      }
      transactionsByDate[dateKey].losses.push({
        type: 'ADVANCE',
        typeLabel: 'سلفية',
        id: advance.id,
        amount: advance.amount.toString(),
        method: advance.paymentMethod,
        date: advance.paidAt || advance.createdAt,
        recordedBy: advance.creator?.username || 'غير محدد',
        details: {
          employee: advance.employee?.name || 'غير محدد',
          position: advance.employee?.position || 'غير محدد',
          reason: advance.reason,
          notes: advance.notes || null,
        },
      });
    });
    
    // Process cash exchanges (affects both income and loss depending on direction)
    cashExchanges.forEach((exchange) => {
      const dateKey = new Date(exchange.createdAt).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
        };
      }
      
      // If exchanging FROM cash TO bank = loss (cash leaving)
      if (exchange.fromMethod === 'CASH' && (exchange.toMethod === 'BANK' || exchange.toMethod === 'BANK_NILE')) {
        transactionsByDate[dateKey].losses.push({
          type: 'CASH_EXCHANGE',
          typeLabel: 'تحويل نقد إلى بنك',
          id: exchange.id,
          amount: exchange.amount.toString(),
          method: exchange.fromMethod,
          date: exchange.createdAt,
          recordedBy: exchange.createdByUser?.username || 'غير محدد',
          details: {
            fromMethod: exchange.fromMethod,
            toMethod: exchange.toMethod,
            receiptNumber: exchange.receiptNumber || null,
            receiptUrl: exchange.receiptUrl || null,
            notes: exchange.notes || null,
            description: `تحويل من ${exchange.fromMethod === 'CASH' ? 'نقد' : exchange.fromMethod} إلى ${exchange.toMethod === 'BANK' ? 'بنكك' : 'بنك النيل'}`,
          },
        });
      }
      // If exchanging FROM bank TO cash = income (cash coming in)
      else if ((exchange.fromMethod === 'BANK' || exchange.fromMethod === 'BANK_NILE') && exchange.toMethod === 'CASH') {
        transactionsByDate[dateKey].income.push({
          type: 'CASH_EXCHANGE',
          typeLabel: 'استرجاع نقد من بنك',
          id: exchange.id,
          amount: exchange.amount.toString(),
          method: exchange.toMethod,
          date: exchange.createdAt,
          recordedBy: exchange.createdByUser?.username || 'غير محدد',
          details: {
            fromMethod: exchange.fromMethod,
            toMethod: exchange.toMethod,
            receiptNumber: exchange.receiptNumber || null,
            receiptUrl: exchange.receiptUrl || null,
            notes: exchange.notes || null,
            description: `استرجاع من ${exchange.fromMethod === 'BANK' ? 'بنكك' : 'بنك النيل'} إلى نقد`,
          },
        });
      }
      // Bank to bank exchanges (neutral but still record)
      else {
        transactionsByDate[dateKey].losses.push({
          type: 'CASH_EXCHANGE',
          typeLabel: 'تحويل بين بنوك',
          id: exchange.id,
          amount: exchange.amount.toString(),
          method: exchange.fromMethod,
          date: exchange.createdAt,
          recordedBy: exchange.createdByUser?.username || 'غير محدد',
          details: {
            fromMethod: exchange.fromMethod,
            toMethod: exchange.toMethod,
            receiptNumber: exchange.receiptNumber || null,
            receiptUrl: exchange.receiptUrl || null,
            notes: exchange.notes || null,
            description: `تحويل من ${exchange.fromMethod === 'BANK' ? 'بنكك' : 'بنك النيل'} إلى ${exchange.toMethod === 'BANK' ? 'بنكك' : 'بنك النيل'}`,
          },
        });
      }
    });
    
    // Convert to array and calculate totals for each day
    const dailyReports = Object.values(transactionsByDate).map((dayData: any) => {
      const totalIncome = dayData.income.reduce((sum: Prisma.Decimal, t: any) => 
        sum.add(new Prisma.Decimal(t.amount)), new Prisma.Decimal(0));
      const totalLosses = dayData.losses.reduce((sum: Prisma.Decimal, t: any) => 
        sum.add(new Prisma.Decimal(t.amount)), new Prisma.Decimal(0));
      const netProfit = totalIncome.sub(totalLosses);
      
      return {
        ...dayData,
        totalIncome: totalIncome.toString(),
        totalLosses: totalLosses.toString(),
        netProfit: netProfit.toString(),
        incomeCount: dayData.income.length,
        lossesCount: dayData.losses.length,
      };
    }).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    // Calculate overall summary
    const overallTotalIncome = dailyReports.reduce((sum, day) => 
      sum.add(new Prisma.Decimal(day.totalIncome)), new Prisma.Decimal(0));
    const overallTotalLosses = dailyReports.reduce((sum, day) => 
      sum.add(new Prisma.Decimal(day.totalLosses)), new Prisma.Decimal(0));
    const overallNetProfit = overallTotalIncome.sub(overallTotalLosses);
    
    res.json({
      startDate: startOfDay.toISOString().split('T')[0],
      endDate: endOfDay.toISOString().split('T')[0],
      summary: {
        totalIncome: overallTotalIncome.toString(),
        totalLosses: overallTotalLosses.toString(),
        netProfit: overallNetProfit.toString(),
        totalDays: dailyReports.length,
      },
      dailyReports,
    });
  } catch (error) {
    console.error('Daily income/loss error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

