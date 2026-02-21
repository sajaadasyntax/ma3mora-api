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

// ─── Helpers ────────────────────────────────────────────────────────────────

const TREASURY_METHODS = ['CASH', 'BANKAK', 'BANK_NILE'] as const;
type TreasuryMethod = (typeof TREASURY_METHODS)[number];

function emptyBucket(): Record<TreasuryMethod, Prisma.Decimal> {
  return {
    CASH: new Prisma.Decimal(0),
    BANKAK: new Prisma.Decimal(0),
    BANK_NILE: new Prisma.Decimal(0),
  };
}

function addToBucket(
  bucket: Record<TreasuryMethod, Prisma.Decimal>,
  method: string,
  amount: Prisma.Decimal,
) {
  if (method === 'CASH' || method === 'BANKAK' || method === 'BANK_NILE') {
    bucket[method] = bucket[method].add(amount);
  }
}

function toNumber(d: Prisma.Decimal): number {
  return parseFloat(d.toFixed(2));
}

function bucketToNumbers(bucket: Record<TreasuryMethod, Prisma.Decimal>) {
  return {
    cash: toNumber(bucket.CASH),
    bankak: toNumber(bucket.BANKAK),
    bankNile: toNumber(bucket.BANK_NILE),
  };
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const cashOutSchema = z.object({
  amount: z.number().positive({ message: 'المبلغ يجب أن يكون رقم موجب' }),
  method: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS'], {
    errorMap: () => ({ message: 'طريقة الدفع غير صالحة' }),
  }),
  description: z.string().min(1, { message: 'الوصف مطلوب' }),
  customerId: z.string().optional(),
  referenceNumber: z.string().optional(),
});

const cashInSchema = z.object({
  amount: z.number().positive({ message: 'المبلغ يجب أن يكون رقم موجب' }),
  method: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS'], {
    errorMap: () => ({ message: 'طريقة الدفع غير صالحة' }),
  }),
  description: z.string().min(1, { message: 'الوصف مطلوب' }),
  customerId: z.string().optional(),
  referenceNumber: z.string().optional(),
});

// ─── GET /treasury/daily — Daily Treasury Ledger ────────────────────────────

