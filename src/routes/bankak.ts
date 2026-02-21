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

// ==================== Schemas ====================

const createBankakTransactionSchema = z.object({
  amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر'),
  direction: z.enum(['IN', 'OUT'], { errorMap: () => ({ message: 'الاتجاه يجب أن يكون IN أو OUT' }) }),
  referenceNumber: z.string().optional(),
  customerId: z.string().optional(),
  description: z.string().min(1, 'الوصف مطلوب'),
});

// ==================== Endpoints ====================

// POST /bankak/transactions - Record Bankak transaction
router.post(
  '/transactions',
  requireRole('ACCOUNTANT', 'MANAGER'),
  createAuditLog('BankakTransaction'),
  async (req: AuthRequest, res) => {
    try {
      const data = createBankakTransactionSchema.parse(req.body);

      // Validate customer exists if provided
      if (data.customerId) {
        const customer = await prisma.customer.findUnique({
          where: { id: data.customerId },
        });
        if (!customer) {
          return res.status(404).json({ error: 'العميل غير موجود' });
        }
      }

      const transaction = await prisma.bankakTransaction.create({
        data: {
          amount: data.amount,
          direction: data.direction,
          referenceNumber: data.referenceNumber,
          customerId: data.customerId,
          description: data.description,
          createdBy: req.user!.id,
        },
        include: {
          customer: true,
          creator: {
            select: { id: true, username: true },
          },
        },
      });

      res.status(201).json(transaction);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      console.error('Create bankak transaction error:', error);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  }
);

// GET /bankak/transactions - List with search and totals
router.get('/transactions', async (req: AuthRequest, res) => {
  try {
    const { dateFrom, dateTo, customerId, direction, referenceNumber } = req.query;

    const where: any = {};

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt.gte = new Date(dateFrom as string);
      }
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    if (customerId) {
      where.customerId = customerId as string;
    }

    if (direction && (direction === 'IN' || direction === 'OUT')) {
      where.direction = direction as string;
    }

    if (referenceNumber) {
      where.referenceNumber = {
        contains: referenceNumber as string,
        mode: 'insensitive',
      };
    }

    const transactions = await prisma.bankakTransaction.findMany({
      where,
      include: {
        customer: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalIn = transactions
      .filter((t) => t.direction === 'IN')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const totalOut = transactions
      .filter((t) => t.direction === 'OUT')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const net = totalIn.sub(totalOut);

    res.json({
      transactions,
      grandTotal: {
        totalIn: totalIn.toFixed(2),
        totalOut: totalOut.toFixed(2),
        net: net.toFixed(2),
      },
    });
  } catch (error) {
    console.error('List bankak transactions error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /bankak/daily - Daily Bankak Movement Report
router.get('/daily', async (req: AuthRequest, res) => {
  try {
    const dateParam = req.query.date as string | undefined;
    const targetDate = dateParam ? new Date(dateParam) : new Date();

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const startOfPreviousDay = new Date(startOfDay);
    startOfPreviousDay.setDate(startOfPreviousDay.getDate() - 1);
    startOfPreviousDay.setHours(0, 0, 0, 0);

    // ---- Opening Balance ----
    // Try to get from OpeningBalance with paymentMethod=BANKAK, scope=CASHBOX
    const openingBalanceRecord = await prisma.openingBalance.findFirst({
      where: {
        scope: 'CASHBOX',
        paymentMethod: 'BANKAK',
      },
      orderBy: { openedAt: 'desc' },
    });

    let opening = openingBalanceRecord
      ? new Prisma.Decimal(openingBalanceRecord.amount)
      : new Prisma.Decimal(0);

    // Add all transactions before the target date to compute the actual opening
    const preDayBankakTxns = await prisma.bankakTransaction.findMany({
      where: { createdAt: { lt: startOfDay } },
    });
    preDayBankakTxns.forEach((t) => {
      if (t.direction === 'IN') {
        opening = opening.add(t.amount);
      } else {
        opening = opening.sub(t.amount);
      }
    });

    // Pre-day sales payments with method=BANKAK
    const preDaySalesPayments = await prisma.salesPayment.findMany({
      where: {
        paidAt: { lt: startOfDay },
        method: 'BANKAK',
        invoice: { paymentConfirmationStatus: 'CONFIRMED' },
      },
    });
    preDaySalesPayments.forEach((p) => {
      opening = opening.add(p.amount);
    });

    // Pre-day cash exchanges toMethod=BANKAK (IN) and fromMethod=BANKAK (OUT)
    const preDayExchanges = await (prisma as any).cashExchange.findMany({
      where: { createdAt: { lt: startOfDay } },
    });
    preDayExchanges.forEach((e: any) => {
      if (e.toMethod === 'BANKAK') {
        opening = opening.add(e.amount);
      }
      if (e.fromMethod === 'BANKAK') {
        opening = opening.sub(e.amount);
      }
    });

    // Pre-day procurement payments with method=BANKAK
    const preDayProcPayments = await prisma.procOrderPayment.findMany({
      where: {
        paidAt: { lt: startOfDay },
        method: 'BANKAK',
        order: { paymentConfirmed: true, status: { not: 'CANCELLED' } },
      },
    });
    preDayProcPayments.forEach((p) => {
      opening = opening.sub(p.amount);
    });

    // Pre-day expenses with method=BANKAK
    const preDayExpenses = await prisma.expense.findMany({
      where: {
        createdAt: { lt: startOfDay },
        method: 'BANKAK',
      },
    });
    preDayExpenses.forEach((e) => {
      opening = opening.sub(e.amount);
    });

    // ---- Today's IN ----
    // Bankak transactions IN
    const todayBankakIn = await prisma.bankakTransaction.findMany({
      where: {
        direction: 'IN',
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
      include: {
        customer: true,
        creator: { select: { id: true, username: true } },
      },
    });
    const bankakInTotal = todayBankakIn.reduce(
      (sum, t) => sum.add(t.amount),
      new Prisma.Decimal(0)
    );

    // Sales payments with method=BANKAK today
    const todaySalesPayments = await prisma.salesPayment.findMany({
      where: {
        paidAt: { gte: startOfDay, lte: endOfDay },
        method: 'BANKAK',
        invoice: { paymentConfirmationStatus: 'CONFIRMED' },
      },
    });
    const salesBankakIn = todaySalesPayments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0)
    );

    // Cash exchanges toMethod=BANKAK today
    const todayExchanges = await (prisma as any).cashExchange.findMany({
      where: {
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
    });
    const exchangeIn = todayExchanges
      .filter((e: any) => e.toMethod === 'BANKAK')
      .reduce((sum: Prisma.Decimal, e: any) => sum.add(e.amount), new Prisma.Decimal(0));

    const totalIn = bankakInTotal.add(salesBankakIn).add(exchangeIn);

    // ---- Today's OUT ----
    // Bankak transactions OUT
    const todayBankakOut = await prisma.bankakTransaction.findMany({
      where: {
        direction: 'OUT',
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
      include: {
        customer: true,
        creator: { select: { id: true, username: true } },
      },
    });
    const bankakOutTotal = todayBankakOut.reduce(
      (sum, t) => sum.add(t.amount),
      new Prisma.Decimal(0)
    );

    // Procurement payments with method=BANKAK today
    const todayProcPayments = await prisma.procOrderPayment.findMany({
      where: {
        paidAt: { gte: startOfDay, lte: endOfDay },
        method: 'BANKAK',
        order: { paymentConfirmed: true, status: { not: 'CANCELLED' } },
      },
    });
    const procBankakOut = todayProcPayments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0)
    );

    // Expenses with method=BANKAK today
    const todayExpenses = await prisma.expense.findMany({
      where: {
        createdAt: { gte: startOfDay, lte: endOfDay },
        method: 'BANKAK',
      },
    });
    const expensesBankakOut = todayExpenses.reduce(
      (sum, e) => sum.add(e.amount),
      new Prisma.Decimal(0)
    );

    // Cash exchanges fromMethod=BANKAK today
    const exchangeOut = todayExchanges
      .filter((e: any) => e.fromMethod === 'BANKAK')
      .reduce((sum: Prisma.Decimal, e: any) => sum.add(e.amount), new Prisma.Decimal(0));

    const totalOut = bankakOutTotal.add(procBankakOut).add(expensesBankakOut).add(exchangeOut);

    // ---- Closing ----
    const closing = opening.add(totalIn).sub(totalOut);

    // Combine all today's transactions for the response
    const transactions = [
      ...todayBankakIn.map((t) => ({
        id: t.id,
        type: 'BANKAK_IN' as const,
        amount: t.amount.toString(),
        description: t.description,
        referenceNumber: t.referenceNumber,
        customer: t.customer,
        creator: t.creator,
        date: t.createdAt,
      })),
      ...todayBankakOut.map((t) => ({
        id: t.id,
        type: 'BANKAK_OUT' as const,
        amount: t.amount.toString(),
        description: t.description,
        referenceNumber: t.referenceNumber,
        customer: t.customer,
        creator: t.creator,
        date: t.createdAt,
      })),
      ...todaySalesPayments.map((p) => ({
        id: p.id,
        type: 'SALES_PAYMENT' as const,
        amount: p.amount.toString(),
        description: 'دفعة مبيعات بنكك',
        referenceNumber: p.receiptNumber,
        customer: null,
        creator: null,
        date: p.paidAt,
      })),
      ...todayProcPayments.map((p) => ({
        id: p.id,
        type: 'PROC_PAYMENT' as const,
        amount: p.amount.toString(),
        description: 'دفعة مشتريات بنكك',
        referenceNumber: p.receiptNumber,
        customer: null,
        creator: null,
        date: p.paidAt,
      })),
      ...todayExpenses.map((e) => ({
        id: e.id,
        type: 'EXPENSE' as const,
        amount: e.amount.toString(),
        description: e.description,
        referenceNumber: null,
        customer: null,
        creator: null,
        date: e.createdAt,
      })),
      ...todayExchanges
        .filter((e: any) => e.toMethod === 'BANKAK' || e.fromMethod === 'BANKAK')
        .map((e: any) => ({
          id: e.id,
          type: e.toMethod === 'BANKAK' ? ('EXCHANGE_IN' as const) : ('EXCHANGE_OUT' as const),
          amount: e.amount.toString(),
          description: `تحويل ${e.fromMethod === 'BANKAK' ? 'من' : 'إلى'} بنكك`,
          referenceNumber: e.receiptNumber,
          customer: null,
          creator: null,
          date: e.createdAt,
        })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    res.json({
      date: startOfDay.toISOString().split('T')[0],
      opening: opening.toFixed(2),
      totalIn: totalIn.toFixed(2),
      totalOut: totalOut.toFixed(2),
      closing: closing.toFixed(2),
      transactions,
    });
  } catch (error) {
    console.error('Daily bankak report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /bankak/search - Search by reference number across multiple tables
router.get('/search', async (req: AuthRequest, res) => {
  try {
    const ref = req.query.ref as string;

    if (!ref || ref.trim().length === 0) {
      return res.status(400).json({ error: 'رقم المرجع مطلوب' });
    }

    const refFilter = { contains: ref, mode: 'insensitive' as const };

    // Search bankak_transactions
    const bankakTransactions = await prisma.bankakTransaction.findMany({
      where: { referenceNumber: refFilter },
      include: {
        customer: true,
        creator: { select: { id: true, username: true } },
      },
    });

    // Search sales_payments where method=BANKAK and receiptNumber matches
    const salesPayments = await prisma.salesPayment.findMany({
      where: {
        method: 'BANKAK',
        receiptNumber: refFilter,
      },
      include: {
        invoice: {
          include: { customer: true },
        },
        recordedByUser: { select: { id: true, username: true } },
      },
    });

    // Search proc_order_payments where method=BANKAK and receiptNumber matches
    const procPayments = await prisma.procOrderPayment.findMany({
      where: {
        method: 'BANKAK',
        receiptNumber: refFilter,
      },
      include: {
        order: {
          include: { supplier: true },
        },
        recordedByUser: { select: { id: true, username: true } },
      },
    });

    // Search cash_exchanges where fromMethod=BANKAK or toMethod=BANKAK and receiptNumber matches
    const cashExchanges = await (prisma as any).cashExchange.findMany({
      where: {
        receiptNumber: refFilter,
        OR: [{ fromMethod: 'BANKAK' }, { toMethod: 'BANKAK' }],
      },
      include: {
        createdByUser: { select: { id: true, username: true } },
      },
    });

    // Combine and normalize results
    const results = [
      ...bankakTransactions.map((t) => ({
        id: t.id,
        type: 'BANKAK_TRANSACTION' as const,
        amount: t.amount.toString(),
        direction: t.direction,
        referenceNumber: t.referenceNumber,
        description: t.description,
        customer: t.customer,
        user: t.creator,
        date: t.createdAt,
      })),
      ...salesPayments.map((p) => ({
        id: p.id,
        type: 'SALES_PAYMENT' as const,
        amount: p.amount.toString(),
        direction: 'IN' as const,
        referenceNumber: p.receiptNumber,
        description: `دفعة مبيعات - فاتورة ${p.invoiceId}`,
        customer: p.invoice?.customer || null,
        user: p.recordedByUser,
        date: p.paidAt,
      })),
      ...procPayments.map((p) => ({
        id: p.id,
        type: 'PROC_PAYMENT' as const,
        amount: p.amount.toString(),
        direction: 'OUT' as const,
        referenceNumber: p.receiptNumber,
        description: `دفعة مشتريات - طلب ${p.orderId}`,
        customer: null,
        user: p.recordedByUser,
        date: p.paidAt,
      })),
      ...cashExchanges.map((e: any) => ({
        id: e.id,
        type: 'CASH_EXCHANGE' as const,
        amount: e.amount.toString(),
        direction: e.toMethod === 'BANKAK' ? ('IN' as const) : ('OUT' as const),
        referenceNumber: e.receiptNumber,
        description: `تحويل من ${e.fromMethod} إلى ${e.toMethod}`,
        customer: null,
        user: e.createdByUser,
        date: e.createdAt,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({ results, total: results.length });
  } catch (error) {
    console.error('Search bankak reference error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
