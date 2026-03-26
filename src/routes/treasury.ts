import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';
import { aggregationService } from '../services/aggregationService';
import { prisma } from '../lib/prisma';

const router = Router();

router.use(requireAuth);
router.use(blockAuditorWrites);

// ─── Helpers ────────────────────────────────────────────────────────────────

const TREASURY_METHODS = ['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS'] as const;
type TreasuryMethod = (typeof TREASURY_METHODS)[number];

function emptyBucket(): Record<TreasuryMethod, Prisma.Decimal> {
  return {
    CASH: new Prisma.Decimal(0),
    BANKAK: new Prisma.Decimal(0),
    BANK_NILE: new Prisma.Decimal(0),
    COMMISSION: new Prisma.Decimal(0),
    DEBT: new Prisma.Decimal(0),
    OTHERS: new Prisma.Decimal(0),
  };
}

function addToBucket(
  bucket: Record<TreasuryMethod, Prisma.Decimal>,
  method: string,
  amount: Prisma.Decimal,
) {
  if (TREASURY_METHODS.includes(method as TreasuryMethod)) {
    bucket[method as TreasuryMethod] = bucket[method as TreasuryMethod].add(amount);
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
    commission: toNumber(bucket.COMMISSION),
    debt: toNumber(bucket.DEBT),
    others: toNumber(bucket.OTHERS),
  };
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const cashOutSchema = z
  .object({
    amount: z.number().positive({ message: 'المبلغ يجب أن يكون رقم موجب' }),
    method: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS'], {
      errorMap: () => ({ message: 'طريقة الدفع غير صالحة' }),
    }),
    description: z.string().min(1, { message: 'الوصف مطلوب' }),
    customerId: z.string().optional(),
    supplierId: z.string().optional(),
    referenceNumber: z.string().optional(),
  })
  .refine((d) => !(d.customerId && d.supplierId), {
    message: 'لا يمكن ربط العملية بعميل ومورد معاً',
  });

const cashInSchema = z
  .object({
    amount: z.number().positive({ message: 'المبلغ يجب أن يكون رقم موجب' }),
    method: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS'], {
      errorMap: () => ({ message: 'طريقة الدفع غير صالحة' }),
    }),
    description: z.string().min(1, { message: 'الوصف مطلوب' }),
    customerId: z.string().optional(),
    supplierId: z.string().optional(),
    referenceNumber: z.string().optional(),
  })
  .refine((d) => !(d.customerId && d.supplierId), {
    message: 'لا يمكن ربط العملية بعميل ومورد معاً',
  });

function customerSalesMethodField(
  method: string
): 'salesCash' | 'salesBank' | 'salesBankNile' | 'salesDebtMethod' | 'salesOthers' {
  switch (method) {
    case 'CASH':
      return 'salesCash';
    case 'BANKAK':
      return 'salesBank';
    case 'BANK_NILE':
      return 'salesBankNile';
    case 'DEBT':
      return 'salesDebtMethod';
    case 'COMMISSION':
    case 'OTHERS':
    default:
      return 'salesOthers';
  }
}

