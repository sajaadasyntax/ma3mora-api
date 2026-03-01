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

// ─── Schemas ────────────────────────────────────────────────────────────────

const createCustomerPaymentSchema = z.object({
  customerId: z.string().min(1),
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS']),
  referenceNumber: z.string().optional(),
  receiptUrl: z.string().optional(),
  notes: z.string().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMethodField(method: string): string {
  switch (method) {
    case 'CASH': return 'salesCash';
    case 'BANKAK': return 'salesBank';
    case 'BANK_NILE': return 'salesBankNile';
    case 'DEBT': return 'salesDebtMethod';
    case 'COMMISSION':
    case 'OTHERS':
    default: return 'salesOthers';
  }
}

// ─── POST /customer-payments — Account-based payment ────────────────────────

router.post(
  '/',
  requireRole('ACCOUNTANT', 'MANAGER', 'SALES_GROCERY', 'SALES_BAKERY'),
  createAuditLog('CustomerPayment'),
  async (req: AuthRequest, res) => {
    try {
      const data = createCustomerPaymentSchema.parse(req.body);

      // Verify customer exists
      const customer = await prisma.customer.findUnique({
        where: { id: data.customerId },
      });

      if (!customer) {
        return res.status(404).json({ error: 'العميل غير موجود' });
      }

      const amountDecimal = new Prisma.Decimal(data.amount);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Create payment and update aggregate in a transaction
      const payment = await prisma.$transaction(async (tx) => {
        // 1. Create the CustomerPayment record
        const newPayment = await tx.customerPayment.create({
          data: {
            customerId: data.customerId,
            amount: amountDecimal,
            method: data.method,
            referenceNumber: data.referenceNumber || null,
            receiptUrl: data.receiptUrl || null,
            notes: data.notes || null,
            recordedBy: req.user!.id,
          },
          include: {
            customer: true,
            recordedByUser: {
              select: { id: true, username: true },
            },
          },
        });

        // 2. Update CustomerCumulativeAggregate for today
        const previousAggregate = await tx.customerCumulativeAggregate.findFirst({
          where: {
            customerId: data.customerId,
            date: { lte: today },
          },
          orderBy: { date: 'desc' },
        });

        const totalInvoices = previousAggregate?.totalInvoices || 0;
        const totalSales = previousAggregate?.totalSales || new Prisma.Decimal(0);
        const totalPaid = (previousAggregate?.totalPaid || new Prisma.Decimal(0)).add(amountDecimal);
        const totalOutstanding = totalSales.sub(totalPaid);
        const totalAccountPayments = (previousAggregate?.totalAccountPayments || new Prisma.Decimal(0)).add(amountDecimal);

        const salesCash = previousAggregate?.salesCash || new Prisma.Decimal(0);
        const salesBank = previousAggregate?.salesBank || new Prisma.Decimal(0);
        const salesBankNile = previousAggregate?.salesBankNile || new Prisma.Decimal(0);
        const salesDebtMethod = previousAggregate?.salesDebtMethod || new Prisma.Decimal(0);
        const salesOthers = previousAggregate?.salesOthers || new Prisma.Decimal(0);

        // Increment the appropriate method field
        const methodField = getMethodField(data.method);
        const methodValues: Record<string, Prisma.Decimal> = {
          salesCash,
          salesBank,
          salesBankNile,
          salesDebtMethod,
          salesOthers,
        };
        methodValues[methodField] = methodValues[methodField].add(amountDecimal);

        await tx.customerCumulativeAggregate.upsert({
          where: {
            customerId_date: {
              customerId: data.customerId,
              date: today,
            },
          },
          update: {
            totalPaid,
            totalOutstanding,
            totalAccountPayments,
            ...methodValues,
          },
          create: {
            customerId: data.customerId,
            date: today,
            totalInvoices,
            totalSales,
            totalPaid,
            totalOutstanding,
            totalAccountPayments,
            ...methodValues,
          },
        });

        return newPayment;
      });

      try {
        await aggregationService.updateDailyFinancialAggregate(new Date(), {
          customerPaymentsTotal: new Prisma.Decimal(data.amount),
          customerPaymentsCount: 1,
        });
      } catch (aggError) {
        console.error('Aggregation update error:', aggError);
      }

      res.status(201).json(payment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Create customer payment error:', error);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  }
);

// ─── GET /customer-payments — List customer payments ────────────────────────

router.get('/', async (req: AuthRequest, res) => {
  try {
    const { customerId, dateFrom, dateTo, method } = req.query;

    const where: any = {};
    if (customerId) where.customerId = customerId as string;
    if (method) where.method = method as string;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    const payments = await prisma.customerPayment.findMany({
      where,
      include: {
        customer: true,
        recordedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate grand total
    const grandTotal = payments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0)
    );

    res.json({ payments, grandTotal: grandTotal.toString() });
  } catch (error) {
    console.error('List customer payments error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── GET /customers/:id/statement — Customer Statement of Account ───────────

router.get('/customers/:id/statement', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { dateFrom, dateTo } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'تاريخ البداية والنهاية مطلوبان' });
    }

    const from = new Date(dateFrom as string);
    from.setHours(0, 0, 0, 0);
    const to = new Date(dateTo as string);
    to.setHours(23, 59, 59, 999);

    // Verify customer exists
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, name: true, type: true, division: true, phone: true, address: true },
    });

    if (!customer) {
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    // ── Opening Balance Calculation ──
    // Total invoices before dateFrom
    const invoicesBefore = await prisma.salesInvoice.aggregate({
      where: {
        customerId: id,
        createdAt: { lt: from },
        paymentConfirmationStatus: { not: 'REJECTED' },
      },
      _sum: { total: true },
    });

    // Total SalesPayments before dateFrom
    const salesPaymentsBefore = await prisma.salesPayment.aggregate({
      where: {
        invoice: {
          customerId: id,
          paymentConfirmationStatus: { not: 'REJECTED' },
        },
        paidAt: { lt: from },
      },
      _sum: { amount: true },
    });

    // Total CustomerPayments before dateFrom
    const customerPaymentsBefore = await prisma.customerPayment.aggregate({
      where: {
        customerId: id,
        createdAt: { lt: from },
      },
      _sum: { amount: true },
    });

    const totalInvoicesBefore = invoicesBefore._sum.total || new Prisma.Decimal(0);
    const totalSalesPaymentsBefore = salesPaymentsBefore._sum.amount || new Prisma.Decimal(0);
    const totalCustomerPaymentsBefore = customerPaymentsBefore._sum.amount || new Prisma.Decimal(0);
    const openingBalance = totalInvoicesBefore.sub(totalSalesPaymentsBefore).sub(totalCustomerPaymentsBefore);

    // ── Transactions during period ──

    // 1. SalesInvoices in period (purchases / debits)
    const invoicesInPeriod = await prisma.salesInvoice.findMany({
      where: {
        customerId: id,
        createdAt: { gte: from, lte: to },
        paymentConfirmationStatus: { not: 'REJECTED' },
      },
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        createdAt: true,
        section: true,
        notes: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // 2. SalesPayments in period (invoice payments / credits)
    const salesPaymentsInPeriod = await prisma.salesPayment.findMany({
      where: {
        invoice: {
          customerId: id,
          paymentConfirmationStatus: { not: 'REJECTED' },
        },
        paidAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        amount: true,
        method: true,
        paidAt: true,
        notes: true,
        invoice: {
          select: { invoiceNumber: true },
        },
      },
      orderBy: { paidAt: 'asc' },
    });

    // 3. CustomerPayments in period (account payments / credits)
    const customerPaymentsInPeriod = await prisma.customerPayment.findMany({
      where: {
        customerId: id,
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        amount: true,
        method: true,
        referenceNumber: true,
        notes: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Build unified transactions list
    type Transaction = {
      id: string;
      date: Date;
      type: 'INVOICE' | 'SALES_PAYMENT' | 'ACCOUNT_PAYMENT';
      description: string;
      debit: string;
      credit: string;
    };

    const transactions: Transaction[] = [];

    for (const inv of invoicesInPeriod) {
      transactions.push({
        id: inv.id,
        date: inv.createdAt,
        type: 'INVOICE',
        description: `فاتورة ${inv.invoiceNumber}`,
        debit: inv.total.toString(),
        credit: '0',
      });
    }

    for (const sp of salesPaymentsInPeriod) {
      transactions.push({
        id: sp.id,
        date: sp.paidAt,
        type: 'SALES_PAYMENT',
        description: `دفعة على فاتورة ${sp.invoice.invoiceNumber}`,
        debit: '0',
        credit: sp.amount.toString(),
      });
    }

    for (const cp of customerPaymentsInPeriod) {
      transactions.push({
        id: cp.id,
        date: cp.createdAt,
        type: 'ACCOUNT_PAYMENT',
        description: `دفعة على الحساب${cp.referenceNumber ? ` (${cp.referenceNumber})` : ''}`,
        debit: '0',
        credit: cp.amount.toString(),
      });
    }

    // Sort all transactions by date
    transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Calculate totals
    const totalDebits = transactions.reduce(
      (sum, t) => sum.add(new Prisma.Decimal(t.debit)),
      new Prisma.Decimal(0)
    );
    const totalCredits = transactions.reduce(
      (sum, t) => sum.add(new Prisma.Decimal(t.credit)),
      new Prisma.Decimal(0)
    );
    const closingBalance = openingBalance.add(totalDebits).sub(totalCredits);

    res.json({
      customer,
      openingBalance: openingBalance.toString(),
      transactions,
      closingBalance: closingBalance.toString(),
      grandTotal: {
        totalDebits: totalDebits.toString(),
        totalCredits: totalCredits.toString(),
        openingBalance: openingBalance.toString(),
        closingBalance: closingBalance.toString(),
      },
    });
  } catch (error) {
    console.error('Customer statement error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── GET /customers/:id/item-volume — Item-by-Customer volume report ────────

router.get('/customers/:id/item-volume', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { dateFrom, dateTo, itemId } = req.query;

    // Verify customer exists
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!customer) {
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    // Build invoice filter
    const invoiceWhere: any = {
      customerId: id,
      paymentConfirmationStatus: { not: 'REJECTED' },
    };
    if (dateFrom || dateTo) {
      invoiceWhere.createdAt = {};
      if (dateFrom) invoiceWhere.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setHours(23, 59, 59, 999);
        invoiceWhere.createdAt.lte = to;
      }
    }

    // Get all invoice items for this customer in the date range
    const items = await prisma.salesInvoiceItem.findMany({
      where: {
        invoice: invoiceWhere,
        ...(itemId ? { itemId: itemId as string } : {}),
      },
      select: {
        itemId: true,
        quantity: true,
        lineTotal: true,
        item: {
          select: { id: true, name: true },
        },
      },
    });

    // Group by itemId
    const itemMap = new Map<string, {
      itemId: string;
      itemName: string;
      totalQuantity: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
    }>();

    for (const entry of items) {
      const existing = itemMap.get(entry.itemId);
      if (existing) {
        existing.totalQuantity = existing.totalQuantity.add(entry.quantity);
        existing.totalAmount = existing.totalAmount.add(entry.lineTotal);
      } else {
        itemMap.set(entry.itemId, {
          itemId: entry.itemId,
          itemName: entry.item.name,
          totalQuantity: new Prisma.Decimal(entry.quantity.toString()),
          totalAmount: new Prisma.Decimal(entry.lineTotal.toString()),
        });
      }
    }

    // Sort by total quantity desc
    const result = Array.from(itemMap.values())
      .map((v) => ({
        itemId: v.itemId,
        itemName: v.itemName,
        totalQuantity: v.totalQuantity.toString(),
        totalAmount: v.totalAmount.toString(),
      }))
      .sort((a, b) => parseFloat(b.totalQuantity) - parseFloat(a.totalQuantity));

    // Grand totals
    const grandTotalQuantity = result.reduce(
      (sum, r) => sum.add(new Prisma.Decimal(r.totalQuantity)),
      new Prisma.Decimal(0)
    );
    const grandTotalAmount = result.reduce(
      (sum, r) => sum.add(new Prisma.Decimal(r.totalAmount)),
      new Prisma.Decimal(0)
    );

    res.json({
      customer,
      items: result,
      grandTotal: {
        totalQuantity: grandTotalQuantity.toString(),
        totalAmount: grandTotalAmount.toString(),
      },
    });
  } catch (error) {
    console.error('Customer item volume error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
