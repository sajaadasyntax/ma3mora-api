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

const invoiceItemSchema = z.object({
  itemId: z.string(),
  quantity: z.number().positive(),
  giftQty: z.number().min(0).default(0),
});

const createInvoiceSchema = z.object({
  inventoryId: z.string(),
  section: z.enum(['GROCERY', 'BAKERY']),
  customerId: z.string(),
  paymentMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  discount: z.number().min(0).default(0),
  items: z.array(invoiceItemSchema).min(1),
  notes: z.string().optional(),
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  notes: z.string().optional(),
  receiptUrl: z.string().optional(),
});

// Generate invoice number
async function generateInvoiceNumber(): Promise<string> {
  const count = await prisma.salesInvoice.count();
  return `INV-${String(count + 1).padStart(6, '0')}`;
}

router.get('/invoices', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { status, inventoryId, section, deliveryStatus, paymentStatus } = req.query;
    const where: any = {};

    if (status) where.deliveryStatus = status;
    if (deliveryStatus) where.deliveryStatus = deliveryStatus;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    // Sales users can only see their own invoices or filtered by their access
    if (req.user?.role === 'SALES_GROCERY' || req.user?.role === 'SALES_BAKERY') {
      where.salesUserId = req.user.id;
    }

    // Inventory users can only see payment-confirmed invoices
    if (req.user?.role === 'INVENTORY') {
      where.paymentConfirmed = true;
    }

    const invoices = await prisma.salesInvoice.findMany({
      where,
      include: {
        customer: true,
        inventory: true,
        salesUser: {
          select: { id: true, username: true },
        },
        paymentConfirmedByUser: {
          select: { id: true, username: true },
        },
        items: {
          include: {
            item: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(invoices);
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices', requireRole('SALES_GROCERY', 'SALES_BAKERY'), checkBalanceOpen, createAuditLog('SalesInvoice'), async (req: AuthRequest, res) => {
  try {
    const data = createInvoiceSchema.parse(req.body);

    // Get customer to determine pricing tier
    const customer = await prisma.customer.findUnique({
      where: { id: data.customerId },
    });

    if (!customer) {
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    // Get items with prices
    const itemIds = data.items.map((i) => i.itemId);
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: {
        prices: {
          where: { tier: customer.type },
          orderBy: { validFrom: 'desc' },
          take: 1,
        },
      },
    });

    // Calculate line totals
    const invoiceItems = data.items.map((lineItem) => {
      const item = items.find((i) => i.id === lineItem.itemId);
      if (!item || item.prices.length === 0) {
        throw new Error(`السعر غير متوفر للصنف ${item?.name || lineItem.itemId}`);
      }

      const unitPrice = item.prices[0].price;
      const lineTotal = new Prisma.Decimal(lineItem.quantity).mul(unitPrice);

      return {
        itemId: lineItem.itemId,
        quantity: lineItem.quantity,
        giftQty: lineItem.giftQty,
        unitPrice,
        lineTotal,
      };
    });

    const subtotal = invoiceItems.reduce(
      (sum, item) => sum.add(item.lineTotal),
      new Prisma.Decimal(0)
    );
    const total = subtotal.sub(data.discount);

    const invoiceNumber = await generateInvoiceNumber();

    const invoice = await prisma.salesInvoice.create({
      data: {
        invoiceNumber,
        inventoryId: data.inventoryId,
        section: data.section,
        salesUserId: req.user!.id,
        customerId: data.customerId,
        paymentMethod: data.paymentMethod,
        paymentStatus: 'CREDIT',
        deliveryStatus: 'NOT_DELIVERED',
        subtotal,
        discount: data.discount,
        total,
        paidAmount: 0,
        notes: data.notes,
        items: {
          create: invoiceItems,
        },
      },
      include: {
        items: {
          include: {
            item: true,
          },
        },
        customer: true,
        inventory: true,
      },
    });

    res.status(201).json(invoice);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create invoice error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

router.get('/invoices/:id', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        customer: true,
        inventory: true,
        salesUser: {
          select: { id: true, username: true },
        },
        paymentConfirmedByUser: {
          select: { id: true, username: true },
        },
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
        deliveries: {
          include: {
            deliveredByUser: {
              select: { id: true, username: true },
            },
          },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    res.json(invoice);
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices/:id/payments', requireRole('ACCOUNTANT', 'SALES_GROCERY', 'SALES_BAKERY'), checkBalanceOpen, createAuditLog('SalesPayment'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const paymentData = paymentSchema.parse(req.body);

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    const newPaidAmount = new Prisma.Decimal(invoice.paidAmount).add(paymentData.amount);

    if (newPaidAmount.greaterThan(invoice.total)) {
      return res.status(400).json({ error: 'المبلغ المدفوع يتجاوز إجمالي الفاتورة' });
    }

    const payment = await prisma.salesPayment.create({
      data: {
        invoiceId: id,
        amount: paymentData.amount,
        method: paymentData.method,
        recordedBy: req.user!.id,
        notes: paymentData.notes,
        receiptUrl: paymentData.receiptUrl,
      },
    });

    // Update invoice payment status
    let paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' = 'PARTIAL';
    if (newPaidAmount.equals(invoice.total)) {
      paymentStatus = 'PAID';
    } else if (newPaidAmount.equals(0)) {
      paymentStatus = 'CREDIT';
    }

    const updatedInvoice = await prisma.salesInvoice.update({
      where: { id },
      data: {
        paidAmount: newPaidAmount,
        paymentStatus,
      },
      include: {
        payments: true,
      },
    });

    res.json({ payment, invoice: updatedInvoice });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices/:id/confirm-payment', requireRole('ACCOUNTANT'), createAuditLog('SalesInvoice'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    if (invoice.paymentConfirmed) {
      return res.status(400).json({ error: 'الدفع مؤكد بالفعل' });
    }

    const updatedInvoice = await prisma.salesInvoice.update({
      where: { id },
      data: {
        paymentConfirmed: true,
        paymentConfirmedBy: req.user!.id,
        paymentConfirmedAt: new Date(),
      },
      include: {
        customer: true,
        inventory: true,
        salesUser: {
          select: { id: true, username: true },
        },
        paymentConfirmedByUser: {
          select: { id: true, username: true },
        },
      },
    });

    res.json(updatedInvoice);
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices/:id/deliver', requireRole('INVENTORY'), createAuditLog('InventoryDelivery'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        items: true,
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    if (!invoice.paymentConfirmed) {
      return res.status(400).json({ error: 'يجب تأكيد الدفع من المحاسب أولاً' });
    }

    if (invoice.deliveryStatus === 'DELIVERED') {
      return res.status(400).json({ error: 'الفاتورة مسلمة بالفعل' });
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Deduct stock
      for (const item of invoice.items) {
        const stock = await tx.inventoryStock.findUnique({
          where: {
            inventoryId_itemId: {
              inventoryId: invoice.inventoryId,
              itemId: item.itemId,
            },
          },
        });

        if (!stock) {
          throw new Error(`المخزون غير موجود للصنف ${item.itemId}`);
        }

        const totalQty = new Prisma.Decimal(item.quantity).add(item.giftQty);

        if (new Prisma.Decimal(stock.quantity).lessThan(totalQty)) {
          const itemDetails = await tx.item.findUnique({ where: { id: item.itemId } });
          throw new Error(`الكمية غير كافية للصنف ${itemDetails?.name || item.itemId}`);
        }

        await tx.inventoryStock.update({
          where: {
            inventoryId_itemId: {
              inventoryId: invoice.inventoryId,
              itemId: item.itemId,
            },
          },
          data: {
            quantity: {
              decrement: totalQty,
            },
          },
        });
      }

      // Create delivery record
      const delivery = await tx.inventoryDelivery.create({
        data: {
          invoiceId: id,
          deliveredBy: req.user!.id,
          notes,
        },
      });

      // Update invoice status
      const updatedInvoice = await tx.salesInvoice.update({
        where: { id },
        data: {
          deliveryStatus: 'DELIVERED',
        },
        include: {
          items: {
            include: {
              item: true,
            },
          },
          customer: true,
        },
      });

      return { delivery, invoice: updatedInvoice };
    });

    res.json(result);
  } catch (error) {
    console.error('Deliver invoice error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

export default router;