function supplierPurchaseBuckets(method: string, amount: Prisma.Decimal) {
  const z = new Prisma.Decimal(0);
  if (method === 'CASH') return { purchasesCash: amount, purchasesBank: z, purchasesBankNile: z };
  if (method === 'BANKAK') return { purchasesCash: z, purchasesBank: amount, purchasesBankNile: z };
  if (method === 'BANK_NILE') return { purchasesCash: z, purchasesBank: z, purchasesBankNile: amount };
  return { purchasesCash: amount, purchasesBank: z, purchasesBankNile: z };
}

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

    // Find the most recent CumulativeBalanceSnapshot on or before the previous day.
    // Using lte (not eq) handles gaps: days with no transactions produce no snapshot,
    // so we walk back to the nearest recorded closing balance.
    const snapshot = await prisma.cumulativeBalanceSnapshot.findFirst({
      where: {
        date: { lte: prevDay },
        inventoryId: null,
        section: null,
      },
      orderBy: { date: 'desc' },
    });

    if (snapshot) {
      // Use the snapshot's closing balance as opening.
      // If the snapshot is from before yesterday, we need to add any transactions
      // that occurred between that snapshot date and today's start.
      const snapshotDate = new Date(snapshot.date);
      snapshotDate.setHours(0, 0, 0, 0);
      const snapshotEnd = new Date(snapshotDate);
      snapshotEnd.setDate(snapshotEnd.getDate() + 1); // day after snapshot

      opening.CASH = snapshot.closingCash;
      opening.BANKAK = snapshot.closingBank;
      opening.BANK_NILE = snapshot.closingBankNile;

      // If the snapshot is not from yesterday, catch up missing days' transactions
      if (snapshotEnd < dayStart) {
        // Sales payments between snapshot+1 and today
        const missedSalesPayments = await prisma.salesPayment.findMany({
          where: {
            paidAt: { gte: snapshotEnd, lt: dayStart },
            invoice: { paymentConfirmationStatus: 'CONFIRMED' },
          },
        });
        for (const sp of missedSalesPayments) {
          addToBucket(opening, sp.method, sp.amount);
        }

        // Expenses between snapshot+1 and today
        const missedExpenses = await prisma.expense.findMany({
          where: { createdAt: { gte: snapshotEnd, lt: dayStart }, isDebt: false },
        });
        for (const e of missedExpenses) {
          const m = e.method as TreasuryMethod;
          if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(e.amount);
        }

        // Salaries paid between snapshot+1 and today
        const missedSalaries = await prisma.salary.findMany({
          where: { paidAt: { gte: snapshotEnd, lt: dayStart } },
        });
        for (const s of missedSalaries) {
          const m = s.paymentMethod as TreasuryMethod;
          if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(s.netAmount);
        }

        // Advances paid between snapshot+1 and today
        const missedAdvances = await prisma.advance.findMany({
          where: { paidAt: { gte: snapshotEnd, lt: dayStart } },
        });
        for (const a of missedAdvances) {
          const m = a.paymentMethod as TreasuryMethod;
          if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(a.amount);
        }

        // Procurement payments between snapshot+1 and today
        const missedProcPayments = await prisma.procOrderPayment.findMany({
          where: {
            paidAt: { gte: snapshotEnd, lt: dayStart },
            order: { status: { not: 'CANCELLED' } },
          },
        });
        for (const p of missedProcPayments) {
          const m = p.method as TreasuryMethod;
          if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(p.amount);
        }

        // Cash exchanges between snapshot+1 and today
        const missedExchanges = await (prisma as any).cashExchange.findMany({
          where: { createdAt: { gte: snapshotEnd, lt: dayStart } },
        });
        for (const ce of missedExchanges) {
          addToBucket(opening, ce.toMethod, ce.amount);
          opening[ce.fromMethod as TreasuryMethod] = opening[ce.fromMethod as TreasuryMethod].sub(ce.amount);
        }

        // Treasury transactions (CASH_IN/CASH_OUT) between snapshot+1 and today
        const missedTreasury = await (prisma as any).treasuryTransaction.findMany({
          where: { createdAt: { gte: snapshotEnd, lt: dayStart } },
        });
        for (const t of missedTreasury) {
          if (t.type === 'CASH_IN') addToBucket(opening, t.method, t.amount);
          else if (t.type === 'CASH_OUT') opening[t.method as TreasuryMethod] = opening[t.method as TreasuryMethod].sub(t.amount);
        }

        // Income between snapshot+1 and today
        const missedIncome = await prisma.income.findMany({
          where: { createdAt: { gte: snapshotEnd, lt: dayStart }, isDebt: false },
        });
        for (const i of missedIncome) {
          const m = (i as any).method as TreasuryMethod;
          if (TREASURY_METHODS.includes(m)) addToBucket(opening, m, i.amount);
        }
      }
    } else {
      // No snapshot at all — compute opening from raw OpeningBalance records
      // then add all transactions before today
      const openingBalances = await prisma.openingBalance.findMany({
        where: { scope: 'CASHBOX', isClosed: false },
      });
      for (const ob of openingBalances) {
        addToBucket(opening, ob.paymentMethod, ob.amount);
      }

      // Add all transactions up to (but not including) today
      const allSalesPayments = await prisma.salesPayment.findMany({
        where: { paidAt: { lt: dayStart }, invoice: { paymentConfirmationStatus: 'CONFIRMED' } },
      });
      for (const sp of allSalesPayments) addToBucket(opening, sp.method, sp.amount);

      const allExpenses = await prisma.expense.findMany({
        where: { createdAt: { lt: dayStart }, isDebt: false },
      });
      for (const e of allExpenses) {
        const m = e.method as TreasuryMethod;
        if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(e.amount);
      }


      const allSalaries = await prisma.salary.findMany({ where: { paidAt: { lt: dayStart } } });
      for (const s of allSalaries) {
        const m = s.paymentMethod as TreasuryMethod;
        if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(s.netAmount);
      }

      const allAdvances = await prisma.advance.findMany({ where: { paidAt: { lt: dayStart } } });
      for (const a of allAdvances) {
        const m = a.paymentMethod as TreasuryMethod;
        if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(a.amount);
      }

      const allProcPayments = await prisma.procOrderPayment.findMany({
        where: { paidAt: { lt: dayStart }, order: { status: { not: 'CANCELLED' } } },
      });
      for (const p of allProcPayments) {
        const m = p.method as TreasuryMethod;
        if (TREASURY_METHODS.includes(m)) opening[m] = opening[m].sub(p.amount);
      }

      const allExchanges = await (prisma as any).cashExchange.findMany({
        where: { createdAt: { lt: dayStart } },
      });
      for (const ce of allExchanges) {
        addToBucket(opening, ce.toMethod, ce.amount);
        opening[ce.fromMethod as TreasuryMethod] = opening[ce.fromMethod as TreasuryMethod].sub(ce.amount);
      }

      const allTreasury = await (prisma as any).treasuryTransaction.findMany({
        where: { createdAt: { lt: dayStart } },
      });
      for (const t of allTreasury) {
        if (t.type === 'CASH_IN') addToBucket(opening, t.method, t.amount);
        else if (t.type === 'CASH_OUT') opening[t.method as TreasuryMethod] = opening[t.method as TreasuryMethod].sub(t.amount);
      }

      const allIncome = await prisma.income.findMany({
        where: { createdAt: { lt: dayStart }, isDebt: false },
      });
      for (const i of allIncome) {
        const m = (i as any).method as TreasuryMethod;
        if (TREASURY_METHODS.includes(m)) addToBucket(opening, m, i.amount);
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
    // C4: Include all 6 TreasuryMethod keys to match the full type definition
    const closing: Record<TreasuryMethod, Prisma.Decimal> = {
      CASH: opening.CASH.add(inflow.CASH).sub(outflow.CASH),
      BANKAK: opening.BANKAK.add(inflow.BANKAK).sub(outflow.BANKAK),
      BANK_NILE: opening.BANK_NILE.add(inflow.BANK_NILE).sub(outflow.BANK_NILE),
      COMMISSION: opening.COMMISSION.add(inflow.COMMISSION).sub(outflow.COMMISSION),
      DEBT: opening.DEBT.add(inflow.DEBT).sub(outflow.DEBT),
      OTHERS: opening.OTHERS.add(inflow.OTHERS).sub(outflow.OTHERS),
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

      const { amount, method, description, customerId, supplierId, referenceNumber } = validation.data;

      // Verify customer exists if provided
      if (customerId) {
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (!customer) {
          return res.status(404).json({ error: 'العميل غير موجود' });
        }
      }
      if (supplierId) {
        const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
        if (!supplier) {
          return res.status(404).json({ error: 'المورد غير موجود' });
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
            supplierId: supplierId || null,
            referenceNumber: referenceNumber || null,
            createdBy: req.user!.id,
          },
          include: {
            customer: true,
            supplier: true,
            creator: { select: { id: true, username: true } },
          },
        });

        // If customerId provided, update CustomerCumulativeAggregate
        if (customerId) {
          const today = new Date();
          const dateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());

          const previousAggregate = await tx.customerCumulativeAggregate.findFirst({
            where: { customerId, date: { lte: dateOnly } },
            orderBy: { date: 'desc' },
          });

          const newTotalOutstanding = previousAggregate
            ? previousAggregate.totalOutstanding.add(new Prisma.Decimal(amount))
            : new Prisma.Decimal(amount);

          await tx.customerCumulativeAggregate.upsert({
            where: {
              customerId_date: {
                customerId,
                date: dateOnly,
              },
            },
            update: { totalOutstanding: newTotalOutstanding },
            create: {
              customerId,
              date: dateOnly,
              totalSales: previousAggregate?.totalSales || new Prisma.Decimal(0),
              totalPaid: previousAggregate?.totalPaid || new Prisma.Decimal(0),
              totalOutstanding: newTotalOutstanding,
              totalInvoices: previousAggregate?.totalInvoices || 0,
              salesCash: previousAggregate?.salesCash || new Prisma.Decimal(0),
              salesBank: previousAggregate?.salesBank || new Prisma.Decimal(0),
              salesBankNile: previousAggregate?.salesBankNile || new Prisma.Decimal(0),
              salesDebtMethod: previousAggregate?.salesDebtMethod || new Prisma.Decimal(0),
              salesOthers: previousAggregate?.salesOthers || new Prisma.Decimal(0),
            },
          });
        }

        return created;
      });

      if (supplierId) {
        try {
          const amt = new Prisma.Decimal(amount);
          const buckets = supplierPurchaseBuckets(method, amt);
          await aggregationService.updateSupplierCumulativeAggregate(supplierId, new Date(), {
            totalPaid: amt,
            ...buckets,
          });
        } catch (supAggErr) {
          console.error('Supplier aggregate update (treasury cash-out):', supAggErr);
        }
      }

      try {
        await aggregationService.updateDailyFinancialAggregate(new Date(), {
          treasuryOutflow: new Prisma.Decimal(amount),
        });
      } catch (aggError) {
        console.error('Aggregation update error:', aggError);
      }

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

      const { amount, method, description, customerId, supplierId, referenceNumber } = validation.data;

      if (customerId) {
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (!customer) {
          return res.status(404).json({ error: 'العميل غير موجود' });
        }
      }
      if (supplierId) {
        const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
        if (!supplier) {
          return res.status(404).json({ error: 'المورد غير موجود' });
        }
      }

      const amountDecimal = new Prisma.Decimal(amount);

      const transaction = await prisma.$transaction(async (tx) => {
        const created = await tx.treasuryTransaction.create({
          data: {
            type: 'CASH_IN',
            amount: amountDecimal,
            method: method as any,
            description,
            customerId: customerId || null,
            supplierId: supplierId || null,
            referenceNumber: referenceNumber || null,
            createdBy: req.user!.id,
          },
          include: {
            customer: true,
            supplier: true,
            creator: { select: { id: true, username: true } },
          },
        });

        // Customer paid at treasury → reduce outstanding (same logic as account payment)
        if (customerId) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const previousAggregate = await tx.customerCumulativeAggregate.findFirst({
            where: {
              customerId,
              date: { lte: today },
            },
            orderBy: { date: 'desc' },
          });

          const totalInvoices = previousAggregate?.totalInvoices || 0;
          const totalSales = previousAggregate?.totalSales || new Prisma.Decimal(0);
          const totalPaid = (previousAggregate?.totalPaid || new Prisma.Decimal(0)).add(amountDecimal);
          const totalOutstanding = totalSales.sub(totalPaid);
          const totalAccountPayments = (previousAggregate?.totalAccountPayments || new Prisma.Decimal(0)).add(
            amountDecimal
          );

          let salesCash = previousAggregate?.salesCash || new Prisma.Decimal(0);
          let salesBank = previousAggregate?.salesBank || new Prisma.Decimal(0);
          let salesBankNile = previousAggregate?.salesBankNile || new Prisma.Decimal(0);
          let salesDebtMethod = previousAggregate?.salesDebtMethod || new Prisma.Decimal(0);
          let salesOthers = previousAggregate?.salesOthers || new Prisma.Decimal(0);

          const mf = customerSalesMethodField(method);
          if (mf === 'salesCash') salesCash = salesCash.add(amountDecimal);
          else if (mf === 'salesBank') salesBank = salesBank.add(amountDecimal);
          else if (mf === 'salesBankNile') salesBankNile = salesBankNile.add(amountDecimal);
          else if (mf === 'salesDebtMethod') salesDebtMethod = salesDebtMethod.add(amountDecimal);
          else salesOthers = salesOthers.add(amountDecimal);

          await tx.customerCumulativeAggregate.upsert({
            where: {
              customerId_date: {
                customerId,
                date: today,
              },
            },
            update: {
              totalPaid,
              totalOutstanding,
              totalAccountPayments,
              salesCash,
              salesBank,
              salesBankNile,
              salesDebtMethod,
              salesOthers,
            },
            create: {
              customerId,
              date: today,
              totalInvoices,
              totalSales,
              totalPaid,
              totalOutstanding,
              totalAccountPayments,
              salesCash,
              salesBank,
              salesBankNile,
              salesDebtMethod,
              salesOthers,
            },
          });
        }

        return created;
      });

      // CASH_IN from a supplier means they deposited/returned money to us,
      // so it does NOT count as "we paid the supplier" — no aggregate update here.

      try {
        await aggregationService.updateDailyFinancialAggregate(new Date(), {
          treasuryInflow: amountDecimal,
        });
      } catch (aggError) {
        console.error('Aggregation update error:', aggError);
      }

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
    const { dateFrom, dateTo, customerId, supplierId, type } = req.query;

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
    if (supplierId) {
      where.supplierId = supplierId as string;
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
        supplier: true,
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
