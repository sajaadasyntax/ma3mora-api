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
  toMethod: z.enum(['BANK', 'BANK_NILE']),
  receiptNumber: z.string().min(1),
  receiptUrl: z.string().optional(),
  notes: z.string().optional(),
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
      method: salary.paymentMethod,
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
      method: advance.paymentMethod,
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

router.post('/expenses', requireRole('ACCOUNTANT', 'MANAGER'), checkBalanceOpen, createAuditLog('Expense'), async (req: AuthRequest, res) => {
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
      CASH: openingBalances.filter(bal => bal.paymentMethod === 'CASH').reduce((sum, bal) => sum.add(bal.amount), new Prisma.Decimal(0)),
      BANK: openingBalances.filter(bal => bal.paymentMethod === 'BANK').reduce((sum, bal) => sum.add(bal.amount), new Prisma.Decimal(0)),
      BANK_NILE: openingBalances.filter(bal => bal.paymentMethod === 'BANK_NILE').reduce((sum, bal) => sum.add(bal.amount), new Prisma.Decimal(0)),
    };
    
    const totalOpeningBalance = openingBalanceByMethod.CASH.add(openingBalanceByMethod.BANK).add(openingBalanceByMethod.BANK_NILE);

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

router.get('/liquid-cash', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, section } = req.query;

    // Get all payments grouped by method with invoice items
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

    // Get procurement orders with items for expenses tracking
    const procOrders = await prisma.procOrder.findMany({
      where: {
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
      .filter(b => b.paymentMethod === 'CASH')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    
    const openingBank = openingBalances
      .filter(b => b.paymentMethod === 'BANK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    
    const openingBankNile = openingBalances
      .filter(b => b.paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    // Calculate net liquid cash (opening balance + payments - expenses)
    const netCash = openingCash.add(cashTotal).sub(cashExpenses);
    const netBank = openingBank.add(bankTotal).sub(bankExpenses);
    const netBankNile = openingBankNile.add(bankNileTotal).sub(bankNileExpenses);
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
          customer: p.invoice.customer.name,
          amount: p.amount.toFixed(2),
          method: p.method,
          paidAt: p.paidAt,
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
        balances.push(await tx.openingBalance.create({
          data: {
            scope: 'CASHBOX',
            amount: new Prisma.Decimal(cash),
            paymentMethod: 'CASH',
            notes: notes ? `رصيد افتتاحي - كاش - ${notes}` : 'رصيد افتتاحي - كاش',
          },
        }));
      }
      
      if (bank > 0) {
        balances.push(await tx.openingBalance.create({
          data: {
            scope: 'CASHBOX',
            amount: new Prisma.Decimal(bank),
            paymentMethod: 'BANK',
            notes: notes ? `رصيد افتتاحي - بنكك - ${notes}` : 'رصيد افتتاحي - بنكك',
          },
        }));
      }
      
      if (bankNile > 0) {
        balances.push(await tx.openingBalance.create({
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
      CASH: openBalances.filter(b => b.paymentMethod === 'CASH').reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
      BANK: openBalances.filter(b => b.paymentMethod === 'BANK').reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
      BANK_NILE: openBalances.filter(b => b.paymentMethod === 'BANK_NILE').reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0)),
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

router.get('/cash-exchanges', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const exchanges = await prisma.cashExchange.findMany({
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

    // Check if receipt number already exists in cash exchanges
    const existingExchange = await prisma.cashExchange.findUnique({
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
      where: { receiptNumber: data.receiptNumber },
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
          invoiceNumber: existingPayment.invoice.invoiceNumber,
          customer: existingPayment.invoice.customer.name,
          amount: existingPayment.amount.toString(),
          method: existingPayment.method,
          receiptNumber: existingPayment.receiptNumber,
          receiptUrl: existingPayment.receiptUrl,
          paidAt: existingPayment.paidAt,
          recordedBy: existingPayment.recordedByUser.username,
          notes: existingPayment.notes,
        }
      });
    }

    const exchange = await prisma.cashExchange.create({
      data: {
        amount: data.amount,
        fromMethod: 'CASH',
        toMethod: data.toMethod,
        receiptNumber: data.receiptNumber,
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
          customer: inv.customer.name,
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

export default router;

