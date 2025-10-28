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
  receiptNumber: z.string().optional(),
}).refine((data) => {
  // If method is BANK or BANK_NILE, receiptNumber is required
  if (data.method !== 'CASH' && !data.receiptNumber) {
    return false;
  }
  return true;
}, {
  message: 'رقم الإيصال مطلوب لطرق الدفع البنكية',
  path: ['receiptNumber'],
});

// Generate invoice number
async function generateInvoiceNumber(): Promise<string> {
  const count = await prisma.salesInvoice.count();
  return `INV-${String(count + 1).padStart(6, '0')}`;
}

router.get('/invoices', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER', 'INVENTORY', 'PROCUREMENT'), async (req: AuthRequest, res) => {
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

router.post('/invoices', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'MANAGER'), checkBalanceOpen, createAuditLog('SalesInvoice'), async (req: AuthRequest, res) => {
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

router.get('/invoices/:id', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER', 'INVENTORY', 'PROCUREMENT'), async (req: AuthRequest, res) => {
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

    // Inventory users can only see payment-confirmed invoices
    if (req.user?.role === 'INVENTORY' && !invoice.paymentConfirmed) {
      return res.status(403).json({ error: 'ليس لديك صلاحية للوصول' });
    }

    res.json(invoice);
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices/:id/payments', requireRole('ACCOUNTANT', 'SALES_GROCERY', 'SALES_BAKERY', 'MANAGER'), checkBalanceOpen, createAuditLog('SalesPayment'), async (req: AuthRequest, res) => {
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

    // Check receipt number uniqueness if provided (required for bank payments)
    if (paymentData.receiptNumber) {
      // Check if receipt number exists in sales payments
      const existingPayment = await prisma.salesPayment.findUnique({
        where: { receiptNumber: paymentData.receiptNumber },
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
          error: 'رقم الإيصال مستخدم بالفعل',
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

      // Check if receipt number exists in cash exchanges
      const existingExchange = await prisma.cashExchange.findUnique({
        where: { receiptNumber: paymentData.receiptNumber },
        include: {
          createdByUser: {
            select: { id: true, username: true },
          },
        },
      });

      if (existingExchange) {
        return res.status(400).json({ 
          error: 'رقم الإيصال مستخدم بالفعل في صرف نقدي',
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
    }

    const payment = await prisma.salesPayment.create({
      data: {
        invoiceId: id,
        amount: paymentData.amount,
        method: paymentData.method,
        recordedBy: req.user!.id,
        notes: paymentData.notes,
        receiptUrl: paymentData.receiptUrl,
        receiptNumber: paymentData.receiptNumber,
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
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'رقم الإيصال مستخدم بالفعل' });
      }
    }
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices/:id/confirm-payment', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('SalesInvoice'), async (req: AuthRequest, res) => {
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

router.post('/invoices/:id/deliver', requireRole('INVENTORY', 'MANAGER'), createAuditLog('InventoryDelivery'), async (req: AuthRequest, res) => {
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
      // Deduct stock using FIFO (First In First Out) based on expiry dates
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

        // Get available batches for this item
        const batches = await tx.stockBatch.findMany({
          where: {
            inventoryId: invoice.inventoryId,
            itemId: item.itemId,
            quantity: {
              gt: 0,
            },
          },
        });

        // Sort batches: expiry date (earliest first, nulls last), then received date (earliest first)
        batches.sort((a, b) => {
          // If both have expiry dates, sort by expiry date
          if (a.expiryDate && b.expiryDate) {
            const dateDiff = a.expiryDate.getTime() - b.expiryDate.getTime();
            if (dateDiff !== 0) return dateDiff;
          }
          // If only one has expiry date, prioritize the one with expiry date
          if (a.expiryDate && !b.expiryDate) return -1;
          if (!a.expiryDate && b.expiryDate) return 1;
          // If both null or same expiry, sort by received date
          return a.receivedAt.getTime() - b.receivedAt.getTime();
        });

        let remainingQty = totalQty;

        // Consume from batches using FIFO
        for (const batch of batches) {
          if (remainingQty.lte(0)) break;

          const batchQty = new Prisma.Decimal(batch.quantity);
          if (batchQty.lte(0)) continue;

          if (remainingQty.gte(batchQty)) {
            // Consume entire batch
            await tx.stockBatch.update({
              where: { id: batch.id },
              data: { quantity: 0 },
            });
            remainingQty = remainingQty.sub(batchQty);
          } else {
            // Consume partial batch
            await tx.stockBatch.update({
              where: { id: batch.id },
              data: { quantity: batchQty.sub(remainingQty) },
            });
            remainingQty = new Prisma.Decimal(0);
          }
        }

        // Update total stock quantity
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

// Sales Reports endpoint
router.get('/reports', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      period = 'daily', 
      inventoryId, 
      section,
      paymentMethod,
      groupBy = 'date'
    } = req.query;

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

    // Additional filters
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    // Get invoices with detailed information
    const invoices = await prisma.salesInvoice.findMany({
      where,
      include: {
        customer: true,
        inventory: true,
        salesUser: {
          select: { id: true, username: true },
        },
        items: {
          include: {
            item: true,
          },
        },
        payments: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group data based on period
    let groupedData: any = {};
    
    if (period === 'daily') {
      invoices.forEach(invoice => {
        const date = invoice.createdAt.toISOString().split('T')[0];
        if (!groupedData[date]) {
          groupedData[date] = {
            date,
            invoices: [],
            totalSales: 0,
            totalPaid: 0,
            invoiceCount: 0,
            paymentMethods: {},
            items: {},
          };
        }
        
        groupedData[date].invoices.push(invoice);
        groupedData[date].totalSales += parseFloat(invoice.total.toString());
        groupedData[date].totalPaid += parseFloat(invoice.paidAmount.toString());
        groupedData[date].invoiceCount += 1;
        
        // Group by payment method
        const paymentMethod = invoice.paymentMethod;
        if (!groupedData[date].paymentMethods[paymentMethod]) {
          groupedData[date].paymentMethods[paymentMethod] = {
            count: 0,
            amount: 0,
          };
        }
        groupedData[date].paymentMethods[paymentMethod].count += 1;
        groupedData[date].paymentMethods[paymentMethod].amount += parseFloat(invoice.total.toString());
        
        // Group by items
        invoice.items.forEach(item => {
          const itemName = item.item.name;
          if (!groupedData[date].items[itemName]) {
            groupedData[date].items[itemName] = {
              quantity: 0,
              totalAmount: 0,
              unitPrice: parseFloat(item.unitPrice.toString()),
            };
          }
          groupedData[date].items[itemName].quantity += parseFloat(item.quantity.toString());
          groupedData[date].items[itemName].totalAmount += parseFloat(item.lineTotal.toString());
        });
      });
    } else if (period === 'monthly') {
      invoices.forEach(invoice => {
        const month = invoice.createdAt.toISOString().substring(0, 7); // YYYY-MM
        if (!groupedData[month]) {
          groupedData[month] = {
            month,
            invoices: [],
            totalSales: 0,
            totalPaid: 0,
            invoiceCount: 0,
            paymentMethods: {},
            items: {},
          };
        }
        
        groupedData[month].invoices.push(invoice);
        groupedData[month].totalSales += parseFloat(invoice.total.toString());
        groupedData[month].totalPaid += parseFloat(invoice.paidAmount.toString());
        groupedData[month].invoiceCount += 1;
        
        // Group by payment method
        const paymentMethod = invoice.paymentMethod;
        if (!groupedData[month].paymentMethods[paymentMethod]) {
          groupedData[month].paymentMethods[paymentMethod] = {
            count: 0,
            amount: 0,
          };
        }
        groupedData[month].paymentMethods[paymentMethod].count += 1;
        groupedData[month].paymentMethods[paymentMethod].amount += parseFloat(invoice.total.toString());
        
        // Group by items
        invoice.items.forEach(item => {
          const itemName = item.item.name;
          if (!groupedData[month].items[itemName]) {
            groupedData[month].items[itemName] = {
              quantity: 0,
              totalAmount: 0,
              unitPrice: parseFloat(item.unitPrice.toString()),
            };
          }
          groupedData[month].items[itemName].quantity += parseFloat(item.quantity.toString());
          groupedData[month].items[itemName].totalAmount += parseFloat(item.lineTotal.toString());
        });
      });
    }

    // Convert to array and sort
    const reportData = Object.values(groupedData).sort((a: any, b: any) => {
      if (period === 'daily') {
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      } else {
        return b.month.localeCompare(a.month);
      }
    });

    res.json({
      period,
      data: reportData,
      summary: {
        totalInvoices: invoices.length,
        totalSales: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()), 0),
        totalPaid: invoices.reduce((sum, inv) => sum + parseFloat(inv.paidAmount.toString()), 0),
        totalOutstanding: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()) - parseFloat(inv.paidAmount.toString()), 0),
      },
    });
  } catch (error) {
    console.error('Sales reports error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Daily Sales Report by Item
router.get('/reports/daily-by-item', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'INVENTORY', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { date, inventoryId, section } = req.query;
    
    // Default to today if no date provided
    const targetDate = date ? new Date(date as string) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Build where clause
    const where: any = {
      createdAt: {
        gte: startOfDay,
        lte: endOfDay,
      },
    };

    if (inventoryId) {
      where.inventoryId = inventoryId as string;
    }

    if (section) {
      where.section = section;
    }

    // Get all invoices for the day
    const invoices = await prisma.salesInvoice.findMany({
      where,
      include: {
        inventory: true,
        customer: true,
        items: {
          include: {
            item: true,
          },
        },
        payments: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Aggregate sales by item
    const itemsMap: any = {};
    let totalRevenue = new Prisma.Decimal(0);
    let totalInvoices = invoices.length;

    invoices.forEach(invoice => {
      totalRevenue = totalRevenue.add(invoice.total);
      
      invoice.items.forEach(invoiceItem => {
        const itemId = invoiceItem.itemId;
        const itemName = invoiceItem.item.name;
        
        if (!itemsMap[itemId]) {
          itemsMap[itemId] = {
            itemId,
            itemName,
            section: invoiceItem.item.section,
            totalQuantity: new Prisma.Decimal(0),
            totalGiftQty: new Prisma.Decimal(0),
            totalAmount: new Prisma.Decimal(0),
            invoiceCount: 0,
            invoices: [],
            unitPrices: new Set(),
          };
        }

        itemsMap[itemId].totalQuantity = itemsMap[itemId].totalQuantity.add(invoiceItem.quantity);
        itemsMap[itemId].totalGiftQty = itemsMap[itemId].totalGiftQty.add(invoiceItem.giftQty || 0);
        itemsMap[itemId].totalAmount = itemsMap[itemId].totalAmount.add(invoiceItem.lineTotal);
        itemsMap[itemId].unitPrices.add(parseFloat(invoiceItem.unitPrice.toString()));
        
        // Track which invoices include this item
        itemsMap[itemId].invoices.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          customerName: invoice.customer.name,
          quantity: invoiceItem.quantity.toString(),
          giftQty: (invoiceItem.giftQty || 0).toString(),
          unitPrice: invoiceItem.unitPrice.toString(),
          lineTotal: invoiceItem.lineTotal.toString(),
          createdAt: invoice.createdAt,
        });
      });
    });

    // Convert to array and format
    const itemsReport = Object.values(itemsMap).map((item: any) => ({
      itemId: item.itemId,
      itemName: item.itemName,
      section: item.section,
      totalQuantity: item.totalQuantity.toString(),
      totalGiftQty: item.totalGiftQty.toString(),
      totalAmount: item.totalAmount.toString(),
      averageUnitPrice: item.totalQuantity.greaterThan(0) 
        ? item.totalAmount.div(item.totalQuantity).toFixed(2)
        : '0.00',
      unitPriceRange: Array.from<number>(item.unitPrices).sort((a, b) => a - b).join(', '),
      invoiceCount: item.invoices.length,
      invoices: item.invoices.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    }));

    // Sort by total amount descending
    itemsReport.sort((a: any, b: any) => 
      parseFloat(b.totalAmount) - parseFloat(a.totalAmount)
    );

    res.json({
      date: targetDate.toISOString().split('T')[0],
      inventory: inventoryId ? invoices[0]?.inventory : null,
      section: section || null,
      summary: {
        totalInvoices,
        totalRevenue: totalRevenue.toString(),
        totalItems: itemsReport.length,
        totalQuantity: itemsReport.reduce((sum, item) => sum + parseFloat(item.totalQuantity), 0).toFixed(2),
        totalAmount: itemsReport.reduce((sum, item) => sum + parseFloat(item.totalAmount), 0).toFixed(2),
      },
      items: itemsReport,
    });
  } catch (error) {
    console.error('Daily sales by item report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

