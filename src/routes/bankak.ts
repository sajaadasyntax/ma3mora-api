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

    const METHOD = 'BANKAK' as const;

    // ---- Opening Balance ----
    // Sum ALL CASHBOX opening balances for BANKAK (not just findFirst)
    const openingBalanceRecords = await prisma.openingBalance.findMany({
      where: {
        scope: 'CASHBOX',
        paymentMethod: METHOD,
        isClosed: false,
      },
    });
    let opening = openingBalanceRecords.reduce(
      (sum, ob) => sum.add(ob.amount), new Prisma.Decimal(0)
    );

    // Add all transactions before the target date to compute the actual opening
    const preDayBankakTxns = await prisma.bankakTransaction.findMany({
      where: { createdAt: { lt: startOfDay } },
    });
    preDayBankakTxns.forEach((t) => {
      if (t.direction === 'IN') opening = opening.add(t.amount);
      else opening = opening.sub(t.amount);
    });

    const preDaySalesPayments = await prisma.salesPayment.findMany({
      where: { paidAt: { lt: startOfDay }, method: METHOD, invoice: { paymentConfirmationStatus: 'CONFIRMED' } },
    });
    preDaySalesPayments.forEach((p) => { opening = opening.add(p.amount); });

    const preDayCustomerPayments = await prisma.customerPayment.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD },
    });
    preDayCustomerPayments.forEach((p) => { opening = opening.add(p.amount); });

    const preDayExchanges = await (prisma as any).cashExchange.findMany({
      where: { createdAt: { lt: startOfDay } },
    });
    preDayExchanges.forEach((e: any) => {
      if (e.toMethod === METHOD) opening = opening.add(e.amount);
      if (e.fromMethod === METHOD) opening = opening.sub(e.amount);
    });

    const preDayProcPayments = await prisma.procOrderPayment.findMany({
      where: { paidAt: { lt: startOfDay }, method: METHOD, order: { paymentConfirmed: true, status: { not: 'CANCELLED' } } },
    });
    preDayProcPayments.forEach((p) => { opening = opening.sub(p.amount); });

    const preDayExpenses = await prisma.expense.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD, isDebt: false },
    });
    preDayExpenses.forEach((e) => { opening = opening.sub(e.amount); });

    const preDaySalaries = await prisma.salary.findMany({
      where: { paidAt: { lt: startOfDay, not: null }, paymentMethod: METHOD },
    });
    preDaySalaries.forEach((s) => { opening = opening.sub(s.netAmount); });

    const preDayAdvances = await prisma.advance.findMany({
      where: { paidAt: { lt: startOfDay, not: null }, paymentMethod: METHOD },
    });
    preDayAdvances.forEach((a) => { opening = opening.sub(a.amount); });

    const preDayIncomes = await prisma.income.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD as any, isDebt: false },
    });
    preDayIncomes.forEach((i) => { opening = opening.add(i.amount); });

    const preDaySalesReturns = await prisma.salesReturn.findMany({
      where: { returnedAt: { lt: startOfDay }, invoice: { paymentMethod: METHOD as any } },
      include: { items: { select: { lineTotal: true } } },
    });
    preDaySalesReturns.forEach((sr) => {
      const total = sr.items.reduce((sum, it) => sum.add(it.lineTotal), new Prisma.Decimal(0));
      opening = opening.sub(total);
    });

    // Pre-day sales deposits with method=BANKAK
    const preDaySalesDeposits = await (prisma as any).salesDeposit.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD },
    });
    preDaySalesDeposits.forEach((d: any) => { opening = opening.add(d.amount); });

    // Pre-day treasury transactions with method=BANKAK
    const preDayTreasuryTxns = await prisma.treasuryTransaction.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD },
    });
    preDayTreasuryTxns.forEach((t) => {
      if (t.type === 'CASH_IN') opening = opening.add(t.amount);
      else if (t.type === 'CASH_OUT') opening = opening.sub(t.amount);
    });

    // ---- Today's IN ----
    const todayBankakIn = await prisma.bankakTransaction.findMany({
      where: { direction: 'IN', createdAt: { gte: startOfDay, lte: endOfDay } },
      include: { customer: true, creator: { select: { id: true, username: true } } },
    });
    const bankakInTotal = todayBankakIn.reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const todaySalesPayments = await prisma.salesPayment.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay }, method: METHOD, invoice: { paymentConfirmationStatus: 'CONFIRMED' } },
    });
    const salesBankakIn = todaySalesPayments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const todayCustomerPayments = await prisma.customerPayment.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD },
      include: { customer: true, recordedByUser: { select: { id: true, username: true } } },
    });
    const customerBankakIn = todayCustomerPayments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const todayIncomes = await prisma.income.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD as any, isDebt: false },
      include: { creator: { select: { id: true, username: true } } },
    });
    const incomeBankakIn = todayIncomes.reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0));

    const todayExchanges = await (prisma as any).cashExchange.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay } },
    });
    const exchangeIn = todayExchanges
      .filter((e: any) => e.toMethod === METHOD)
      .reduce((sum: Prisma.Decimal, e: any) => sum.add(e.amount), new Prisma.Decimal(0));

    const totalIn = bankakInTotal.add(salesBankakIn).add(customerBankakIn).add(incomeBankakIn).add(exchangeIn);

    // ---- Today's OUT ----
    const todayBankakOut = await prisma.bankakTransaction.findMany({
      where: { direction: 'OUT', createdAt: { gte: startOfDay, lte: endOfDay } },
      include: { customer: true, creator: { select: { id: true, username: true } } },
    });
    const bankakOutTotal = todayBankakOut.reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const todayProcPayments = await prisma.procOrderPayment.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay }, method: METHOD, order: { paymentConfirmed: true, status: { not: 'CANCELLED' } } },
    });
    const procBankakOut = todayProcPayments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const todayExpenses = await prisma.expense.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD, isDebt: false },
    });
    const expensesBankakOut = todayExpenses.reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const todaySalaries = await prisma.salary.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay, not: null }, paymentMethod: METHOD },
      include: { employee: true, creator: { select: { id: true, username: true } } },
    });
    const salariesBankakOut = todaySalaries.reduce((sum, s) => sum.add(s.netAmount), new Prisma.Decimal(0));

    const todayAdvances = await prisma.advance.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay, not: null }, paymentMethod: METHOD },
      include: { employee: true, creator: { select: { id: true, username: true } } },
    });
    const advancesBankakOut = todayAdvances.reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    const todaySalesReturns = await prisma.salesReturn.findMany({
      where: { returnedAt: { gte: startOfDay, lte: endOfDay }, invoice: { paymentMethod: METHOD as any } },
      include: {
        invoice: { select: { invoiceNumber: true, customer: { select: { name: true } } } },
        items: { select: { lineTotal: true } },
        returnedByUser: { select: { id: true, username: true } },
      },
    });
    const salesReturnsBankakOut = todaySalesReturns.reduce(
      (sum, sr) => sum.add(sr.items.reduce((s, it) => s.add(it.lineTotal), new Prisma.Decimal(0))),
      new Prisma.Decimal(0)
    );

    const exchangeOut = todayExchanges
      .filter((e: any) => e.fromMethod === METHOD)
      .reduce((sum: Prisma.Decimal, e: any) => sum.add(e.amount), new Prisma.Decimal(0));

    // Today's sales deposits with method=BANKAK
    const todaySalesDeposits = await (prisma as any).salesDeposit.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD },
      include: { customer: true, creator: { select: { id: true, username: true } } },
    });
    const depositsBankakIn = todaySalesDeposits.reduce(
      (sum: Prisma.Decimal, d: any) => sum.add(d.amount), new Prisma.Decimal(0)
    );

    // Today's treasury transactions with method=BANKAK
    const todayTreasuryTxns = await prisma.treasuryTransaction.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD },
      include: { customer: true, supplier: true, creator: { select: { id: true, username: true } } },
    });
    const treasuryBankakIn = todayTreasuryTxns
      .filter(t => t.type === 'CASH_IN')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));
    const treasuryBankakOut = todayTreasuryTxns
      .filter(t => t.type === 'CASH_OUT')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    // OB entries for display only (not added to totals — they are receivables/payables, not cash)
    const todayOBBankak = await prisma.openingBalance.findMany({
      where: { scope: { in: ['CUSTOMER', 'SUPPLIER'] }, paymentMethod: METHOD, isClosed: false, openedAt: { gte: startOfDay, lte: endOfDay } },
      include: { customer: true, supplier: true },
    });

    const totalOut = bankakOutTotal.add(procBankakOut).add(expensesBankakOut).add(salariesBankakOut).add(advancesBankakOut).add(salesReturnsBankakOut).add(exchangeOut).add(treasuryBankakOut);

    // ---- Closing ----
    const closing = opening.add(totalIn).add(depositsBankakIn).add(treasuryBankakIn).sub(totalOut);

    const transactions = [
      ...todayBankakIn.map((t) => ({
        id: t.id, type: 'BANKAK_IN' as const, amount: t.amount.toString(),
        description: t.description, referenceNumber: t.referenceNumber,
        customer: t.customer, creator: t.creator, date: t.createdAt,
      })),
      ...todayBankakOut.map((t) => ({
        id: t.id, type: 'BANKAK_OUT' as const, amount: t.amount.toString(),
        description: t.description, referenceNumber: t.referenceNumber,
        customer: t.customer, creator: t.creator, date: t.createdAt,
      })),
      ...todaySalesPayments.map((p) => ({
        id: p.id, type: 'SALES_PAYMENT' as const, amount: p.amount.toString(),
        description: 'دفعة مبيعات بنكك', referenceNumber: p.receiptNumber,
        customer: null, creator: null, date: p.paidAt,
      })),
      ...todayCustomerPayments.map((p) => ({
        id: p.id, type: 'CUSTOMER_PAYMENT' as const, amount: p.amount.toString(),
        description: p.notes || 'دفعة عميل بنكك', referenceNumber: p.referenceNumber,
        customer: p.customer, creator: p.recordedByUser, date: p.createdAt,
      })),
      ...todayIncomes.map((i) => ({
        id: i.id, type: 'INCOME' as const, amount: i.amount.toString(),
        description: (i as any).description || 'إيراد بنكك', referenceNumber: null,
        customer: null, creator: (i as any).creator, date: i.createdAt,
      })),
      ...todayProcPayments.map((p) => ({
        id: p.id, type: 'PROC_PAYMENT' as const, amount: p.amount.toString(),
        description: 'دفعة مشتريات بنكك', referenceNumber: p.receiptNumber,
        customer: null, creator: null, date: p.paidAt,
      })),
      ...todayExpenses.map((e) => ({
        id: e.id, type: 'EXPENSE' as const, amount: e.amount.toString(),
        description: e.description, referenceNumber: null,
        customer: null, creator: null, date: e.createdAt,
      })),
      ...todaySalaries.map((s) => ({
        id: s.id, type: 'SALARY' as const, amount: s.netAmount.toString(),
        description: `راتب - ${s.employee?.name || 'غير محدد'}`, referenceNumber: null,
        customer: null, creator: s.creator, date: s.paidAt || s.createdAt,
      })),
      ...todayAdvances.map((a) => ({
        id: a.id, type: 'ADVANCE' as const, amount: a.amount.toString(),
        description: `سلفية - ${a.employee?.name || 'غير محدد'}`, referenceNumber: null,
        customer: null, creator: a.creator, date: a.paidAt || a.createdAt,
      })),
      ...todaySalesReturns.map((sr) => {
        const total = sr.items.reduce((sum, it) => sum.add(it.lineTotal), new Prisma.Decimal(0));
        return {
          id: sr.id, type: 'SALES_RETURN' as const, amount: total.toString(),
          description: `مرتجع - فاتورة ${sr.invoice.invoiceNumber || ''}`,
          referenceNumber: null, customer: null,
          creator: sr.returnedByUser, date: sr.returnedAt,
        };
      }),
      ...todayExchanges
        .filter((e: any) => e.toMethod === METHOD || e.fromMethod === METHOD)
        .map((e: any) => ({
          id: e.id,
          type: e.toMethod === METHOD ? ('EXCHANGE_IN' as const) : ('EXCHANGE_OUT' as const),
          amount: e.amount.toString(),
          description: `تحويل ${e.fromMethod === METHOD ? 'من' : 'إلى'} بنكك`,
          referenceNumber: e.receiptNumber, customer: null, creator: null, date: e.createdAt,
        })),
      ...todaySalesDeposits.map((d: any) => ({
        id: d.id, type: 'DEPOSIT' as const, amount: d.amount.toString(),
        description: `عربون عميل: ${d.customer?.name || ''}`,
        referenceNumber: null, customer: d.customer || null, creator: d.creator || null, date: d.createdAt,
      })),
      ...todayTreasuryTxns.map((t) => ({
        id: t.id,
        type: t.type === 'CASH_IN' ? ('TREASURY_IN' as const) : ('TREASURY_OUT' as const),
        direction: t.type === 'CASH_IN' ? 'IN' : 'OUT',
        amount: t.amount.toString(),
        description: t.description,
        referenceNumber: t.referenceNumber, customer: t.customer || null, creator: t.creator, date: t.createdAt,
      })),
      ...todayOBBankak.map((ob: any) => {
        const amt = new Prisma.Decimal(ob.amount);
        const name = ob.customer?.name || ob.supplier?.name || '';
        const scopeLabel = ob.scope === 'CUSTOMER' ? 'عميل' : 'مورد';
        return {
          id: ob.id,
          type: 'OB_NOTE' as const,
          direction: amt.greaterThan(0) ? 'INFO' : 'INFO',
          amount: amt.abs().toString(),
          description: `رصيد افتتاحي ${scopeLabel}: ${name} (ذمم — لا يؤثر على الرصيد)`,
          referenceNumber: ob.receiptNumber || null, customer: ob.customer || null, creator: null, date: ob.openedAt,
        };
      }),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    res.json({
      date: startOfDay.toISOString().split('T')[0],
      opening: opening.toFixed(2),
      totalIn: totalIn.add(depositsBankakIn).add(treasuryBankakIn).toFixed(2),
      totalOut: totalOut.toFixed(2),
      closing: closing.toFixed(2),
      transactions,
    });
  } catch (error) {
    console.error('Daily bankak report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /bankak/nile-daily - Daily Bank Nile Movement Report
router.get('/nile-daily', async (req: AuthRequest, res) => {
  try {
    const dateParam = req.query.date as string | undefined;
    const targetDate = dateParam ? new Date(dateParam) : new Date();

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const METHOD = 'BANK_NILE' as const;

    // ---- Opening Balance ----
    // Sum ALL CASHBOX opening balances for BANK_NILE (not just findFirst)
    const openingBalanceRecords = await prisma.openingBalance.findMany({
      where: { scope: 'CASHBOX', paymentMethod: METHOD, isClosed: false },
    });
    let opening = openingBalanceRecords.reduce(
      (sum, ob) => sum.add(ob.amount), new Prisma.Decimal(0)
    );

    const preDaySalesPayments = await prisma.salesPayment.findMany({
      where: { paidAt: { lt: startOfDay }, method: METHOD, invoice: { paymentConfirmationStatus: 'CONFIRMED' } },
    });
    preDaySalesPayments.forEach((p) => { opening = opening.add(p.amount); });

    const preDayCustomerPayments = await prisma.customerPayment.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD },
    });
    preDayCustomerPayments.forEach((p) => { opening = opening.add(p.amount); });

    const preDayExchanges = await (prisma as any).cashExchange.findMany({
      where: { createdAt: { lt: startOfDay } },
    });
    preDayExchanges.forEach((e: any) => {
      if (e.toMethod === METHOD) opening = opening.add(e.amount);
      if (e.fromMethod === METHOD) opening = opening.sub(e.amount);
    });

    const preDayProcPayments = await prisma.procOrderPayment.findMany({
      where: { paidAt: { lt: startOfDay }, method: METHOD, order: { paymentConfirmed: true, status: { not: 'CANCELLED' } } },
    });
    preDayProcPayments.forEach((p) => { opening = opening.sub(p.amount); });

    const preDayExpenses = await prisma.expense.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD, isDebt: false },
    });
    preDayExpenses.forEach((e) => { opening = opening.sub(e.amount); });

    const preDaySalaries = await prisma.salary.findMany({
      where: { paidAt: { lt: startOfDay, not: null }, paymentMethod: METHOD },
    });
    preDaySalaries.forEach((s) => { opening = opening.sub(s.netAmount); });

    const preDayAdvances = await prisma.advance.findMany({
      where: { paidAt: { lt: startOfDay, not: null }, paymentMethod: METHOD },
    });
    preDayAdvances.forEach((a) => { opening = opening.sub(a.amount); });

    const preDayIncomes = await prisma.income.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD as any, isDebt: false },
    });
    preDayIncomes.forEach((i) => { opening = opening.add(i.amount); });

    const preDaySalesReturns = await prisma.salesReturn.findMany({
      where: { returnedAt: { lt: startOfDay }, invoice: { paymentMethod: METHOD as any } },
      include: { items: { select: { lineTotal: true } } },
    });
    preDaySalesReturns.forEach((sr) => {
      const total = sr.items.reduce((sum, it) => sum.add(it.lineTotal), new Prisma.Decimal(0));
      opening = opening.sub(total);
    });

    // Pre-day sales deposits with method=BANK_NILE
    const preDaySalesDeposits = await (prisma as any).salesDeposit.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD },
    });
    preDaySalesDeposits.forEach((d: any) => { opening = opening.add(d.amount); });

    // Pre-day treasury transactions with method=BANK_NILE
    const preDayTreasuryTxns = await prisma.treasuryTransaction.findMany({
      where: { createdAt: { lt: startOfDay }, method: METHOD },
    });
    preDayTreasuryTxns.forEach((t) => {
      if (t.type === 'CASH_IN') opening = opening.add(t.amount);
      else if (t.type === 'CASH_OUT') opening = opening.sub(t.amount);
    });

    // ---- Today's IN ----
    const todaySalesPayments = await prisma.salesPayment.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay }, method: METHOD, invoice: { paymentConfirmationStatus: 'CONFIRMED' } },
      include: { invoice: { include: { customer: true } } },
    });
    const salesNileIn = todaySalesPayments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const todayCustomerPayments = await prisma.customerPayment.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD },
      include: { customer: true, recordedByUser: { select: { id: true, username: true } } },
    });
    const customerNileIn = todayCustomerPayments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const todayIncomes = await prisma.income.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD as any, isDebt: false },
      include: { creator: { select: { id: true, username: true } } },
    });
    const incomeNileIn = todayIncomes.reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0));

    const todayExchanges = await (prisma as any).cashExchange.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay } },
    });
    const exchangeIn = todayExchanges
      .filter((e: any) => e.toMethod === METHOD)
      .reduce((sum: Prisma.Decimal, e: any) => sum.add(e.amount), new Prisma.Decimal(0));

    const totalIn = salesNileIn.add(customerNileIn).add(incomeNileIn).add(exchangeIn);

    // ---- Today's OUT ----
    const todayProcPayments = await prisma.procOrderPayment.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay }, method: METHOD, order: { paymentConfirmed: true, status: { not: 'CANCELLED' } } },
    });
    const procNileOut = todayProcPayments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0));

    const todayExpenses = await prisma.expense.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD, isDebt: false },
    });
    const expensesNileOut = todayExpenses.reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));

    const todaySalaries = await prisma.salary.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay, not: null }, paymentMethod: METHOD },
      include: { employee: true, creator: { select: { id: true, username: true } } },
    });
    const salariesNileOut = todaySalaries.reduce((sum, s) => sum.add(s.netAmount), new Prisma.Decimal(0));

    const todayAdvances = await prisma.advance.findMany({
      where: { paidAt: { gte: startOfDay, lte: endOfDay, not: null }, paymentMethod: METHOD },
      include: { employee: true, creator: { select: { id: true, username: true } } },
    });
    const advancesNileOut = todayAdvances.reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));

    const todaySalesReturns = await prisma.salesReturn.findMany({
      where: { returnedAt: { gte: startOfDay, lte: endOfDay }, invoice: { paymentMethod: METHOD as any } },
      include: {
        invoice: { select: { invoiceNumber: true, customer: { select: { name: true } } } },
        items: { select: { lineTotal: true } },
        returnedByUser: { select: { id: true, username: true } },
      },
    });
    const salesReturnsNileOut = todaySalesReturns.reduce(
      (sum, sr) => sum.add(sr.items.reduce((s, it) => s.add(it.lineTotal), new Prisma.Decimal(0))),
      new Prisma.Decimal(0)
    );

    const exchangeOut = todayExchanges
      .filter((e: any) => e.fromMethod === METHOD)
      .reduce((sum: Prisma.Decimal, e: any) => sum.add(e.amount), new Prisma.Decimal(0));

    // Today's sales deposits with method=BANK_NILE
    const todaySalesDeposits = await (prisma as any).salesDeposit.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD },
      include: { customer: true, creator: { select: { id: true, username: true } } },
    });
    const depositsNileIn = todaySalesDeposits.reduce(
      (sum: Prisma.Decimal, d: any) => sum.add(d.amount), new Prisma.Decimal(0)
    );

    // Today's treasury transactions with method=BANK_NILE
    const todayTreasuryTxns = await prisma.treasuryTransaction.findMany({
      where: { createdAt: { gte: startOfDay, lte: endOfDay }, method: METHOD },
      include: { customer: true, supplier: true, creator: { select: { id: true, username: true } } },
    });
    const treasuryNileIn = todayTreasuryTxns
      .filter(t => t.type === 'CASH_IN')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));
    const treasuryNileOut = todayTreasuryTxns
      .filter(t => t.type === 'CASH_OUT')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    // OB entries for display only (not added to totals)
    const todayOBNile = await prisma.openingBalance.findMany({
      where: { scope: { in: ['CUSTOMER', 'SUPPLIER'] }, paymentMethod: METHOD, isClosed: false, openedAt: { gte: startOfDay, lte: endOfDay } },
      include: { customer: true, supplier: true },
    });

    const totalOut = procNileOut.add(expensesNileOut).add(salariesNileOut).add(advancesNileOut).add(salesReturnsNileOut).add(exchangeOut).add(treasuryNileOut);

    // ---- Closing ----
    const closing = opening.add(totalIn).add(depositsNileIn).add(treasuryNileIn).sub(totalOut);

    const transactions = [
      ...todaySalesPayments.map((p) => ({
        id: p.id, type: 'SALES_PAYMENT' as const, amount: p.amount.toString(),
        description: 'دفعة مبيعات بنك النيل', referenceNumber: p.receiptNumber,
        customer: p.invoice?.customer || null, creator: null, date: p.paidAt,
      })),
      ...todayCustomerPayments.map((p) => ({
        id: p.id, type: 'CUSTOMER_PAYMENT' as const, amount: p.amount.toString(),
        description: p.notes || 'دفعة عميل بنك النيل', referenceNumber: p.referenceNumber,
        customer: p.customer, creator: p.recordedByUser, date: p.createdAt,
      })),
      ...todayIncomes.map((i) => ({
        id: i.id, type: 'INCOME' as const, amount: i.amount.toString(),
        description: (i as any).description || 'إيراد بنك النيل', referenceNumber: null,
        customer: null, creator: (i as any).creator, date: i.createdAt,
      })),
      ...todayProcPayments.map((p) => ({
        id: p.id, type: 'PROC_PAYMENT' as const, amount: p.amount.toString(),
        description: 'دفعة مشتريات بنك النيل', referenceNumber: p.receiptNumber,
        customer: null, creator: null, date: p.paidAt,
      })),
      ...todayExpenses.map((e) => ({
        id: e.id, type: 'EXPENSE' as const, amount: e.amount.toString(),
        description: e.description, referenceNumber: null,
        customer: null, creator: null, date: e.createdAt,
      })),
      ...todaySalaries.map((s) => ({
        id: s.id, type: 'SALARY' as const, amount: s.netAmount.toString(),
        description: `راتب - ${s.employee?.name || 'غير محدد'}`, referenceNumber: null,
        customer: null, creator: s.creator, date: s.paidAt || s.createdAt,
      })),
      ...todayAdvances.map((a) => ({
        id: a.id, type: 'ADVANCE' as const, amount: a.amount.toString(),
        description: `سلفية - ${a.employee?.name || 'غير محدد'}`, referenceNumber: null,
        customer: null, creator: a.creator, date: a.paidAt || a.createdAt,
      })),
      ...todaySalesReturns.map((sr) => {
        const total = sr.items.reduce((sum, it) => sum.add(it.lineTotal), new Prisma.Decimal(0));
        return {
          id: sr.id, type: 'SALES_RETURN' as const, amount: total.toString(),
          description: `مرتجع - فاتورة ${sr.invoice.invoiceNumber || ''}`,
          referenceNumber: null, customer: null,
          creator: sr.returnedByUser, date: sr.returnedAt,
        };
      }),
      ...todayExchanges
        .filter((e: any) => e.toMethod === METHOD || e.fromMethod === METHOD)
        .map((e: any) => ({
          id: e.id,
          type: e.toMethod === METHOD ? ('EXCHANGE_IN' as const) : ('EXCHANGE_OUT' as const),
          amount: e.amount.toString(),
          description: `تحويل ${e.fromMethod === METHOD ? 'من' : 'إلى'} بنك النيل`,
          referenceNumber: e.receiptNumber, customer: null, creator: null, date: e.createdAt,
        })),
      ...todaySalesDeposits.map((d: any) => ({
        id: d.id, type: 'DEPOSIT' as const, amount: d.amount.toString(),
        description: `عربون عميل: ${d.customer?.name || ''}`,
        referenceNumber: null, customer: d.customer || null, creator: d.creator || null, date: d.createdAt,
      })),
      ...todayTreasuryTxns.map((t) => ({
        id: t.id,
        type: t.type === 'CASH_IN' ? ('TREASURY_IN' as const) : ('TREASURY_OUT' as const),
        direction: t.type === 'CASH_IN' ? 'IN' : 'OUT',
        amount: t.amount.toString(),
        description: t.description,
        referenceNumber: t.referenceNumber, customer: t.customer || null, creator: t.creator, date: t.createdAt,
      })),
      ...todayOBNile.map((ob: any) => {
        const amt = new Prisma.Decimal(ob.amount);
        const name = ob.customer?.name || ob.supplier?.name || '';
        const scopeLabel = ob.scope === 'CUSTOMER' ? 'عميل' : 'مورد';
        return {
          id: ob.id,
          type: 'OB_NOTE' as const,
          direction: 'INFO',
          amount: amt.abs().toString(),
          description: `رصيد افتتاحي ${scopeLabel}: ${name} (ذمم — لا يؤثر على الرصيد)`,
          referenceNumber: ob.receiptNumber || null, customer: ob.customer || null, creator: null, date: ob.openedAt,
        };
      }),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    res.json({
      date: startOfDay.toISOString().split('T')[0],
      opening: opening.toFixed(2),
      totalIn: totalIn.add(depositsNileIn).add(treasuryNileIn).toFixed(2),
      totalOut: totalOut.toFixed(2),
      closing: closing.toFixed(2),
      transactions,
    });
  } catch (error) {
    console.error('Daily bank nile report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /bankak/nile-transactions - List all BANK_NILE transactions with search and totals
router.get('/nile-transactions', async (req: AuthRequest, res) => {
  try {
    const { dateFrom, dateTo, referenceNumber } = req.query;
    const METHOD = 'BANK_NILE' as const;

    const dateFilter = (field: string) => {
      const filter: any = {};
      if (dateFrom || dateTo) {
        filter[field] = {};
        if (dateFrom) {
          filter[field].gte = new Date(dateFrom as string);
        }
        if (dateTo) {
          const to = new Date(dateTo as string);
          to.setHours(23, 59, 59, 999);
          filter[field].lte = to;
        }
      }
      return filter;
    };

    const refFilter = referenceNumber
      ? { contains: referenceNumber as string, mode: 'insensitive' as const }
      : undefined;

    // Sales payments with BANK_NILE
    const salesPayments = await prisma.salesPayment.findMany({
      where: {
        method: METHOD,
        ...dateFilter('paidAt'),
        ...(refFilter ? { receiptNumber: refFilter } : {}),
      },
      include: {
        invoice: { include: { customer: true } },
        recordedByUser: { select: { id: true, username: true } },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Customer payments with BANK_NILE
    const customerPayments = await prisma.customerPayment.findMany({
      where: {
        method: METHOD,
        ...dateFilter('createdAt'),
        ...(refFilter ? { referenceNumber: refFilter } : {}),
      },
      include: {
        customer: true,
        recordedByUser: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Procurement payments with BANK_NILE
    const procPayments = await prisma.procOrderPayment.findMany({
      where: {
        method: METHOD,
        ...dateFilter('paidAt'),
        ...(refFilter ? { receiptNumber: refFilter } : {}),
      },
      include: {
        order: { include: { supplier: true } },
        recordedByUser: { select: { id: true, username: true } },
      },
      orderBy: { paidAt: 'desc' },
    });

    // Expenses with BANK_NILE
    const expenses = await prisma.expense.findMany({
      where: {
        method: METHOD,
        ...dateFilter('createdAt'),
      },
      include: {
        creator: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Cash exchanges involving BANK_NILE
    const cashExchanges = await (prisma as any).cashExchange.findMany({
      where: {
        ...dateFilter('createdAt'),
        OR: [{ fromMethod: METHOD }, { toMethod: METHOD }],
        ...(refFilter ? { receiptNumber: refFilter } : {}),
      },
      include: {
        createdByUser: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Normalize all into a unified list
    const results = [
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
      ...customerPayments.map((p) => ({
        id: p.id,
        type: 'CUSTOMER_PAYMENT' as const,
        amount: p.amount.toString(),
        direction: 'IN' as const,
        referenceNumber: p.referenceNumber,
        description: p.notes || 'دفعة عميل بنك النيل',
        customer: p.customer,
        user: p.recordedByUser,
        date: p.createdAt,
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
      ...expenses.map((e) => ({
        id: e.id,
        type: 'EXPENSE' as const,
        amount: e.amount.toString(),
        direction: 'OUT' as const,
        referenceNumber: null,
        description: e.description,
        customer: null,
        user: e.creator,
        date: e.createdAt,
      })),
      ...cashExchanges.map((e: any) => ({
        id: e.id,
        type: 'CASH_EXCHANGE' as const,
        amount: e.amount.toString(),
        direction: e.toMethod === METHOD ? ('IN' as const) : ('OUT' as const),
        referenceNumber: e.receiptNumber,
        description: `تحويل من ${e.fromMethod} إلى ${e.toMethod}`,
        customer: null,
        user: e.createdByUser,
        date: e.createdAt,
      })),
    ];

    // Opening balances with BANK_NILE
    const obNile = await prisma.openingBalance.findMany({
      where: {
        scope: { in: ['CUSTOMER', 'SUPPLIER'] },
        paymentMethod: METHOD,
        isClosed: false,
        ...dateFilter('openedAt'),
        ...(refFilter ? { receiptNumber: refFilter } : {}),
      },
      include: { customer: true, supplier: true },
    });
    obNile.forEach((ob: any) => {
      const amt = new Prisma.Decimal(ob.amount);
      const name = ob.customer?.name || ob.supplier?.name || '';
      const scopeLabel = ob.scope === 'CUSTOMER' ? 'عميل' : 'مورد';
      results.push({
        id: ob.id,
        type: amt.greaterThan(0) ? ('OB_IN' as const) : ('OB_OUT' as const),
        amount: amt.abs().toString(),
        direction: amt.greaterThan(0) ? ('IN' as const) : ('OUT' as const),
        referenceNumber: ob.receiptNumber || null,
        description: `رصيد افتتاحي ${scopeLabel}: ${name}`,
        customer: ob.customer || null,
        user: null,
        date: ob.openedAt,
      });
    });

    results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const totalIn = results
      .filter((r) => r.direction === 'IN')
      .reduce((sum, r) => sum.add(new Prisma.Decimal(r.amount)), new Prisma.Decimal(0));

    const totalOut = results
      .filter((r) => r.direction === 'OUT')
      .reduce((sum, r) => sum.add(new Prisma.Decimal(r.amount)), new Prisma.Decimal(0));

    const net = totalIn.sub(totalOut);

    res.json({
      transactions: results,
      grandTotal: {
        totalIn: totalIn.toFixed(2),
        totalOut: totalOut.toFixed(2),
        net: net.toFixed(2),
      },
    });
  } catch (error) {
    console.error('List bank nile transactions error:', error);
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
    ];

    // Search opening balances with BANKAK and matching receipt number
    const obBankakSearch = await (prisma.openingBalance as any).findMany({
      where: {
        scope: { in: ['CUSTOMER', 'SUPPLIER'] },
        paymentMethod: 'BANKAK',
        isClosed: false,
        receiptNumber: refFilter,
      },
      include: { customer: true, supplier: true },
    });
    obBankakSearch.forEach((ob: any) => {
      const amt = new Prisma.Decimal(ob.amount);
      const name = ob.customer?.name || ob.supplier?.name || '';
      const scopeLabel = ob.scope === 'CUSTOMER' ? 'عميل' : 'مورد';
      results.push({
        id: ob.id,
        type: amt.greaterThan(0) ? ('OB_IN' as const) : ('OB_OUT' as const),
        amount: amt.abs().toString(),
        direction: amt.greaterThan(0) ? ('IN' as const) : ('OUT' as const),
        referenceNumber: ob.receiptNumber || null,
        description: `رصيد افتتاحي ${scopeLabel}: ${name}`,
        customer: ob.customer || null,
        user: null,
        date: ob.openedAt,
      });
    });

    results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({ results, total: results.length });
  } catch (error) {
    console.error('Search bankak reference error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
