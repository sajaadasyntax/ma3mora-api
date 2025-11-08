import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';
import { aggregationService } from '../services/aggregationService';

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
  isDebt: z.boolean().optional().default(false),
});

const createIncomeSchema = z.object({
  inventoryId: z.string().optional(),
  section: z.enum(['GROCERY', 'BAKERY']).optional(),
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  description: z.string().min(1),
  isDebt: z.boolean().optional().default(false),
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

  // Procurement payments (only confirmed orders, exclude cancelled)
  const procPays = await prisma.procOrderPayment.findMany({ 
    where: { 
      order: { 
        paymentConfirmed: true,
        status: { not: 'CANCELLED' }
      } 
    } 
  });
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

    // Enforce sufficient balance for chosen payment method (skip check for debts)
    if (!data.isDebt) {
      const available = await getAvailableByMethod();
      const method = data.method as 'CASH'|'BANK'|'BANK_NILE';
      if (available[method].lessThan(data.amount)) {
        return res.status(400).json({ error: 'الرصيد غير كافٍ لطريقة الدفع المحددة' });
      }
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

    // Update aggregates (async, don't block response)
    try {
      const expenseDate = expense.createdAt;
      const expenseAmount = new Prisma.Decimal(data.amount);
      const expensesByMethod = {
        CASH: data.method === 'CASH' ? expenseAmount : new Prisma.Decimal(0),
        BANK: data.method === 'BANK' ? expenseAmount : new Prisma.Decimal(0),
        BANK_NILE: data.method === 'BANK_NILE' ? expenseAmount : new Prisma.Decimal(0),
      };

      await aggregationService.updateDailyFinancialAggregate(
        expenseDate,
        {
          expensesTotal: expenseAmount,
          expensesCount: 1,
          expensesCash: expensesByMethod.CASH,
          expensesBank: expensesByMethod.BANK,
          expensesBankNile: expensesByMethod.BANK_NILE,
        },
        data.inventoryId || undefined,
        data.section || undefined
      );
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }

    res.status(201).json(expense);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create expense error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Pay/settle an outbound debt (convert debt expense to regular expense)
router.post('/expenses/:id/pay-debt', requireRole('ACCOUNTANT', 'MANAGER'), checkBalanceOpen, createAuditLog('PayOutboundDebt'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = payDebtSchema.parse(req.body);

    // Get the expense debt
    const expense = await prisma.expense.findUnique({
      where: { id },
    });

    if (!expense) {
      return res.status(404).json({ error: 'المنصرف غير موجود' });
    }

    if (!expense.isDebt) {
      return res.status(400).json({ error: 'هذا المنصرف ليس دينًا' });
    }

    // Check if there's sufficient balance to pay the debt
    const available = await getAvailableByMethod();
    const method = data.method as 'CASH'|'BANK'|'BANK_NILE';
    if (available[method].lessThan(expense.amount)) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ لسداد هذا الدين' });
    }

    // Update the expense to mark it as paid (no longer a debt)
    const updatedExpense = await prisma.expense.update({
      where: { id },
      data: {
        isDebt: false,
        method: data.method, // Update payment method to the one used
      },
    });

    res.json({ message: 'تم سداد الدين بنجاح', expense: updatedExpense });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Pay outbound debt error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Income routes (opposite of expenses - money coming IN)
router.get('/income', async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;
    
    const incomeWhere: any = {};
    if (inventoryId) incomeWhere.inventoryId = inventoryId;
    if (section) incomeWhere.section = section;

    const income = await prisma.income.findMany({
      where: incomeWhere,
      include: {
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(income);
  } catch (error) {
    console.error('Get income error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/income', requireRole('ACCOUNTANT', 'MANAGER'), checkBalanceOpen, createAuditLog('Income'), async (req: AuthRequest, res) => {
  try {
    const data = createIncomeSchema.parse(req.body);

    const income = await prisma.income.create({
      data: {
        ...data,
        createdBy: req.user!.id,
      },
      include: {
        inventory: true,
      },
    });

    // Update aggregates (async, don't block response)
    try {
      const incomeDate = income.createdAt;
      const incomeAmount = new Prisma.Decimal(data.amount);
      const incomeByMethod = {
        CASH: data.method === 'CASH' ? incomeAmount : new Prisma.Decimal(0),
        BANK: data.method === 'BANK' ? incomeAmount : new Prisma.Decimal(0),
        BANK_NILE: data.method === 'BANK_NILE' ? incomeAmount : new Prisma.Decimal(0),
      };

      await aggregationService.updateDailyFinancialAggregate(
        incomeDate,
        {
          incomeTotal: incomeAmount,
          incomeCount: 1,
          incomeCash: incomeByMethod.CASH,
          incomeBank: incomeByMethod.BANK,
          incomeBankNile: incomeByMethod.BANK_NILE,
        },
        data.inventoryId || undefined,
        data.section || undefined
      );
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }

    res.status(201).json(income);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create income error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Pay/settle an inbound debt (convert debt income to regular income)
const payDebtSchema = z.object({
  method: z.enum(['CASH', 'BANK', 'BANK_NILE']),
});

router.post('/income/:id/pay-debt', requireRole('ACCOUNTANT', 'MANAGER'), checkBalanceOpen, createAuditLog('PayInboundDebt'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = payDebtSchema.parse(req.body);

    // Get the income debt
    const income = await prisma.income.findUnique({
      where: { id },
    });

    if (!income) {
      return res.status(404).json({ error: 'الإيراد غير موجود' });
    }

    if (!income.isDebt) {
      return res.status(400).json({ error: 'هذا الإيراد ليس دينًا' });
    }

    // Update the income to mark it as paid (no longer a debt)
    const updatedIncome = await prisma.income.update({
      where: { id },
      data: {
        isDebt: false,
        method: data.method, // Update payment method to the one used
      },
    });

    res.json({ message: 'تم تسديد الدين بنجاح', income: updatedIncome });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Pay inbound debt error:', error);
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

    // Expenses summary - separate debts from regular expenses
    const expensesWhere: any = {};
    if (inventoryId) expensesWhere.inventoryId = inventoryId;
    if (section) expensesWhere.section = section;

    const expenses = await prisma.expense.findMany({
      where: expensesWhere,
    });

    // Separate debt expenses from regular expenses
    const regularExpenses = expenses.filter(exp => !exp.isDebt);
    const debtExpenses = expenses.filter(exp => exp.isDebt);

    // Income summary - separate debts from regular income
    const incomeWhere: any = {};
    if (inventoryId) incomeWhere.inventoryId = inventoryId;
    if (section) incomeWhere.section = section;

    const income = await prisma.income.findMany({
      where: incomeWhere,
    });

    // Separate debt income from regular income
    const regularIncome = income.filter(inc => !inc.isDebt);
    const debtIncome = income.filter(inc => inc.isDebt);

    const totalIncome = regularIncome.reduce(
      (sum, inc) => sum.add(inc.amount),
      new Prisma.Decimal(0)
    );

    // Calculate debt totals
    const totalInboundDebt = debtIncome.reduce(
      (sum, inc) => sum.add(inc.amount),
      new Prisma.Decimal(0)
    );

    const totalOutboundDebt = debtExpenses.reduce(
      (sum, exp) => sum.add(exp.amount),
      new Prisma.Decimal(0)
    );

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

    const totalExpenses = regularExpenses.reduce(
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

    // Get actual procurement payments (not just order totals) - exclude cancelled orders
    const procPayments = await prisma.procOrderPayment.findMany({
      where: {
        order: {
          status: { not: 'CANCELLED' },
          paymentConfirmed: true,
          ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
          ...(section ? { section: section as any } : {}),
        }
      }
    });

    // Commission payments don't affect liquid assets (already paid by supplier as gift)
    const totalProcurementPaid = procPayments
      .filter(p => (p.method as string) !== 'COMMISSION')
      .reduce(
        (sum, payment) => sum.add(payment.amount),
        new Prisma.Decimal(0)
      );

    // Get cash exchanges impact
    const cashExchanges = await prisma.cashExchange.findMany();
    const cashExchangeImpact = {
      CASH: new Prisma.Decimal(0),
      BANK: new Prisma.Decimal(0),
      BANK_NILE: new Prisma.Decimal(0)
    };
    cashExchanges.forEach((exchange: any) => {
      const fromM = exchange.fromMethod as 'CASH'|'BANK'|'BANK_NILE';
      const toM = exchange.toMethod as 'CASH'|'BANK'|'BANK_NILE';
      cashExchangeImpact[fromM] = cashExchangeImpact[fromM].sub(exchange.amount);
      cashExchangeImpact[toM] = cashExchangeImpact[toM].add(exchange.amount);
    });
    const totalCashExchangeImpact = cashExchangeImpact.CASH.add(cashExchangeImpact.BANK).add(cashExchangeImpact.BANK_NILE);

    // Calculate net balance: opening + received + income - procurement payments - expenses + cash exchanges
    // Note: Cash exchanges between methods cancel out in total, but we include for accuracy
    const netBalance = totalOpeningBalance
      .add(totalReceived)
      .add(totalIncome)
      .sub(totalProcurementPaid)
      .sub(totalAllExpenses)
      .add(totalCashExchangeImpact);

    res.json({
      sales: {
        total: totalSales.toFixed(2),
        received: totalReceived.toFixed(2),
        debt: totalSalesDebt.toFixed(2),
        count: salesInvoices.length,
      },
      procurement: {
        total: totalProcurement.toFixed(2),
        paid: totalProcurementPaid.toFixed(2),
        pending: totalProcurement.sub(totalProcurementPaid).toFixed(2),
        count: procOrders.length,
        cancelled: {
          total: totalCancelledProcurement.toFixed(2),
          count: cancelledProcOrders.length,
        },
      },
      expenses: {
        total: totalAllExpenses.toFixed(2),
        count: regularExpenses.length + paidSalaries.length + paidAdvances.length,
        regular: totalExpenses.toFixed(2),
        salaries: totalSalaries.toFixed(2),
        advances: totalAdvances.toFixed(2),
      },
      income: {
        total: totalIncome.toFixed(2),
        count: regularIncome.length,
      },
      debts: {
        inbound: totalInboundDebt.toFixed(2),
        outbound: totalOutboundDebt.toFixed(2),
        net: totalInboundDebt.sub(totalOutboundDebt).toFixed(2),
        inboundCount: debtIncome.length,
        outboundCount: debtExpenses.length,
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

    // Get expenses by method - exclude debt expenses from liquid calculation
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
      .filter(e => e.method === 'CASH' && !e.isDebt)
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const bankExpenses = expenses
      .filter(e => e.method === 'BANK' && !e.isDebt)
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const bankNileExpenses = expenses
      .filter(e => e.method === 'BANK_NILE' && !e.isDebt)
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
      .filter(s => s.paymentMethod === 'CASH')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));

    const bankSalaries = paidSalaries
      .filter(s => s.paymentMethod === 'BANK')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));

    const bankNileSalaries = paidSalaries
      .filter(s => s.paymentMethod === 'BANK_NILE')
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
      .filter(a => a.paymentMethod === 'CASH')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    const bankAdvances = paidAdvances
      .filter(a => a.paymentMethod === 'BANK')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    const bankNileAdvances = paidAdvances
      .filter(a => a.paymentMethod === 'BANK_NILE')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    // Get income by method - exclude debt income from liquid calculation
    const income = await prisma.income.findMany({
      where: {
        ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
        ...(section ? { section: section as any } : {}),
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const cashIncome = income
      .filter(i => i.method === 'CASH' && !i.isDebt)
      .reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0));

    const bankIncome = income
      .filter(i => i.method === 'BANK' && !i.isDebt)
      .reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0));

    const bankNileIncome = income
      .filter(i => i.method === 'BANK_NILE' && !i.isDebt)
      .reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0));

    // Calculate debt totals (debts are NOT included in liquid calculations)
    const debtExpenses = expenses.filter(e => e.isDebt);
    const debtIncome = income.filter(i => i.isDebt);

    const totalInboundDebt = debtIncome.reduce(
      (sum, i) => sum.add(i.amount),
      new Prisma.Decimal(0)
    );

    const totalOutboundDebt = debtExpenses.reduce(
      (sum, e) => sum.add(e.amount),
      new Prisma.Decimal(0)
    );

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

    // Exclude COMMISSION from liquid assets subtraction (commission is not an outflow)
    const cashProcPayments = procPayments
      .filter(p => p.method === 'CASH')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankProcPayments = procPayments
      .filter(p => p.method === 'BANK')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankNileProcPayments = procPayments
      .filter(p => p.method === 'BANK_NILE')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    // Note: Commission payments are excluded by design and not subtracted

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

    // Calculate net liquid cash (opening balance + payments + income - expenses - salaries - advances - proc payments + cash exchanges)
    const netCash = openingCash
      .add(cashTotal)
      .add(cashIncome)
      .sub(cashExpenses)
      .sub(cashSalaries)
      .sub(cashAdvances)
      .sub(cashProcPayments)
      .add(cashExchangeImpact.CASH);
    
    const netBank = openingBank
      .add(bankTotal)
      .add(bankIncome)
      .sub(bankExpenses)
      .sub(bankSalaries)
      .sub(bankAdvances)
      .sub(bankProcPayments)
      .add(cashExchangeImpact.BANK);
    
    const netBankNile = openingBankNile
      .add(bankNileTotal)
      .add(bankNileIncome)
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
          count: paidSalaries.filter(s => s.paymentMethod === 'CASH').length
        },
        bank: {
          total: bankSalaries.toFixed(2),
          count: paidSalaries.filter(s => s.paymentMethod === 'BANK').length
        },
        bankNile: {
          total: bankNileSalaries.toFixed(2),
          count: paidSalaries.filter(s => s.paymentMethod === 'BANK_NILE').length
        },
        total: cashSalaries.add(bankSalaries).add(bankNileSalaries).toFixed(2)
      },
      advances: {
        cash: {
          total: cashAdvances.toFixed(2),
          count: paidAdvances.filter(a => a.paymentMethod === 'CASH').length
        },
        bank: {
          total: bankAdvances.toFixed(2),
          count: paidAdvances.filter(a => a.paymentMethod === 'BANK').length
        },
        bankNile: {
          total: bankNileAdvances.toFixed(2),
          count: paidAdvances.filter(a => a.paymentMethod === 'BANK_NILE').length
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
      },
      debts: {
        inbound: {
          total: totalInboundDebt.toFixed(2),
          count: debtIncome.length,
          items: debtIncome.map(i => ({
            id: i.id,
            description: i.description,
            amount: i.amount.toFixed(2),
            method: i.method,
            createdAt: i.createdAt
          }))
        },
        outbound: {
          total: totalOutboundDebt.toFixed(2),
          count: debtExpenses.length,
          items: debtExpenses.map(e => ({
            id: e.id,
            description: e.description,
            amount: e.amount.toFixed(2),
            method: e.method,
            createdAt: e.createdAt
          }))
        },
        net: totalInboundDebt.sub(totalOutboundDebt).toFixed(2)
      }
    });
  } catch (error) {
    console.error('Get liquid cash error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Assets (له) and Liabilities (عليه) report
router.get('/assets-liabilities', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    // ========== له (Assets) ==========
    
    // 1. Stock values by warehouse using wholesale price
    const inventories = await prisma.inventory.findMany({
      include: {
        stocks: {
          include: {
            item: {
              include: {
                prices: {
                  where: {
                    tier: 'WHOLESALE',
                  },
                  orderBy: [
                    { validFrom: 'desc' },
                  ],
                },
              },
            },
          },
        },
      },
    });

    // Calculate stock values per warehouse (totals only)
    const stockValuesByWarehouse: Record<string, { inventoryId: string; inventoryName: string; totalValue: Prisma.Decimal }> = {};
    let totalStockValue = new Prisma.Decimal(0);

    for (const inventory of inventories) {
      let warehouseTotal = new Prisma.Decimal(0);
      
      for (const stock of inventory.stocks) {
        // Include all stock values, including negative stock (deficits)
        if (!stock.quantity.equals(0)) {
          // Get wholesale price (prefer inventory-specific, fallback to global)
          // Filter prices: first try inventory-specific, then global (inventoryId: null)
          const inventorySpecificPrice = stock.item.prices.find(
            p => p.tier === 'WHOLESALE' && p.inventoryId === inventory.id
          );
          const globalPrice = stock.item.prices.find(
            p => p.tier === 'WHOLESALE' && p.inventoryId === null
          );
          
          // Use inventory-specific price if available, otherwise use global price
          const wholesalePrice = inventorySpecificPrice?.price || globalPrice?.price || new Prisma.Decimal(0);
          const stockValue = stock.quantity.mul(wholesalePrice);
          warehouseTotal = warehouseTotal.add(stockValue);
        }
      }
      
      // Include warehouse total even if negative (deficit) or zero
      if (!warehouseTotal.equals(0)) {
        stockValuesByWarehouse[inventory.id] = {
          inventoryId: inventory.id,
          inventoryName: inventory.name,
          totalValue: warehouseTotal,
        };
        totalStockValue = totalStockValue.add(warehouseTotal);
      }
    }

    // 2. Liquid values of the 3 payment methods (actual available cash, excluding debts)
    // Get opening balances
    const openingBalances = await prisma.openingBalance.findMany({
      where: { scope: 'CASHBOX', isClosed: false },
    });
    const opening = {
      CASH: openingBalances.filter((b: any) => b.paymentMethod === 'CASH').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
      BANK: openingBalances.filter((b: any) => b.paymentMethod === 'BANK').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
      BANK_NILE: openingBalances.filter((b: any) => b.paymentMethod === 'BANK_NILE').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
    };

    // Sales payments (only confirmed invoices)
    const salesPays = await prisma.salesPayment.findMany({
      where: { invoice: { paymentConfirmed: true } },
    });
    const salesIn = {
      CASH: salesPays.filter(p => p.method === 'CASH').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
      BANK: salesPays.filter(p => p.method === 'BANK').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
      BANK_NILE: salesPays.filter(p => p.method === 'BANK_NILE').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    };

    // Expenses (excluding debts)
    const expenses = await prisma.expense.findMany();
    const expOut = {
      CASH: expenses.filter(e => e.method === 'CASH' && !e.isDebt).reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
      BANK: expenses.filter(e => e.method === 'BANK' && !e.isDebt).reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
      BANK_NILE: expenses.filter(e => e.method === 'BANK_NILE' && !e.isDebt).reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
    };

    // Salaries (paid)
    const paidSalaries = await prisma.salary.findMany({ where: { paidAt: { not: null } } });
    const salOut = {
      CASH: paidSalaries.filter((s: any) => s.paymentMethod === 'CASH').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANK: paidSalaries.filter((s: any) => s.paymentMethod === 'BANK').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANK_NILE: paidSalaries.filter((s: any) => s.paymentMethod === 'BANK_NILE').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
    };

    // Advances (paid)
    const paidAdvances = await prisma.advance.findMany({ where: { paidAt: { not: null } } });
    const advOut = {
      CASH: paidAdvances.filter((a: any) => a.paymentMethod === 'CASH').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANK: paidAdvances.filter((a: any) => a.paymentMethod === 'BANK').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANK_NILE: paidAdvances.filter((a: any) => a.paymentMethod === 'BANK_NILE').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
    };

    // Procurement payments (only confirmed orders, exclude cancelled and commission)
    // Commission payments don't affect liquid assets (already paid by supplier as gift)
    const procPays = await prisma.procOrderPayment.findMany({ 
      where: { 
        order: { 
          paymentConfirmed: true,
          status: { not: 'CANCELLED' }
        } 
      } 
    });
    // Filter out COMMISSION payments - they don't affect liquid assets
    const procPaysExcludingCommission = procPays.filter(p => (p.method as string) !== 'COMMISSION');
    const procOut = {
      CASH: procPaysExcludingCommission.filter(p => p.method === 'CASH').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
      BANK: procPaysExcludingCommission.filter(p => p.method === 'BANK').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
      BANK_NILE: procPaysExcludingCommission.filter(p => p.method === 'BANK_NILE').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    };

    // Income (excluding debts)
    const income = await prisma.income.findMany();
    const incomeIn = {
      CASH: income.filter(i => i.method === 'CASH' && !i.isDebt).reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0)),
      BANK: income.filter(i => i.method === 'BANK' && !i.isDebt).reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0)),
      BANK_NILE: income.filter(i => i.method === 'BANK_NILE' && !i.isDebt).reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0)),
    };

    // Cash exchanges
    const exchanges = await (prisma as any).cashExchange.findMany();
    const exImpact = { CASH: new Prisma.Decimal(0), BANK: new Prisma.Decimal(0), BANK_NILE: new Prisma.Decimal(0) } as Record<'CASH'|'BANK'|'BANK_NILE', Prisma.Decimal>;
    exchanges.forEach((e: any) => {
      const fromM = e.fromMethod as 'CASH'|'BANK'|'BANK_NILE';
      const toM = e.toMethod as 'CASH'|'BANK'|'BANK_NILE';
      exImpact[fromM] = exImpact[fromM].sub(e.amount);
      exImpact[toM] = exImpact[toM].add(e.amount);
    });

    const liquidCash = {
      CASH: opening.CASH.add(salesIn.CASH).add(incomeIn.CASH).add(exImpact.CASH).sub(expOut.CASH).sub(salOut.CASH).sub(advOut.CASH).sub(procOut.CASH),
      BANK: opening.BANK.add(salesIn.BANK).add(incomeIn.BANK).add(exImpact.BANK).sub(expOut.BANK).sub(salOut.BANK).sub(advOut.BANK).sub(procOut.BANK),
      BANK_NILE: opening.BANK_NILE.add(salesIn.BANK_NILE).add(incomeIn.BANK_NILE).add(exImpact.BANK_NILE).sub(expOut.BANK_NILE).sub(salOut.BANK_NILE).sub(advOut.BANK_NILE).sub(procOut.BANK_NILE),
    };

    const liquidCashTotal = liquidCash.CASH.add(liquidCash.BANK).add(liquidCash.BANK_NILE);

    // 3. Inbound debts (Income with isDebt = true)
    const inboundDebts = await prisma.income.findMany({
      where: { isDebt: true },
      orderBy: { createdAt: 'desc' },
    });

    const totalInboundDebt = inboundDebts.reduce(
      (sum, i) => sum.add(i.amount),
      new Prisma.Decimal(0)
    );

    // 4. Delivered unpaid sales orders - totals by warehouse
    const deliveredUnpaidInvoices = await prisma.salesInvoice.findMany({
      where: {
        deliveryStatus: 'DELIVERED',
        paymentStatus: { not: 'PAID' },
      },
      include: {
        inventory: true,
      },
    });

    const unpaidSalesByWarehouse: Record<string, { inventoryId: string; inventoryName: string; totalOutstanding: Prisma.Decimal }> = {};
    let totalDeliveredUnpaid = new Prisma.Decimal(0);

    for (const inv of deliveredUnpaidInvoices) {
      const outstanding = new Prisma.Decimal(inv.total).sub(inv.paidAmount);
      if (outstanding.greaterThan(0)) {
        if (!unpaidSalesByWarehouse[inv.inventoryId]) {
          unpaidSalesByWarehouse[inv.inventoryId] = {
            inventoryId: inv.inventoryId,
            inventoryName: inv.inventory.name,
            totalOutstanding: new Prisma.Decimal(0),
          };
        }
        unpaidSalesByWarehouse[inv.inventoryId].totalOutstanding = 
          unpaidSalesByWarehouse[inv.inventoryId].totalOutstanding.add(outstanding);
        totalDeliveredUnpaid = totalDeliveredUnpaid.add(outstanding);
      }
    }

    // Calculate total له (Assets)
    const totalAssets = totalStockValue
      .add(liquidCash.CASH)
      .add(liquidCash.BANK)
      .add(liquidCash.BANK_NILE)
      .add(totalInboundDebt)
      .add(totalDeliveredUnpaid);

    // ========== عليه (Liabilities) ==========
    
    // 1. Outbound debts (Expense with isDebt = true)
    const outboundDebts = await prisma.expense.findMany({
      where: { isDebt: true },
      orderBy: { createdAt: 'desc' },
    });

    const totalOutboundDebt = outboundDebts.reduce(
      (sum, e) => sum.add(e.amount),
      new Prisma.Decimal(0)
    );

    // 2. Unpaid procurement orders - totals by supplier
    const unpaidProcOrders = await prisma.procOrder.findMany({
      where: {
        status: { not: 'CANCELLED' },
      },
      include: {
        supplier: true,
      },
    });

    const unpaidProcOrdersBySupplier: Record<string, { supplierId: string; supplierName: string; totalOutstanding: Prisma.Decimal }> = {};
    let totalUnpaidProcOrders = new Prisma.Decimal(0);

    for (const order of unpaidProcOrders) {
      const outstanding = new Prisma.Decimal(order.total).sub(order.paidAmount);
      if (outstanding.greaterThan(0)) {
        if (!unpaidProcOrdersBySupplier[order.supplierId]) {
          unpaidProcOrdersBySupplier[order.supplierId] = {
            supplierId: order.supplierId,
            supplierName: order.supplier.name,
            totalOutstanding: new Prisma.Decimal(0),
          };
        }
        unpaidProcOrdersBySupplier[order.supplierId].totalOutstanding = 
          unpaidProcOrdersBySupplier[order.supplierId].totalOutstanding.add(outstanding);
        totalUnpaidProcOrders = totalUnpaidProcOrders.add(outstanding);
      }
    }

    // Calculate total عليه (Liabilities)
    const totalLiabilities = totalOutboundDebt.add(totalUnpaidProcOrders);

    res.json({
      assets: {
        stockValues: {
          byWarehouse: Object.values(stockValuesByWarehouse).map(w => ({
            inventoryId: w.inventoryId,
            inventoryName: w.inventoryName,
            totalValue: w.totalValue.toFixed(2),
          })),
          total: totalStockValue.toFixed(2),
        },
        liquidCash: {
          CASH: liquidCash.CASH.toFixed(2),
          BANK: liquidCash.BANK.toFixed(2),
          BANK_NILE: liquidCash.BANK_NILE.toFixed(2),
          total: liquidCashTotal.toFixed(2),
        },
        inboundDebts: {
          total: totalInboundDebt.toFixed(2),
          count: inboundDebts.length,
        },
        deliveredUnpaidSales: {
          byWarehouse: Object.values(unpaidSalesByWarehouse).map(w => ({
            inventoryId: w.inventoryId,
            inventoryName: w.inventoryName,
            totalOutstanding: w.totalOutstanding.toFixed(2),
          })),
          total: totalDeliveredUnpaid.toFixed(2),
        },
        total: totalAssets.toFixed(2),
      },
      liabilities: {
        outboundDebts: {
          total: totalOutboundDebt.toFixed(2),
          count: outboundDebts.length,
        },
        unpaidProcOrders: {
          bySupplier: Object.values(unpaidProcOrdersBySupplier).map(s => ({
            supplierId: s.supplierId,
            supplierName: s.supplierName,
            totalOutstanding: s.totalOutstanding.toFixed(2),
          })),
          total: totalUnpaidProcOrders.toFixed(2),
        },
        total: totalLiabilities.toFixed(2),
      },
      net: totalAssets.sub(totalLiabilities).toFixed(2),
    });
  } catch (error) {
    console.error('Get assets-liabilities error:', error);
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

    // Expenses (regular + salaries + advances) should be counted toward liabilities ("عليه")
    // Regular expenses - optionally filter by section if present
    const expensesWhere: any = {};
    if (section) expensesWhere.section = section;
    const expenses = await prisma.expense.findMany({ where: expensesWhere });
    const totalExpenses = expenses.reduce(
      (sum: Prisma.Decimal, exp: any) => sum.add(exp.amount),
      new Prisma.Decimal(0)
    );

    // Paid salaries (no section association)
    const paidSalaries = await prisma.salary.findMany({ where: { paidAt: { not: null } } });
    const totalSalaries = paidSalaries.reduce(
      (sum: Prisma.Decimal, s: any) => sum.add(s.amount),
      new Prisma.Decimal(0)
    );

    // Paid advances (no section association)
    const paidAdvances = await prisma.advance.findMany({ where: { paidAt: { not: null } } });
    const totalAdvances = paidAdvances.reduce(
      (sum: Prisma.Decimal, a: any) => sum.add(a.amount),
      new Prisma.Decimal(0)
    );

    const totalAllExpenses = totalExpenses.add(totalSalaries).add(totalAdvances);

    // Totals
    const receivablesTotal = receivables.reduce(
      (sum: Prisma.Decimal, r: any) => sum.add(r.remaining),
      new Prisma.Decimal(0)
    );
    const payablesTotal = payables.reduce(
      (sum: Prisma.Decimal, p: any) => sum.add(p.remaining),
      new Prisma.Decimal(0)
    );

    const totals = {
      receivables: receivablesTotal.toFixed(2),
      payables: payablesTotal.toFixed(2),
      expenses: totalAllExpenses.toFixed(2),
      payablesWithExpenses: payablesTotal.add(totalAllExpenses).toFixed(2),
    };

    res.json({ 
      receivables, 
      payables, 
      expenses: {
        regular: totalExpenses.toFixed(2),
        salaries: totalSalaries.toFixed(2),
        advances: totalAdvances.toFixed(2),
        total: totalAllExpenses.toFixed(2),
      },
      totals 
    });
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

        // Get income data for this session
        const income = await prisma.income.findMany({
          where: {
            createdAt: {
              gte: session.openedAt,
              lte: session.closedAt || new Date(),
            }
          }
        });

        const totalIncome = income.reduce((sum, inc) => 
          sum.add(inc.amount), new Prisma.Decimal(0)
        );

        const profit = totalReceived.add(totalIncome).sub(totalProcurement).sub(totalExpenses);

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
            income: {
              total: totalIncome.toFixed(2),
              count: income.length,
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

    // Update aggregates (async, don't block response)
    try {
      const exchangeDate = exchange.createdAt;
      const exchangeAmount = new Prisma.Decimal(data.amount);
      const cashExchangesByMethod = {
        CASH: data.fromMethod === 'CASH' ? exchangeAmount.neg() : (data.toMethod === 'CASH' ? exchangeAmount : new Prisma.Decimal(0)),
        BANK: data.fromMethod === 'BANK' ? exchangeAmount.neg() : (data.toMethod === 'BANK' ? exchangeAmount : new Prisma.Decimal(0)),
        BANK_NILE: data.fromMethod === 'BANK_NILE' ? exchangeAmount.neg() : (data.toMethod === 'BANK_NILE' ? exchangeAmount : new Prisma.Decimal(0)),
      };

      await aggregationService.updateDailyFinancialAggregate(
        exchangeDate,
        {
          cashExchangesCash: cashExchangesByMethod.CASH,
          cashExchangesBank: cashExchangesByMethod.BANK,
          cashExchangesBankNile: cashExchangesByMethod.BANK_NILE,
        }
      );
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }

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

// Recalculate aggregators for date range
router.post('/aggregators/recalculate', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, inventoryId, section } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'تاريخ البداية والنهاية مطلوبان' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    // Recalculate for each day in the range
    const currentDate = new Date(start);
    let recalculatedCount = 0;

    while (currentDate <= end) {
      const dateToRecalc = new Date(currentDate);
      await aggregationService.recalculateDate(
        dateToRecalc,
        inventoryId || undefined,
        section || undefined
      );
      recalculatedCount++;
      currentDate.setDate(currentDate.getDate() + 1);
    }

    res.json({
      message: 'تم إعادة حساب المجمعات بنجاح',
      recalculatedDays: recalculatedCount,
      dateRange: {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
      },
    });
  } catch (error: any) {
    console.error('Recalculate aggregators error:', error);
    console.error('Error stack:', error?.stack);
    res.status(500).json({ 
      error: 'خطأ في الخادم',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
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
router.get('/outstanding-fees', requireRole('ACCOUNTANT', 'MANAGER', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY'), async (req: AuthRequest, res) => {
  try {
    const { section, period, startDate, endDate: endDateParam } = req.query;
    
    // Calculate date range based on period or use provided dates
    let startDateFilter: Date | null = null;
    let endDateFilter: Date = new Date();
    endDateFilter.setHours(23, 59, 59, 999);
    
    if (startDate && endDateParam) {
      startDateFilter = new Date(startDate as string);
      startDateFilter.setHours(0, 0, 0, 0);
      endDateFilter = new Date(endDateParam as string);
      endDateFilter.setHours(23, 59, 59, 999);
    } else if (period === 'today') {
      startDateFilter = new Date();
      startDateFilter.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      startDateFilter = new Date();
      startDateFilter.setDate(startDateFilter.getDate() - 7);
      startDateFilter.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      startDateFilter = new Date();
      startDateFilter.setMonth(startDateFilter.getMonth() - 1);
      startDateFilter.setHours(0, 0, 0, 0);
    } else if (period === 'year') {
      startDateFilter = new Date();
      startDateFilter.setFullYear(startDateFilter.getFullYear() - 1);
      startDateFilter.setHours(0, 0, 0, 0);
    }
    
    // Get customers invoices with outstanding balances
    const customerInvoiceWhere: any = {};
    if (section) {
      customerInvoiceWhere.customer = { division: section };
    }
    if (startDateFilter) {
      customerInvoiceWhere.createdAt = { gte: startDateFilter, lte: endDateFilter };
    }
    
    const customerInvoices = await prisma.salesInvoice.findMany({
      where: customerInvoiceWhere,
      include: {
        customer: true,
        inventory: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: {
          include: {
            recordedByUser: {
              select: { id: true, username: true },
            },
          },
          orderBy: { paidAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    // Filter invoices with outstanding balances
    const customerInvoicesOutstanding = customerInvoices.filter(inv => {
      const outstanding = new Prisma.Decimal(inv.total).sub(inv.paidAmount);
      return outstanding.greaterThan(0);
    });
    
    // Transform customer invoices to report format
    const customerReportData = customerInvoicesOutstanding.map(invoice => ({
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.createdAt,
      customer: invoice.customer?.name || 'بدون عميل',
      customerType: invoice.customer?.type || 'غير محدد',
      inventory: invoice.inventory.name,
      notes: invoice.notes || null,
      total: invoice.total.toString(),
      paidAmount: invoice.paidAmount.toString(),
      outstanding: new Prisma.Decimal(invoice.total).sub(invoice.paidAmount).toString(),
      paymentStatus: invoice.paymentStatus,
      deliveryStatus: invoice.deliveryStatus,
      items: invoice.items.map(item => ({
        itemName: item.item.name,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        lineTotal: item.lineTotal.toString(),
      })),
      payments: invoice.payments.map(payment => ({
        amount: payment.amount.toString(),
        method: payment.method,
        paidAt: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
      })),
    }));
    
    // Get suppliers orders with outstanding balances
    const supplierOrderWhere: any = {};
    if (startDateFilter) {
      supplierOrderWhere.createdAt = { gte: startDateFilter, lte: endDateFilter };
    }
    
    const supplierOrders = await prisma.procOrder.findMany({
      where: supplierOrderWhere,
      include: {
        supplier: true,
        inventory: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: {
          include: {
            recordedByUser: {
              select: { id: true, username: true },
            },
          },
          orderBy: { paidAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    // Filter orders with outstanding balances
    const supplierOrdersOutstanding = supplierOrders.filter(order => {
      const outstanding = new Prisma.Decimal(order.total).sub(order.paidAmount);
      return outstanding.greaterThan(0);
    });
    
    // Transform supplier orders to report format
    const supplierReportData = supplierOrdersOutstanding.map(order => ({
      orderNumber: order.orderNumber,
      date: order.createdAt,
      supplier: order.supplier.name,
      inventory: order.inventory.name,
      notes: order.notes || null,
      total: order.total.toString(),
      paidAmount: order.paidAmount.toString(),
      outstanding: new Prisma.Decimal(order.total).sub(order.paidAmount).toString(),
      paymentStatus: order.paymentConfirmed ? 'CONFIRMED' : 'PENDING',
      status: order.status,
      items: order.items.map(item => ({
        itemName: item.item.name,
        quantity: item.quantity.toString(),
        unitCost: item.unitCost.toString(),
        lineTotal: item.lineTotal.toString(),
      })),
      payments: order.payments.map(payment => ({
        amount: payment.amount.toString(),
        method: payment.method,
        paidAt: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
      })),
    }));
    
    // Calculate summary
    const customersOwesUs = customerInvoicesOutstanding.reduce((sum, inv) => 
      sum.add(new Prisma.Decimal(inv.total).sub(inv.paidAmount)), new Prisma.Decimal(0));
    const weOweSuppliers = supplierOrdersOutstanding.reduce((sum, order) => 
      sum.add(new Prisma.Decimal(order.total).sub(order.paidAmount)), new Prisma.Decimal(0));
    
    res.json({
      section: section || 'ALL',
      period: period || 'ALL',
      startDate: startDateFilter?.toISOString().split('T')[0] || null,
      endDate: endDateFilter.toISOString().split('T')[0],
      customers: customerReportData,
      suppliers: supplierReportData,
      summary: {
        customersOwesUs: customersOwesUs.toString(),
        weOweSuppliers: weOweSuppliers.toString(),
        totalCustomersOutstanding: customerReportData.length,
        totalSuppliersOutstanding: supplierReportData.length,
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

    // Get opening balances for BANK and BANK_NILE
    const openingBalances = await prisma.openingBalance.findMany({
      where: { 
        scope: 'CASHBOX',
        isClosed: false 
      },
      orderBy: { openedAt: 'desc' },
    });

    const openingBank = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    
    const openingBankNile = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    // Calculate income (sales payments only) by method
    const bankIncome = salesPayments
      .filter(p => p.method === 'BANK')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));
    
    const bankNileIncome = salesPayments
      .filter(p => p.method === 'BANK_NILE')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    // Calculate expenses (procurement payments, regular expenses, salaries, advances) by method
    const bankProcPayments = procPayments
      .filter(p => p.method === 'BANK')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));
    
    const bankNileProcPayments = procPayments
      .filter(p => p.method === 'BANK_NILE')
      .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const bankExpenses = expenses
      .filter(e => e.method === 'BANK')
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));
    
    const bankNileExpenses = expenses
      .filter(e => e.method === 'BANK_NILE')
      .reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const bankSalaries = salaries
      .filter(s => s.paymentMethod === 'BANK')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));
    
    const bankNileSalaries = salaries
      .filter(s => s.paymentMethod === 'BANK_NILE')
      .reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));

    const bankAdvances = advances
      .filter(a => a.paymentMethod === 'BANK')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));
    
    const bankNileAdvances = advances
      .filter(a => a.paymentMethod === 'BANK_NILE')
      .reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    // Calculate cash exchange impact (only for BANK and BANK_NILE methods)
    let cashExchangeImpact = {
      BANK: new Prisma.Decimal(0),
      BANK_NILE: new Prisma.Decimal(0)
    };

    cashExchanges.forEach((exchange: any) => {
      // If fromMethod is BANK or BANK_NILE, subtract
      if (exchange.fromMethod === 'BANK') {
        cashExchangeImpact.BANK = cashExchangeImpact.BANK.sub(exchange.amount);
      } else if (exchange.fromMethod === 'BANK_NILE') {
        cashExchangeImpact.BANK_NILE = cashExchangeImpact.BANK_NILE.sub(exchange.amount);
      }
      // If toMethod is BANK or BANK_NILE, add
      if (exchange.toMethod === 'BANK') {
        cashExchangeImpact.BANK = cashExchangeImpact.BANK.add(exchange.amount);
      } else if (exchange.toMethod === 'BANK_NILE') {
        cashExchangeImpact.BANK_NILE = cashExchangeImpact.BANK_NILE.add(exchange.amount);
      }
    });

    // Calculate net balances (similar to liquid-cash)
    // Net = opening + income - proc payments - expenses - salaries - advances + cash exchanges
    const netBank = openingBank
      .add(bankIncome)
      .sub(bankProcPayments)
      .sub(bankExpenses)
      .sub(bankSalaries)
      .sub(bankAdvances)
      .add(cashExchangeImpact.BANK);
    
    const netBankNile = openingBankNile
      .add(bankNileIncome)
      .sub(bankNileProcPayments)
      .sub(bankNileExpenses)
      .sub(bankNileSalaries)
      .sub(bankNileAdvances)
      .add(cashExchangeImpact.BANK_NILE);
    
    const netTotal = netBank.add(netBankNile);

    // Calculate totals by type (for display purposes)
    const totalsByType: Record<string, Prisma.Decimal> = {};
    transactions.forEach(t => {
      if (!totalsByType[t.type]) {
        totalsByType[t.type] = new Prisma.Decimal(0);
      }
      totalsByType[t.type] = totalsByType[t.type].add(new Prisma.Decimal(t.amount));
    });

    // Calculate total expenses including salaries and advances
    const totalBankExpenses = bankExpenses.add(bankSalaries).add(bankAdvances);
    const totalBankNileExpenses = bankNileExpenses.add(bankNileSalaries).add(bankNileAdvances);

    res.json({
      transactions,
      summary: {
        opening: {
          BANK: openingBank.toFixed(2),
          BANK_NILE: openingBankNile.toFixed(2),
          total: openingBank.add(openingBankNile).toFixed(2),
        },
        income: {
          BANK: bankIncome.toFixed(2),
          BANK_NILE: bankNileIncome.toFixed(2),
          total: bankIncome.add(bankNileIncome).toFixed(2),
        },
        expenses: {
          BANK: {
            regular: bankExpenses.toFixed(2),
            salaries: bankSalaries.toFixed(2),
            advances: bankAdvances.toFixed(2),
            total: totalBankExpenses.toFixed(2),
          },
          BANK_NILE: {
            regular: bankNileExpenses.toFixed(2),
            salaries: bankNileSalaries.toFixed(2),
            advances: bankNileAdvances.toFixed(2),
            total: totalBankNileExpenses.toFixed(2),
          },
          total: totalBankExpenses.add(totalBankNileExpenses).toFixed(2),
        },
        procurementPayments: {
          BANK: bankProcPayments.toFixed(2),
          BANK_NILE: bankNileProcPayments.toFixed(2),
          total: bankProcPayments.add(bankNileProcPayments).toFixed(2),
        },
        cashExchanges: {
          BANK: cashExchangeImpact.BANK.toFixed(2),
          BANK_NILE: cashExchangeImpact.BANK_NILE.toFixed(2),
          total: cashExchangeImpact.BANK.add(cashExchangeImpact.BANK_NILE).toFixed(2),
        },
        net: {
          BANK: netBank.toFixed(2),
          BANK_NILE: netBankNile.toFixed(2),
          total: netTotal.toFixed(2),
        },
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
    const { date, startDate, endDate, method } = req.query;
    
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
        method: method ? (method as 'CASH' | 'BANK' | 'BANK_NILE') : undefined,
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
        method: method ? (method as 'CASH' | 'BANK' | 'BANK_NILE') : undefined,
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
        method: method ? (method as 'CASH' | 'BANK' | 'BANK_NILE') : undefined,
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
        AND: [
          { paidAt: { gte: startOfDay } },
          { paidAt: { lte: endOfDay } },
          { NOT: { paidAt: null } },
        ],
        paymentMethod: method ? (method as 'CASH' | 'BANK' | 'BANK_NILE') : undefined,
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
        AND: [
          { paidAt: { gte: startOfDay } },
          { paidAt: { lte: endOfDay } },
          { NOT: { paidAt: null } },
        ],
        paymentMethod: method ? (method as 'CASH' | 'BANK' | 'BANK_NILE') : undefined,
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
        ...(method ? {
          OR: [
            { fromMethod: method as 'CASH' | 'BANK' | 'BANK_NILE' },
            { toMethod: method as 'CASH' | 'BANK' | 'BANK_NILE' },
          ],
        } : {}),
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
          transfers: [],
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
    
    // Process cash exchanges properly - track as transfers, not separate income/loss
    cashExchanges.forEach((exchange) => {
      const dateKey = new Date(exchange.createdAt).toISOString().split('T')[0];
      if (!transactionsByDate[dateKey]) {
        transactionsByDate[dateKey] = {
          date: dateKey,
          income: [],
          losses: [],
          transfers: [], // New array for cash exchanges
        };
      }
      
      const fromMethod = exchange.fromMethod as 'CASH' | 'BANK' | 'BANK_NILE';
      const toMethod = exchange.toMethod as 'CASH' | 'BANK' | 'BANK_NILE';
      
      // Record as a transfer (not income/loss separately)
      transactionsByDate[dateKey].transfers.push({
        type: 'CASH_EXCHANGE',
        typeLabel: `تحويل من ${fromMethod === 'CASH' ? 'نقد' : fromMethod === 'BANK' ? 'بنكك' : 'بنك النيل'} إلى ${toMethod === 'CASH' ? 'نقد' : toMethod === 'BANK' ? 'بنكك' : 'بنك النيل'}`,
        id: exchange.id,
        amount: exchange.amount.toString(),
        fromMethod: fromMethod,
        toMethod: toMethod,
        date: exchange.createdAt,
        recordedBy: exchange.createdByUser?.username || 'غير محدد',
        details: {
          fromMethod: fromMethod,
          toMethod: toMethod,
          receiptNumber: exchange.receiptNumber || null,
          receiptUrl: exchange.receiptUrl || null,
          notes: exchange.notes || null,
          description: `تحويل من ${fromMethod === 'CASH' ? 'نقد' : fromMethod === 'BANK' ? 'بنكك' : 'بنك النيل'} إلى ${toMethod === 'CASH' ? 'نقد' : toMethod === 'BANK' ? 'بنكك' : 'بنك النيل'}`,
        },
      });
    });
    
    // Sort dates chronologically to calculate cumulative balances
    const sortedDates = Object.keys(transactionsByDate).sort((a, b) => 
      new Date(a).getTime() - new Date(b).getTime()
    );

    // Get opening balances (for calculating opening balance before transactions)
    const openingBalances = await prisma.openingBalance.findMany({
      where: {
        scope: 'CASHBOX',
        isClosed: false,
      },
      orderBy: { openedAt: 'desc' },
    });

    // Calculate base opening balance per payment method
    const baseOpeningBalanceByMethod = {
      CASH: openingBalances
        .filter((b: any) => b.paymentMethod === 'CASH')
        .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
      BANK: openingBalances
        .filter((b: any) => b.paymentMethod === 'BANK')
        .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
      BANK_NILE: openingBalances
        .filter((b: any) => b.paymentMethod === 'BANK_NILE')
        .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
    };

    // Calculate opening balance at start of period by adding/subtracting all transactions before start date
    // Get all transactions before the start date to calculate the actual opening balance
    const prePeriodSalesPayments = await prisma.salesPayment.findMany({
      where: {
        paidAt: { lt: startOfDay },
        invoice: { paymentConfirmed: true },
        ...(method ? { method: method as 'CASH' | 'BANK' | 'BANK_NILE' } : {}),
      },
    });

    const prePeriodProcPayments = await prisma.procOrderPayment.findMany({
      where: {
        paidAt: { lt: startOfDay },
        order: { paymentConfirmed: true, status: { not: 'CANCELLED' } },
        ...(method ? { method: method as 'CASH' | 'BANK' | 'BANK_NILE' } : {}),
      },
    });

    const prePeriodExpenses = await prisma.expense.findMany({
      where: {
        createdAt: { lt: startOfDay },
        ...(method ? { method: method as 'CASH' | 'BANK' | 'BANK_NILE' } : {}),
      },
    });

    const prePeriodSalaries = await prisma.salary.findMany({
      where: {
        paidAt: { lt: startOfDay, not: null },
        ...(method ? { paymentMethod: method as 'CASH' | 'BANK' | 'BANK_NILE' } : {}),
      },
    });

    const prePeriodAdvances = await prisma.advance.findMany({
      where: {
        paidAt: { lt: startOfDay, not: null },
        ...(method ? { paymentMethod: method as 'CASH' | 'BANK' | 'BANK_NILE' } : {}),
      },
    });

    const prePeriodCashExchanges = await prisma.cashExchange.findMany({
      where: {
        createdAt: { lt: startOfDay },
        ...(method ? {
          OR: [
            { fromMethod: method as 'CASH' | 'BANK' | 'BANK_NILE' },
            { toMethod: method as 'CASH' | 'BANK' | 'BANK_NILE' },
          ],
        } : {}),
      },
    });

    // Calculate impact of pre-period transactions
    const prePeriodImpact = {
      CASH: new Prisma.Decimal(0),
      BANK: new Prisma.Decimal(0),
      BANK_NILE: new Prisma.Decimal(0),
    };

    // Define valid payment methods and type guard
    const validMethods = ['CASH', 'BANK', 'BANK_NILE'] as const;
    const isValidMethod = (m: any): m is 'CASH' | 'BANK' | 'BANK_NILE' => validMethods.includes(m);

    prePeriodSalesPayments.forEach((p) => {
      const m = p.method;
      if (isValidMethod(m)) {
        prePeriodImpact[m] = prePeriodImpact[m].add(p.amount);
      }
    });

    prePeriodProcPayments.forEach((p) => {
      const m = p.method;
      if (isValidMethod(m)) {
        prePeriodImpact[m] = prePeriodImpact[m].sub(p.amount);
      }
    });

    prePeriodExpenses.forEach((e) => {
      const m = e.method;
      if (isValidMethod(m)) {
        prePeriodImpact[m] = prePeriodImpact[m].sub(e.amount);
      }
    });

    prePeriodSalaries.forEach((s: any) => {
      const m = s.paymentMethod;
      if (isValidMethod(m)) {
        prePeriodImpact[m] = prePeriodImpact[m].sub(s.amount);
      }
    });

    prePeriodAdvances.forEach((a: any) => {
      const m = a.paymentMethod;
      if (isValidMethod(m)) {
        prePeriodImpact[m] = prePeriodImpact[m].sub(a.amount);
      }
    });

    prePeriodCashExchanges.forEach((e: any) => {
      const fromM = e.fromMethod;
      const toM = e.toMethod;
      if (isValidMethod(fromM)) {
        prePeriodImpact[fromM] = prePeriodImpact[fromM].sub(e.amount);
      }
      if (isValidMethod(toM)) {
        prePeriodImpact[toM] = prePeriodImpact[toM].add(e.amount);
      }
    });

    // Calculate opening balance at start of period
    const openingBalanceByMethod = {
      CASH: baseOpeningBalanceByMethod.CASH.add(prePeriodImpact.CASH),
      BANK: baseOpeningBalanceByMethod.BANK.add(prePeriodImpact.BANK),
      BANK_NILE: baseOpeningBalanceByMethod.BANK_NILE.add(prePeriodImpact.BANK_NILE),
    };

    // Track running balances by payment method
    let runningBalances = {
      CASH: openingBalanceByMethod.CASH,
      BANK: openingBalanceByMethod.BANK,
      BANK_NILE: openingBalanceByMethod.BANK_NILE,
    };


    const dailyReports = sortedDates.map((dateKey) => {
      const dayData = transactionsByDate[dateKey];
      
      // Calculate income and losses by payment method
      const incomeByMethod = {
        CASH: new Prisma.Decimal(0),
        BANK: new Prisma.Decimal(0),
        BANK_NILE: new Prisma.Decimal(0),
      };
      const lossesByMethod = {
        CASH: new Prisma.Decimal(0),
        BANK: new Prisma.Decimal(0),
        BANK_NILE: new Prisma.Decimal(0),
      };

      dayData.income.forEach((t: any) => {
        const method = t.method;
        if (isValidMethod(method)) {
          incomeByMethod[method] = incomeByMethod[method].add(new Prisma.Decimal(t.amount));
        }
      });

      dayData.losses.forEach((t: any) => {
        const method = t.method;
        if (isValidMethod(method)) {
          lossesByMethod[method] = lossesByMethod[method].add(new Prisma.Decimal(t.amount));
        }
      });

      // Calculate REAL income and losses (excluding transfers) for display
      const realIncomeByMethod = {
        CASH: new Prisma.Decimal(0),
        BANK: new Prisma.Decimal(0),
        BANK_NILE: new Prisma.Decimal(0),
      };
      const realLossesByMethod = {
        CASH: new Prisma.Decimal(0),
        BANK: new Prisma.Decimal(0),
        BANK_NILE: new Prisma.Decimal(0),
      };

      dayData.income.forEach((t: any) => {
        const method = t.method;
        if (isValidMethod(method)) {
          realIncomeByMethod[method] = realIncomeByMethod[method].add(new Prisma.Decimal(t.amount));
        }
      });

      dayData.losses.forEach((t: any) => {
        const method = t.method;
        if (isValidMethod(method)) {
          realLossesByMethod[method] = realLossesByMethod[method].add(new Prisma.Decimal(t.amount));
        }
      });

      // Process cash exchanges - affect balances but NOT income/loss totals
      (dayData.transfers || []).forEach((transfer: any) => {
        const fromM = transfer.fromMethod;
        const toM = transfer.toMethod;
        if (isValidMethod(fromM)) {
          lossesByMethod[fromM] = lossesByMethod[fromM].add(new Prisma.Decimal(transfer.amount));
        }
        if (isValidMethod(toM)) {
          incomeByMethod[toM] = incomeByMethod[toM].add(new Prisma.Decimal(transfer.amount));
        }
      });

      // Opening balance for this day (before transactions)
      const openingBalance = {
        CASH: runningBalances.CASH,
        BANK: runningBalances.BANK,
        BANK_NILE: runningBalances.BANK_NILE,
      };

      // Update running balances (opening + income - losses including transfers)
      runningBalances.CASH = runningBalances.CASH.add(incomeByMethod.CASH).sub(lossesByMethod.CASH);
      runningBalances.BANK = runningBalances.BANK.add(incomeByMethod.BANK).sub(lossesByMethod.BANK);
      runningBalances.BANK_NILE = runningBalances.BANK_NILE.add(incomeByMethod.BANK_NILE).sub(lossesByMethod.BANK_NILE);

      // Closing balance for this day (after transactions)
      const closingBalance = {
        CASH: runningBalances.CASH,
        BANK: runningBalances.BANK,
        BANK_NILE: runningBalances.BANK_NILE,
      };

      // Calculate REAL totals (excluding transfers) for display
      const realIncomeTotal = realIncomeByMethod.CASH.add(realIncomeByMethod.BANK).add(realIncomeByMethod.BANK_NILE);
      const realLossTotal = realLossesByMethod.CASH.add(realLossesByMethod.BANK).add(realLossesByMethod.BANK_NILE);
      const netProfit = realIncomeTotal.sub(realLossTotal);
      
      return {
        ...dayData,
        totalIncome: realIncomeTotal.toString(),
        totalLosses: realLossTotal.toString(),
        netProfit: netProfit.toString(),
        incomeCount: dayData.income.length,
        lossesCount: dayData.losses.length,
        openingBalance: {
          CASH: openingBalance.CASH.toString(),
          BANK: openingBalance.BANK.toString(),
          BANK_NILE: openingBalance.BANK_NILE.toString(),
          total: openingBalance.CASH.add(openingBalance.BANK).add(openingBalance.BANK_NILE).toString(),
        },
        closingBalance: {
          CASH: closingBalance.CASH.toString(),
          BANK: closingBalance.BANK.toString(),
          BANK_NILE: closingBalance.BANK_NILE.toString(),
          total: closingBalance.CASH.add(closingBalance.BANK).add(closingBalance.BANK_NILE).toString(),
        },
        incomeByMethod: {
          CASH: realIncomeByMethod.CASH.toString(),
          BANK: realIncomeByMethod.BANK.toString(),
          BANK_NILE: realIncomeByMethod.BANK_NILE.toString(),
        },
        lossesByMethod: {
          CASH: realLossesByMethod.CASH.toString(),
          BANK: realLossesByMethod.BANK.toString(),
          BANK_NILE: realLossesByMethod.BANK_NILE.toString(),
        },
        // Balance calculation fields (include transfers for accurate balance tracking)
        balanceIncomeByMethod: {
          CASH: incomeByMethod.CASH.toString(),
          BANK: incomeByMethod.BANK.toString(),
          BANK_NILE: incomeByMethod.BANK_NILE.toString(),
        },
        balanceLossesByMethod: {
          CASH: lossesByMethod.CASH.toString(),
          BANK: lossesByMethod.BANK.toString(),
          BANK_NILE: lossesByMethod.BANK_NILE.toString(),
        },
        transfers: dayData.transfers || [],
      };
    }).reverse(); // Reverse to show newest first
    
    // Calculate overall summary with accurate liquid cash per payment method
    const overallTotalIncome = dailyReports.reduce((sum, day) => 
      sum.add(new Prisma.Decimal(day.totalIncome)), new Prisma.Decimal(0));
    const overallTotalLosses = dailyReports.reduce((sum, day) => 
      sum.add(new Prisma.Decimal(day.totalLosses)), new Prisma.Decimal(0));
    const overallNetProfit = overallTotalIncome.sub(overallTotalLosses);
    
    // Calculate liquid cash per payment method (opening + income - losses + transfers)
    // Use closing balance from last day, which already includes all transactions and transfers
    const liquidCashByMethod = dailyReports.length > 0 
      ? {
          CASH: new Prisma.Decimal(dailyReports[dailyReports.length - 1].closingBalance.CASH),
          BANK: new Prisma.Decimal(dailyReports[dailyReports.length - 1].closingBalance.BANK),
          BANK_NILE: new Prisma.Decimal(dailyReports[dailyReports.length - 1].closingBalance.BANK_NILE),
        }
      : {
          CASH: openingBalanceByMethod.CASH,
          BANK: openingBalanceByMethod.BANK,
          BANK_NILE: openingBalanceByMethod.BANK_NILE,
        };
    
    // Calculate overall opening and closing balances
    const overallOpeningBalance = {
      CASH: openingBalanceByMethod.CASH.toString(),
      BANK: openingBalanceByMethod.BANK.toString(),
      BANK_NILE: openingBalanceByMethod.BANK_NILE.toString(),
      total: openingBalanceByMethod.CASH.add(openingBalanceByMethod.BANK).add(openingBalanceByMethod.BANK_NILE).toString(),
    };

    const overallClosingBalance = dailyReports.length > 0 
      ? dailyReports[dailyReports.length - 1].closingBalance 
      : overallOpeningBalance;
    
    // Calculate profit/loss per payment method (real income - real losses, excluding transfers)
    const profitLossByMethod = {
      CASH: dailyReports.reduce((sum, day) => 
        sum.add(new Prisma.Decimal(day.incomeByMethod.CASH)).sub(new Prisma.Decimal(day.lossesByMethod.CASH)), 
        new Prisma.Decimal(0)),
      BANK: dailyReports.reduce((sum, day) => 
        sum.add(new Prisma.Decimal(day.incomeByMethod.BANK)).sub(new Prisma.Decimal(day.lossesByMethod.BANK)), 
        new Prisma.Decimal(0)),
      BANK_NILE: dailyReports.reduce((sum, day) => 
        sum.add(new Prisma.Decimal(day.incomeByMethod.BANK_NILE)).sub(new Prisma.Decimal(day.lossesByMethod.BANK_NILE)), 
        new Prisma.Decimal(0)),
    };

    res.json({
      startDate: startOfDay.toISOString().split('T')[0],
      endDate: endOfDay.toISOString().split('T')[0],
      summary: {
        totalIncome: overallTotalIncome.toString(),
        totalLosses: overallTotalLosses.toString(),
        netProfit: overallNetProfit.toString(),
        totalDays: dailyReports.length,
        openingBalance: overallOpeningBalance,
        closingBalance: overallClosingBalance,
        // Profit/Loss per payment method (real business transactions only)
        profitLossByMethod: {
          CASH: profitLossByMethod.CASH.toString(),
          BANK: profitLossByMethod.BANK.toString(),
          BANK_NILE: profitLossByMethod.BANK_NILE.toString(),
          total: profitLossByMethod.CASH.add(profitLossByMethod.BANK).add(profitLossByMethod.BANK_NILE).toString(),
        },
        // Liquid cash per payment method (actual cash position including transfers)
        liquidCashByMethod: {
          CASH: liquidCashByMethod.CASH.toString(),
          BANK: liquidCashByMethod.BANK.toString(),
          BANK_NILE: liquidCashByMethod.BANK_NILE.toString(),
          total: liquidCashByMethod.CASH.add(liquidCashByMethod.BANK).add(liquidCashByMethod.BANK_NILE).toString(),
        },
        // Income and losses breakdown by payment method
        incomeByMethod: {
          CASH: dailyReports.reduce((sum, day) => sum.add(new Prisma.Decimal(day.incomeByMethod.CASH)), new Prisma.Decimal(0)).toString(),
          BANK: dailyReports.reduce((sum, day) => sum.add(new Prisma.Decimal(day.incomeByMethod.BANK)), new Prisma.Decimal(0)).toString(),
          BANK_NILE: dailyReports.reduce((sum, day) => sum.add(new Prisma.Decimal(day.incomeByMethod.BANK_NILE)), new Prisma.Decimal(0)).toString(),
        },
        lossesByMethod: {
          CASH: dailyReports.reduce((sum, day) => sum.add(new Prisma.Decimal(day.lossesByMethod.CASH)), new Prisma.Decimal(0)).toString(),
          BANK: dailyReports.reduce((sum, day) => sum.add(new Prisma.Decimal(day.lossesByMethod.BANK)), new Prisma.Decimal(0)).toString(),
          BANK_NILE: dailyReports.reduce((sum, day) => sum.add(new Prisma.Decimal(day.lossesByMethod.BANK_NILE)), new Prisma.Decimal(0)).toString(),
        },
      },
      dailyReports,
    });
  } catch (error) {
    console.error('Daily income/loss error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Commission report: procurement payments paid via COMMISSION (treated as profit used to cover orders)
router.get('/commissions', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, supplierId, inventoryId, section } = req.query as any;

    let gte: Date | undefined;
    let lte: Date | undefined;
    if (startDate) {
      gte = new Date(startDate);
      gte.setHours(0, 0, 0, 0);
    }
    if (endDate) {
      lte = new Date(endDate);
      lte.setHours(23, 59, 59, 999);
    }

    const commissions = await prisma.procOrderPayment.findMany({
      where: {
        method: 'COMMISSION' as any,
        paidAt: gte || lte ? { gte, lte } as any : undefined,
        order: {
          ...(supplierId ? { supplierId } : {}),
          ...(inventoryId ? { inventoryId } : {}),
          ...(section ? { section } : {}),
        },
      },
      include: {
        order: {
          include: {
            supplier: { select: { id: true, name: true } },
            inventory: { select: { id: true, name: true } },
          },
        },
        recordedByUser: { select: { id: true, username: true } },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Transform rows
    const rows = commissions.map((p) => ({
      id: p.id,
      amount: p.amount.toString(),
      date: p.paidAt,
      orderId: p.orderId,
      orderNumber: (p as any).order?.orderNumber || null,
      supplier: (p as any).order?.supplier?.name || null,
      supplierId: (p as any).order?.supplier?.id || null,
      inventory: (p as any).order?.inventory?.name || null,
      inventoryId: (p as any).order?.inventory?.id || null,
      section: (p as any).order?.section || null,
      recordedBy: (p as any).recordedByUser?.username || 'غير محدد',
      notes: p.notes || null,
      receiptNumber: (p as any).receiptNumber || null,
      receiptUrl: p.receiptUrl || null,
    }));

    // Summaries
    const total = commissions.reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0));

    const bySupplier: Record<string, { name: string; amount: string; count: number }> = {};
    const byInventory: Record<string, { name: string; amount: string; count: number }> = {};
    const byDate: Record<string, { amount: string; count: number }> = {};

    commissions.forEach((p) => {
      const sup = (p as any).order?.supplier;
      if (sup) {
        if (!bySupplier[sup.id]) bySupplier[sup.id] = { name: sup.name, amount: '0', count: 0 };
        bySupplier[sup.id].amount = new Prisma.Decimal(bySupplier[sup.id].amount).add(p.amount).toString();
        bySupplier[sup.id].count += 1;
      }
      const inv = (p as any).order?.inventory;
      if (inv) {
        if (!byInventory[inv.id]) byInventory[inv.id] = { name: inv.name, amount: '0', count: 0 };
        byInventory[inv.id].amount = new Prisma.Decimal(byInventory[inv.id].amount).add(p.amount).toString();
        byInventory[inv.id].count += 1;
      }
      const dateKey = p.paidAt ? new Date(p.paidAt).toISOString().split('T')[0] : 'غير محدد';
      if (!byDate[dateKey]) byDate[dateKey] = { amount: '0', count: 0 };
      byDate[dateKey].amount = new Prisma.Decimal(byDate[dateKey].amount).add(p.amount).toString();
      byDate[dateKey].count += 1;
    });

    res.json({
      summary: {
        total: total.toString(),
        count: commissions.length,
      },
      breakdown: {
        bySupplier,
        byInventory,
        byDate,
      },
      rows,
    });
  } catch (error) {
    console.error('Commission report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Customer Report endpoint
router.get('/customer-report', requireRole('ACCOUNTANT', 'MANAGER', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY'), async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, type, customerId, customerIds, paymentMethod, section } = req.query;
    
    const where: any = {};
    
    // Date filtering
    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate as string),
        lte: new Date(endDate as string),
      };
    } else if (startDate) {
      where.createdAt = {
        gte: new Date(startDate as string),
      };
    } else if (endDate) {
      where.createdAt = {
        lte: new Date(endDate as string),
      };
    }
    
    // Filter by customer(s) - support both single customerId (backward compatibility) and multiple customerIds
    if (customerIds) {
      // Handle comma-separated string of customer IDs
      const ids = (customerIds as string).split(',').filter(id => id.trim());
      if (ids.length > 0) {
        where.customerId = { in: ids };
      }
    } else if (customerId) {
      // Backward compatibility: single customer ID
      where.customerId = customerId;
    }
    
    // Filter by section
    if (section) {
      where.section = section;
    }
    
    // Filter by payment method
    if (paymentMethod) {
      where.paymentMethod = paymentMethod;
    }
    
    // Get invoices with related data
    const invoices = await prisma.salesInvoice.findMany({
      where,
      include: {
        customer: true,
        inventory: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: {
          include: {
            recordedByUser: {
              select: { id: true, username: true },
            },
          },
          orderBy: { paidAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    // Filter by customer type if specified
    let filteredInvoices = invoices;
    if (type) {
      filteredInvoices = invoices.filter(inv => inv.customer?.type === type);
    }
    
    // Transform to report format
    const reportData = filteredInvoices.map(invoice => ({
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.createdAt,
      customer: invoice.customer?.name || 'غير محدد',
      customerType: invoice.customer?.type || 'غير محدد',
      paymentMethod: invoice.paymentMethod,
      subtotal: invoice.subtotal.toString(),
      discount: invoice.discount.toString(),
      total: invoice.total.toString(),
      paidAmount: invoice.paidAmount.toString(),
      outstanding: invoice.total.sub(invoice.paidAmount).toString(),
      paymentStatus: invoice.paymentStatus,
      items: invoice.items.map(item => ({
        itemName: item.item.name,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        lineTotal: item.lineTotal.toString(),
      })),
      payments: invoice.payments.map(payment => ({
        amount: payment.amount.toString(),
        method: payment.method,
        paidAt: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
      })),
    }));
    
    // Calculate summary
    const totalInvoices = filteredInvoices.length;
    const totalSales = filteredInvoices.reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0));
    const totalPaid = filteredInvoices.reduce((sum, inv) => sum.add(inv.paidAmount), new Prisma.Decimal(0));
    const totalOutstanding = totalSales.sub(totalPaid);
    
    // Add initial and final stock for inventory reports
    let stockInfo: any = null;
    if (startDate && endDate && filteredInvoices.length > 0) {
      // Get unique inventory IDs from invoices
      const inventoryIds = [...new Set(filteredInvoices.map(inv => inv.inventoryId))];
      
      for (const invId of inventoryIds) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);

        // Get initial stock
        const initialStocks = await prisma.inventoryStock.findMany({
          where: { inventoryId: invId },
          include: { item: true },
        });

        // Get stock movements
        const stockMovements = await prisma.stockMovement.findMany({
          where: {
            inventoryId: invId,
            movementDate: {
              gte: start,
              lte: end,
            },
          },
          include: { item: true },
        });

        const initialStockByItem: Record<string, number> = {};
        const finalStockByItem: Record<string, number> = {};

        for (const stock of initialStocks) {
          const firstMovement = stockMovements
            .filter(m => m.itemId === stock.itemId)
            .sort((a, b) => a.movementDate.getTime() - b.movementDate.getTime())[0];
          
          if (firstMovement) {
            initialStockByItem[stock.itemId] = parseFloat(firstMovement.openingBalance.toString());
          } else {
            const changes = stockMovements
              .filter(m => m.itemId === stock.itemId)
              .reduce((sum, m) => 
                sum + parseFloat(m.incoming.toString()) 
                - parseFloat(m.outgoing.toString())
                - parseFloat(m.pendingOutgoing.toString())
                + parseFloat(m.incomingGifts.toString())
                - parseFloat(m.outgoingGifts.toString()), 0
              );
            initialStockByItem[stock.itemId] = Math.max(0, parseFloat(stock.quantity.toString()) - changes);
          }
        }

        for (const stock of initialStocks) {
          const initial = initialStockByItem[stock.itemId] || 0;
          const movements = stockMovements.filter(m => m.itemId === stock.itemId);
          const totalIncoming = movements.reduce((sum, m) => sum + parseFloat(m.incoming.toString()), 0);
          const totalOutgoing = movements.reduce((sum, m) => sum + parseFloat(m.outgoing.toString()) + parseFloat(m.pendingOutgoing.toString()), 0);
          const totalIncomingGifts = movements.reduce((sum, m) => sum + parseFloat(m.incomingGifts.toString()), 0);
          const totalOutgoingGifts = movements.reduce((sum, m) => sum + parseFloat(m.outgoingGifts.toString()), 0);
          
          finalStockByItem[stock.itemId] = initial + totalIncoming - totalOutgoing + totalIncomingGifts - totalOutgoingGifts;
        }

        if (!stockInfo) stockInfo = { items: [] };
        stockInfo.items.push(...initialStocks.map(s => ({
          itemId: s.itemId,
          itemName: s.item.name,
          initialStock: initialStockByItem[s.itemId] || 0,
          finalStock: finalStockByItem[s.itemId] || 0,
        })));
      }
    }

    res.json({
      data: reportData,
      summary: {
        totalInvoices,
        totalSales: totalSales.toString(),
        totalPaid: totalPaid.toString(),
        totalOutstanding: totalOutstanding.toString(),
      },
      ...(stockInfo && { stockInfo }),
    });
  } catch (error) {
    console.error('Customer report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Supplier Report endpoint
router.get('/supplier-report', requireRole('ACCOUNTANT', 'MANAGER', 'PROCUREMENT'), async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, supplierId, supplierIds, paymentMethod, outstandingOnly } = req.query;
    
    const where: any = {};
    
    // Date filtering
    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate as string),
        lte: new Date(endDate as string),
      };
    } else if (startDate) {
      where.createdAt = {
        gte: new Date(startDate as string),
      };
    } else if (endDate) {
      where.createdAt = {
        lte: new Date(endDate as string),
      };
    }
    
    // Filter by supplier(s) - support both single supplierId (backward compatibility) and multiple supplierIds
    if (supplierIds) {
      // Handle comma-separated string of supplier IDs
      const ids = (supplierIds as string).split(',').filter(id => id.trim());
      if (ids.length > 0) {
        where.supplierId = { in: ids };
      }
    } else if (supplierId) {
      // Backward compatibility: single supplier ID
      where.supplierId = supplierId;
    }
    
    // Get orders with related data
    const orders = await prisma.procOrder.findMany({
      where,
      include: {
        supplier: true,
        inventory: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: {
          include: {
            recordedByUser: {
              select: { id: true, username: true },
            },
          },
          orderBy: { paidAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    // Filter by payment method from payments
    let filteredOrders = orders;
    if (paymentMethod) {
      filteredOrders = orders.filter(order => 
        order.payments.some(p => p.method === paymentMethod) || 
        (!order.payments.length && paymentMethod === 'CASH')
      );
    }
    
    // Filter by outstanding only (orders with outstanding balance > 0)
    if (outstandingOnly === 'true') {
      filteredOrders = filteredOrders.filter(order => {
        const outstanding = order.total.sub(order.paidAmount);
        return outstanding.greaterThan(0);
      });
    }
    
    // Transform to report format
    const reportData = filteredOrders.map(order => ({
      orderNumber: order.orderNumber,
      date: order.createdAt,
      supplier: order.supplier.name,
      notes: order.notes || null,
      total: order.total.toString(),
      paidAmount: order.paidAmount.toString(),
      outstanding: order.total.sub(order.paidAmount).toString(),
      paymentStatus: order.paymentConfirmed ? 'CONFIRMED' : 'PENDING',
      status: order.status,
      items: order.items.map(item => ({
        itemName: item.item.name,
        quantity: item.quantity.toString(),
        unitCost: item.unitCost.toString(),
        lineTotal: item.lineTotal.toString(),
      })),
      payments: order.payments.map(payment => ({
        amount: payment.amount.toString(),
        method: payment.method,
        paidAt: payment.paidAt,
        recordedBy: payment.recordedByUser?.username || 'غير محدد',
      })),
    }));
    
    // Calculate summary
    const totalOrders = filteredOrders.length;
    const totalPurchases = filteredOrders.reduce((sum, order) => sum.add(order.total), new Prisma.Decimal(0));
    const totalPaid = filteredOrders.reduce((sum, order) => sum.add(order.paidAmount), new Prisma.Decimal(0));
    const totalOutstanding = totalPurchases.sub(totalPaid);
    
    // Add initial and final stock for inventory reports
    let stockInfo: any = null;
    if (startDate && endDate && filteredOrders.length > 0) {
      // Get unique inventory IDs from orders
      const inventoryIds = [...new Set(filteredOrders.map(order => order.inventoryId))];
      
      for (const invId of inventoryIds) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);

        // Get initial stock
        const initialStocks = await prisma.inventoryStock.findMany({
          where: { inventoryId: invId },
          include: { item: true },
        });

        // Get stock movements
        const stockMovements = await prisma.stockMovement.findMany({
          where: {
            inventoryId: invId,
            movementDate: {
              gte: start,
              lte: end,
            },
          },
          include: { item: true },
        });

        const initialStockByItem: Record<string, number> = {};
        const finalStockByItem: Record<string, number> = {};

        for (const stock of initialStocks) {
          const firstMovement = stockMovements
            .filter(m => m.itemId === stock.itemId)
            .sort((a, b) => a.movementDate.getTime() - b.movementDate.getTime())[0];
          
          if (firstMovement) {
            initialStockByItem[stock.itemId] = parseFloat(firstMovement.openingBalance.toString());
          } else {
            const changes = stockMovements
              .filter(m => m.itemId === stock.itemId)
              .reduce((sum, m) => 
                sum + parseFloat(m.incoming.toString()) 
                - parseFloat(m.outgoing.toString())
                - parseFloat(m.pendingOutgoing.toString())
                + parseFloat(m.incomingGifts.toString())
                - parseFloat(m.outgoingGifts.toString()), 0
              );
            initialStockByItem[stock.itemId] = Math.max(0, parseFloat(stock.quantity.toString()) - changes);
          }
        }

        for (const stock of initialStocks) {
          const initial = initialStockByItem[stock.itemId] || 0;
          const movements = stockMovements.filter(m => m.itemId === stock.itemId);
          const totalIncoming = movements.reduce((sum, m) => sum + parseFloat(m.incoming.toString()), 0);
          const totalOutgoing = movements.reduce((sum, m) => sum + parseFloat(m.outgoing.toString()) + parseFloat(m.pendingOutgoing.toString()), 0);
          const totalIncomingGifts = movements.reduce((sum, m) => sum + parseFloat(m.incomingGifts.toString()), 0);
          const totalOutgoingGifts = movements.reduce((sum, m) => sum + parseFloat(m.outgoingGifts.toString()), 0);
          
          finalStockByItem[stock.itemId] = initial + totalIncoming - totalOutgoing + totalIncomingGifts - totalOutgoingGifts;
        }

        if (!stockInfo) stockInfo = { items: [] };
        stockInfo.items.push(...initialStocks.map(s => ({
          itemId: s.itemId,
          itemName: s.item.name,
          initialStock: initialStockByItem[s.itemId] || 0,
          finalStock: finalStockByItem[s.itemId] || 0,
        })));
      }
    }
    
    res.json({
      data: reportData,
      summary: {
        totalOrders,
        totalPurchases: totalPurchases.toString(),
        totalPaid: totalPaid.toString(),
        totalOutstanding: totalOutstanding.toString(),
      },
      ...(stockInfo && { stockInfo }),
    });
  } catch (error) {
    console.error('Supplier report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