router.get('/daily', async (req: AuthRequest, res) => {
  try {
    const dateParam = req.query.date as string | undefined;
    const targetDate = dateParam ? new Date(dateParam) : new Date();

    // Normalise to start/end of day (UTC)
    const dayStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    // Previous day for opening balance snapshot
    const prevDay = new Date(dayStart);
    prevDay.setDate(prevDay.getDate() - 1);

    // ── 1. Opening balance ────────────────────────────────────────────────
    const opening = emptyBucket();

    // Try CumulativeBalanceSnapshot for the previous day (global, no inventory)
    const snapshot = await prisma.cumulativeBalanceSnapshot.findFirst({
      where: {
        date: prevDay,
        inventoryId: null,
        section: null,
      },
    });

    if (snapshot) {
      opening.CASH = snapshot.closingCash;
      opening.BANKAK = snapshot.closingBank;
      opening.BANK_NILE = snapshot.closingBankNile;
    } else {
      // Fallback: aggregate OpeningBalance records for CASHBOX scope
      const openingBalances = await prisma.openingBalance.findMany({
        where: {
          scope: 'CASHBOX',
          isClosed: false,
        },
      });
      for (const ob of openingBalances) {
        addToBucket(opening, ob.paymentMethod, ob.amount);
      }
    }

    // ── 2. Inflow ─────────────────────────────────────────────────────────
    const inflow = emptyBucket();
    const inflowDetails: { label: string; cash: number; bankak: number; bankNile: number }[] = [];

    // 2a. Sales payments (from confirmed invoices)
    const salesPayments = await prisma.salesPayment.findMany({
      where: {
        paidAt: { gte: dayStart, lt: dayEnd },
        invoice: {
          paymentConfirmationStatus: 'CONFIRMED',
        },
      },
    });
    const salesBucket = emptyBucket();
    for (const sp of salesPayments) {
      addToBucket(inflow, sp.method, sp.amount);
      addToBucket(salesBucket, sp.method, sp.amount);
    }
    inflowDetails.push({ label: 'مبيعات', ...bucketToNumbers(salesBucket) });

    // 2b. Customer payments (account payments)
    const customerPayments = await prisma.customerPayment.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
    });
    const custPayBucket = emptyBucket();
    for (const cp of customerPayments) {
      addToBucket(inflow, cp.method, cp.amount);
      addToBucket(custPayBucket, cp.method, cp.amount);
    }
    inflowDetails.push({ label: 'مدفوعات عملاء', ...bucketToNumbers(custPayBucket) });

    // 2c. Income
    const incomes = await prisma.income.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd }, isDebt: false },
    });
    const incomeBucket = emptyBucket();
    for (const inc of incomes) {
      addToBucket(inflow, inc.method, inc.amount);
      addToBucket(incomeBucket, inc.method, inc.amount);
    }
    inflowDetails.push({ label: 'إيرادات', ...bucketToNumbers(incomeBucket) });

    // 2d. Cash exchanges (toMethod counts as inflow)
    const cashExchanges = await prisma.cashExchange.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
    });
    const exchInBucket = emptyBucket();
    for (const ce of cashExchanges) {
      addToBucket(inflow, ce.toMethod, ce.amount);
      addToBucket(exchInBucket, ce.toMethod, ce.amount);
    }
    inflowDetails.push({ label: 'تحويلات واردة', ...bucketToNumbers(exchInBucket) });

    // 2e. Treasury CASH_IN
    const treasuryIn = await prisma.treasuryTransaction.findMany({
      where: { type: 'CASH_IN', createdAt: { gte: dayStart, lt: dayEnd } },
    });
    const treasInBucket = emptyBucket();
    for (const t of treasuryIn) {
      addToBucket(inflow, t.method, t.amount);
      addToBucket(treasInBucket, t.method, t.amount);
    }
    inflowDetails.push({ label: 'إيداع خزينة', ...bucketToNumbers(treasInBucket) });

    // ── 3. Outflow ────────────────────────────────────────────────────────
    const outflow = emptyBucket();
    const outflowDetails: { label: string; cash: number; bankak: number; bankNile: number }[] = [];

    // 3a. Procurement payments
    const procPayments = await prisma.procOrderPayment.findMany({
      where: { paidAt: { gte: dayStart, lt: dayEnd } },
    });
    const procBucket = emptyBucket();
    for (const pp of procPayments) {
      addToBucket(outflow, pp.method, pp.amount);
      addToBucket(procBucket, pp.method, pp.amount);
    }
    outflowDetails.push({ label: 'مشتريات', ...bucketToNumbers(procBucket) });

    // 3b. Expenses
    const expenses = await prisma.expense.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd }, isDebt: false },
    });
    const expBucket = emptyBucket();
    for (const exp of expenses) {
      addToBucket(outflow, exp.method, exp.amount);
      addToBucket(expBucket, exp.method, exp.amount);
    }
    outflowDetails.push({ label: 'مصروفات', ...bucketToNumbers(expBucket) });

    // 3c. Salaries paid
    const salaries = await prisma.salary.findMany({
      where: { paidAt: { gte: dayStart, lt: dayEnd } },
    });
    const salBucket = emptyBucket();
    for (const sal of salaries) {
      addToBucket(outflow, sal.paymentMethod, sal.netAmount);
      addToBucket(salBucket, sal.paymentMethod, sal.netAmount);
    }
    outflowDetails.push({ label: 'رواتب', ...bucketToNumbers(salBucket) });

    // 3d. Advances paid
    const advances = await prisma.advance.findMany({
      where: { paidAt: { gte: dayStart, lt: dayEnd } },
    });
    const advBucket = emptyBucket();
    for (const adv of advances) {
      addToBucket(outflow, adv.paymentMethod, adv.amount);
      addToBucket(advBucket, adv.paymentMethod, adv.amount);
    }
    outflowDetails.push({ label: 'سلف', ...bucketToNumbers(advBucket) });

    // 3e. Cash exchanges (fromMethod counts as outflow)
    const exchOutBucket = emptyBucket();
    for (const ce of cashExchanges) {
      addToBucket(outflow, ce.fromMethod, ce.amount);
      addToBucket(exchOutBucket, ce.fromMethod, ce.amount);
    }
    outflowDetails.push({ label: 'تحويلات صادرة', ...bucketToNumbers(exchOutBucket) });

    // 3f. Treasury CASH_OUT
    const treasuryOut = await prisma.treasuryTransaction.findMany({
      where: { type: 'CASH_OUT', createdAt: { gte: dayStart, lt: dayEnd } },
    });
    const treasOutBucket = emptyBucket();
    for (const t of treasuryOut) {
      addToBucket(outflow, t.method, t.amount);
      addToBucket(treasOutBucket, t.method, t.amount);
    }
    outflowDetails.push({ label: 'سحب خزينة', ...bucketToNumbers(treasOutBucket) });

    // ── 4. Closing = Opening + Inflow − Outflow ──────────────────────────
    const closing: Record<TreasuryMethod, Prisma.Decimal> = {
      CASH: opening.CASH.add(inflow.CASH).sub(outflow.CASH),
      BANKAK: opening.BANKAK.add(inflow.BANKAK).sub(outflow.BANKAK),
      BANK_NILE: opening.BANK_NILE.add(inflow.BANK_NILE).sub(outflow.BANK_NILE),
    };

    res.json({
      date: dayStart.toISOString().slice(0, 10),
      opening: bucketToNumbers(opening),
      inflow: {
        ...bucketToNumbers(inflow),
        details: inflowDetails,
      },
      outflow: {
        ...bucketToNumbers(outflow),
        details: outflowDetails,
      },
      closing: bucketToNumbers(closing),
    });
  } catch (error) {
    console.error('Error in daily treasury:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تقرير الخزينة اليومي' });
  }
});

// ─── POST /treasury/cash-out — Cash Out ─────────────────────────────────────

router.post(
  '/cash-out',
  requireRole('ACCOUNTANT', 'MANAGER'),
  createAuditLog('TreasuryTransaction'),
  async (req: AuthRequest, res) => {
    try {
      const validation = cashOutSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'بيانات غير صالحة',
          details: validation.error.errors.map((e) => e.message),
        });
      }

      const { amount, method, description, customerId, referenceNumber } = validation.data;

      // Verify customer exists if provided
      if (customerId) {
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (!customer) {
          return res.status(404).json({ error: 'العميل غير موجود' });
        }
      }

      const transaction = await prisma.$transaction(async (tx) => {
        // Create the treasury transaction
        const created = await tx.treasuryTransaction.create({
          data: {
            type: 'CASH_OUT',
            amount: new Prisma.Decimal(amount),
            method: method as any,
            description,
            customerId: customerId || null,
            referenceNumber: referenceNumber || null,
            createdBy: req.user!.id,
          },
          include: {
            customer: true,
            creator: { select: { id: true, username: true } },
          },
        });

        // If customerId provided, update CustomerCumulativeAggregate
        if (customerId) {
          const today = new Date();
          const dateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

          await tx.customerCumulativeAggregate.upsert({
            where: {
              customerId_date: {
                customerId,
                date: dateOnly,
              },
            },
            create: {
              customerId,
              date: dateOnly,
              totalOutstanding: new Prisma.Decimal(amount),
            },
            update: {
              totalOutstanding: { increment: amount },
            },
          });
        }

        return created;
      });

      res.status(201).json(transaction);
    } catch (error) {
      console.error('Error creating cash-out:', error);
      res.status(500).json({ error: 'حدث خطأ أثناء إنشاء عملية السحب' });
    }
  },
);

// ─── POST /treasury/cash-in — Cash In ───────────────────────────────────────

router.post(
  '/cash-in',
  requireRole('ACCOUNTANT', 'MANAGER'),
  createAuditLog('TreasuryTransaction'),
  async (req: AuthRequest, res) => {
    try {
      const validation = cashInSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          error: 'بيانات غير صالحة',
          details: validation.error.errors.map((e) => e.message),
        });
      }

      const { amount, method, description, customerId, referenceNumber } = validation.data;

      // Verify customer exists if provided
      if (customerId) {
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (!customer) {
          return res.status(404).json({ error: 'العميل غير موجود' });
        }
      }

      const transaction = await prisma.treasuryTransaction.create({
        data: {
          type: 'CASH_IN',
          amount: new Prisma.Decimal(amount),
          method: method as any,
          description,
          customerId: customerId || null,
          referenceNumber: referenceNumber || null,
          createdBy: req.user!.id,
        },
        include: {
          customer: true,
          creator: { select: { id: true, username: true } },
        },
      });

      res.status(201).json(transaction);
    } catch (error) {
      console.error('Error creating cash-in:', error);
      res.status(500).json({ error: 'حدث خطأ أثناء إنشاء عملية الإيداع' });
    }
  },
);

// ─── GET /treasury/transactions — List treasury transactions ────────────────

router.get('/transactions', async (req: AuthRequest, res) => {
  try {
    const { dateFrom, dateTo, customerId, type } = req.query;

    const where: Prisma.TreasuryTransactionWhereInput = {};

    // Date range filter
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt.gte = new Date(dateFrom as string);
      }
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setDate(to.getDate() + 1);
        where.createdAt.lt = to;
      }
    }

    // Customer filter
    if (customerId) {
      where.customerId = customerId as string;
    }

    // Type filter
    if (type) {
      const typeVal = (type as string).toUpperCase();
      if (typeVal !== 'CASH_IN' && typeVal !== 'CASH_OUT') {
        return res.status(400).json({ error: 'نوع العملية غير صالح، يجب أن يكون CASH_IN أو CASH_OUT' });
      }
      where.type = typeVal as 'CASH_IN' | 'CASH_OUT';
    }

    const transactions = await prisma.treasuryTransaction.findMany({
      where,
      include: {
        customer: true,
        creator: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate grand totals
    let totalInflow = new Prisma.Decimal(0);
    let totalOutflow = new Prisma.Decimal(0);

    for (const t of transactions) {
      if (t.type === 'CASH_IN') {
        totalInflow = totalInflow.add(t.amount);
      } else {
        totalOutflow = totalOutflow.add(t.amount);
      }
    }

    res.json({
      transactions,
      grandTotal: {
        totalInflow: toNumber(totalInflow),
        totalOutflow: toNumber(totalOutflow),
      },
    });
  } catch (error) {
    console.error('Error listing treasury transactions:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب عمليات الخزينة' });
  }
});

export default router;
