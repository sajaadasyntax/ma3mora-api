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
  giftQty: z.number().min(0).default(0).optional(), // Deprecated: kept for backward compatibility
  giftItemId: z.string().optional(), // New: The item being given as gift
  giftQuantity: z.number().min(0).optional(), // New: Quantity of the gift item
}).refine((data) => {
  // Either use old giftQty or new giftItemId/giftQuantity, but not both
  const hasOldGift = data.giftQty !== undefined && data.giftQty > 0;
  const hasNewGift = data.giftItemId && data.giftQuantity && data.giftQuantity > 0;
  return !(hasOldGift && hasNewGift);
}, {
  message: 'لا يمكن استخدام نظام الهدية القديم والجديد معاً',
  path: ['giftItemId'],
});

const createInvoiceSchema = z.object({
  inventoryId: z.string(),
  section: z.enum(['GROCERY', 'BAKERY']),
  customerId: z.string().optional(),
  pricingTier: z.enum(['WHOLESALE', 'RETAIL']).optional(), // Used when no customer selected
  paymentMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']).default('CASH'),
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
            giftItem: true, // Include gift item details
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

    // Get customer to determine pricing tier (default to RETAIL if no customer)
    let customer = null;
    let pricingTier: 'WHOLESALE' | 'RETAIL' = data.pricingTier || 'RETAIL';
    
    if (data.customerId) {
      customer = await prisma.customer.findUnique({
        where: { id: data.customerId },
      });

      if (!customer) {
        return res.status(404).json({ error: 'العميل غير موجود' });
      }
      pricingTier = customer.type; // Customer type overrides any provided pricingTier
    }

    // Get items with prices (including gift items)
    const itemIds = data.items.map((i) => i.itemId);
    const giftItemIds = data.items
      .filter((i) => i.giftItemId)
      .map((i) => i.giftItemId!)
      .filter((id) => id); // Remove undefined/null values
    
    const allItemIds = [...new Set([...itemIds, ...giftItemIds])]; // Unique item IDs
    
    const items = await prisma.item.findMany({
      where: { id: { in: allItemIds } },
      include: {
        prices: {
          where: {
            tier: pricingTier,
            OR: [
              { inventoryId: data.inventoryId }, // Inventory-specific price
              { inventoryId: null }, // Global price (applies to all inventories)
            ],
          },
          orderBy: [
            { inventoryId: 'desc' }, // Prefer inventory-specific over global (null comes last with desc)
            { validFrom: 'desc' },
          ],
          take: 1, // Get the most relevant price (inventory-specific if available, otherwise global)
        },
      },
    });

    // Check stock availability for gift items
    for (const lineItem of data.items) {
      if (lineItem.giftItemId && lineItem.giftQuantity) {
        const giftStock = await prisma.inventoryStock.findUnique({
          where: {
            inventoryId_itemId: {
              inventoryId: data.inventoryId,
              itemId: lineItem.giftItemId,
            },
          },
        });

        if (!giftStock || giftStock.quantity.lessThan(lineItem.giftQuantity)) {
          const giftItem = items.find((i) => i.id === lineItem.giftItemId);
          throw new Error(`الرصيد غير كافٍ للهدية: ${giftItem?.name || lineItem.giftItemId}. المطلوب: ${lineItem.giftQuantity}, المتاح: ${giftStock?.quantity.toString() || '0'}`);
        }
      }
    }

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
        giftQty: lineItem.giftQty || 0, // Keep for backward compatibility
        giftItemId: lineItem.giftItemId || null,
        giftQuantity: lineItem.giftQuantity ? new Prisma.Decimal(lineItem.giftQuantity) : null,
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
        customerId: data.customerId || undefined,
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
            giftItem: true, // Include gift item details
          },
        },
        customer: true,
        inventory: true,
      },
    });

    // Update aggregates (async, don't block response)
    try {
      const invoiceDate = invoice.createdAt;
      const salesByMethod = {
        CASH: data.paymentMethod === 'CASH' ? total : new Prisma.Decimal(0),
        BANK: data.paymentMethod === 'BANK' ? total : new Prisma.Decimal(0),
        BANK_NILE: data.paymentMethod === 'BANK_NILE' ? total : new Prisma.Decimal(0),
      };

      await aggregationService.updateDailyFinancialAggregate(
        invoiceDate,
        {
          salesTotal: total,
          salesDebt: total, // No payment yet
          salesCount: 1,
          salesCash: salesByMethod.CASH,
          salesBank: salesByMethod.BANK,
          salesBankNile: salesByMethod.BANK_NILE,
        },
        data.inventoryId,
        data.section
      );

      // Update item aggregates
      for (const item of invoiceItems) {
        await aggregationService.updateDailyItemSalesAggregate(
          invoiceDate,
          item.itemId,
          {
            quantity: new Prisma.Decimal(item.quantity),
            giftQty: item.giftQuantity || new Prisma.Decimal(0),
            amount: item.lineTotal,
            invoiceCount: 1,
          },
          data.inventoryId,
          data.section
        );
      }

      // Update customer aggregate if applicable
      if (invoice.customerId) {
        await aggregationService.updateCustomerCumulativeAggregate(
          invoice.customerId,
          invoiceDate,
          {
            totalSales: total,
            invoiceCount: 1,
            salesCash: salesByMethod.CASH,
            salesBank: salesByMethod.BANK,
            salesBankNile: salesByMethod.BANK_NILE,
          }
        );
      }
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
      // Don't fail the request if aggregation fails
    }

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
            giftItem: true, // Include gift item details
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
            customer: existingPayment.invoice.customer?.name || 'غير محدد',
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

    const updateData: any = {
      paidAmount: newPaidAmount,
      paymentStatus,
    };
    // If this is the first payment, set invoice payment method to the method chosen by accountant/manager
    if (new Prisma.Decimal(invoice.paidAmount).equals(0)) {
      updateData.paymentMethod = paymentData.method;
    }

    const updatedInvoice = await prisma.salesInvoice.update({
      where: { id },
      data: updateData,
      include: {
        payments: true,
        customer: true,
      },
    });

    // Update aggregates (async, don't block response)
    try {
      const paymentDate = payment.paidAt;
      const paymentAmount = new Prisma.Decimal(paymentData.amount);
      const salesReceivedByMethod = {
        CASH: paymentData.method === 'CASH' ? paymentAmount : new Prisma.Decimal(0),
        BANK: paymentData.method === 'BANK' ? paymentAmount : new Prisma.Decimal(0),
        BANK_NILE: paymentData.method === 'BANK_NILE' ? paymentAmount : new Prisma.Decimal(0),
      };

      await aggregationService.updateDailyFinancialAggregate(
        paymentDate,
        {
          salesReceived: paymentAmount,
          salesDebt: paymentAmount.neg(), // Reduce debt
          salesCash: salesReceivedByMethod.CASH,
          salesBank: salesReceivedByMethod.BANK,
          salesBankNile: salesReceivedByMethod.BANK_NILE,
        },
        invoice.inventoryId,
        invoice.section
      );

      // Update customer aggregate if applicable
      if (invoice.customerId) {
        await aggregationService.updateCustomerCumulativeAggregate(
          invoice.customerId,
          paymentDate,
          {
            totalPaid: paymentAmount,
            salesCash: salesReceivedByMethod.CASH,
            salesBank: salesReceivedByMethod.BANK,
            salesBankNile: salesReceivedByMethod.BANK_NILE,
          }
        );
      }
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
      // Don't fail the request if aggregation fails
    }

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
      // Compute already delivered per item from previous deliveries
      const prevDeliveryItems = await tx.inventoryDeliveryItem.findMany({
        where: { delivery: { invoiceId: id } },
      });
      const deliveredSoFar: Record<string, Prisma.Decimal> = {};
      const giftDeliveredSoFar: Record<string, Prisma.Decimal> = {}; // Track gift items separately
      for (const di of prevDeliveryItems) {
        const prev = deliveredSoFar[di.itemId] || new Prisma.Decimal(0);
        deliveredSoFar[di.itemId] = prev.add(di.quantity).add(di.giftQty || 0);
        
        // Track gift items (new system)
        if (di.giftItemId && di.giftQuantity) {
          const prevGift = giftDeliveredSoFar[di.giftItemId] || new Prisma.Decimal(0);
          giftDeliveredSoFar[di.giftItemId] = prevGift.add(di.giftQuantity);
        }
      }

      // If nothing remains to deliver, prevent duplicate delivery records
      const allRemainingZero = invoice.items.every((it) => {
        const totalQty = new Prisma.Decimal(it.quantity).add(it.giftQty || 0);
        const already = deliveredSoFar[it.itemId] || new Prisma.Decimal(0);
        const remainingQty = totalQty.sub(already);
        
        // Also check gift items
        let remainingGift = new Prisma.Decimal(0);
        if (it.giftItemId && it.giftQuantity) {
          const alreadyGift = giftDeliveredSoFar[it.giftItemId] || new Prisma.Decimal(0);
          remainingGift = it.giftQuantity.sub(alreadyGift);
        }
        
        return remainingQty.lte(0) && remainingGift.lte(0);
      });
      if (allRemainingZero) {
        throw new Error('الفاتورة مسلمة بالكامل مسبقًا');
      }

      // Deduct stock using FIFO (First In First Out) based on expiry dates for remaining quantities only
      for (const item of invoice.items) {
        // Handle main item
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

        const totalQty = new Prisma.Decimal(item.quantity).add(item.giftQty || 0);
        const alreadyDelivered = deliveredSoFar[item.itemId] || new Prisma.Decimal(0);
        const remainingToDeliver = totalQty.sub(alreadyDelivered);
        
        // Handle gift item (new system)
        let remainingGiftToDeliver = new Prisma.Decimal(0);
        if (item.giftItemId && item.giftQuantity) {
          const alreadyGiftDelivered = giftDeliveredSoFar[item.giftItemId] || new Prisma.Decimal(0);
          remainingGiftToDeliver = item.giftQuantity.sub(alreadyGiftDelivered);
          
          if (remainingGiftToDeliver.gt(0)) {
            // Check gift item stock
            const giftStock = await tx.inventoryStock.findUnique({
              where: {
                inventoryId_itemId: {
                  inventoryId: invoice.inventoryId,
                  itemId: item.giftItemId,
                },
              },
            });

            if (!giftStock) {
              const giftItemDetails = await tx.item.findUnique({ where: { id: item.giftItemId } });
              throw new Error(`المخزون غير موجود للهدية: ${giftItemDetails?.name || item.giftItemId}`);
            }

            if (new Prisma.Decimal(giftStock.quantity).lessThan(remainingGiftToDeliver)) {
              const giftItemDetails = await tx.item.findUnique({ where: { id: item.giftItemId } });
              throw new Error(`الكمية غير كافية للهدية: ${giftItemDetails?.name || item.giftItemId}`);
            }
          }
        }
        
        if (remainingToDeliver.lte(0) && remainingGiftToDeliver.lte(0)) {
          continue; // nothing left for this item
        }

        if (remainingToDeliver.gt(0) && new Prisma.Decimal(stock.quantity).lessThan(remainingToDeliver)) {
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

        let remainingQty = remainingToDeliver;

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

        // Update total stock quantity for remaining only
        if (remainingToDeliver.gt(0)) {
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: invoice.inventoryId,
                itemId: item.itemId,
              },
            },
            data: {
              quantity: {
                decrement: remainingToDeliver,
              },
            },
          });
        }

        // Handle gift item stock deduction (new system)
        if (remainingGiftToDeliver.gt(0) && item.giftItemId) {
          // Get available batches for gift item
          const giftBatches = await tx.stockBatch.findMany({
            where: {
              inventoryId: invoice.inventoryId,
              itemId: item.giftItemId,
              quantity: {
                gt: 0,
              },
            },
          });

          // Sort batches: expiry date (earliest first, nulls last), then received date (earliest first)
          giftBatches.sort((a, b) => {
            if (a.expiryDate && b.expiryDate) {
              const dateDiff = a.expiryDate.getTime() - b.expiryDate.getTime();
              if (dateDiff !== 0) return dateDiff;
            }
            if (a.expiryDate && !b.expiryDate) return -1;
            if (!a.expiryDate && b.expiryDate) return 1;
            return a.receivedAt.getTime() - b.receivedAt.getTime();
          });

          let remainingGiftQty = remainingGiftToDeliver;

          // Consume from batches using FIFO
          for (const batch of giftBatches) {
            if (remainingGiftQty.lte(0)) break;

            const batchQty = new Prisma.Decimal(batch.quantity);
            if (batchQty.lte(0)) continue;

            if (remainingGiftQty.gte(batchQty)) {
              await tx.stockBatch.update({
                where: { id: batch.id },
                data: { quantity: 0 },
              });
              remainingGiftQty = remainingGiftQty.sub(batchQty);
            } else {
              await tx.stockBatch.update({
                where: { id: batch.id },
                data: { quantity: batchQty.sub(remainingGiftQty) },
              });
              remainingGiftQty = new Prisma.Decimal(0);
            }
          }

          // Update total stock quantity for gift item
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: invoice.inventoryId,
                itemId: item.giftItemId,
              },
            },
            data: {
              quantity: {
                decrement: remainingGiftToDeliver,
              },
            },
          });
        }

      }

      // Create delivery record
      const delivery = await tx.inventoryDelivery.create({
        data: {
          invoiceId: id,
          deliveredBy: req.user!.id,
          notes,
        },
      });

      // Attach created delivery items (those created above need the deliveryId). Since we couldn't set deliveryId earlier within the loop easily,
      // we will instead create summary items now per remaining items.
      // Recompute remaining per item to attach to this delivery record.
      for (const item of invoice.items) {
        const totalQty = new Prisma.Decimal(item.quantity).add(item.giftQty || 0);
        const alreadyDelivered = deliveredSoFar[item.itemId] || new Prisma.Decimal(0);
        const remainingToDeliver = totalQty.sub(alreadyDelivered);
        
        // Calculate remaining gift item
        let remainingGiftQty = new Prisma.Decimal(0);
        if (item.giftItemId && item.giftQuantity) {
          const alreadyGiftDelivered = giftDeliveredSoFar[item.giftItemId] || new Prisma.Decimal(0);
          remainingGiftQty = item.giftQuantity.sub(alreadyGiftDelivered);
        }
        
        if (remainingToDeliver.lte(0) && remainingGiftQty.lte(0)) continue;
        
        await tx.inventoryDeliveryItem.create({
          data: {
            deliveryId: delivery.id,
            itemId: item.itemId,
            quantity: remainingToDeliver,
            giftQty: new Prisma.Decimal(0), // Keep for backward compatibility
            giftItemId: item.giftItemId || null,
            giftQuantity: remainingGiftQty.gt(0) ? remainingGiftQty : null,
          },
        });
      }

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

// Partial delivery with explicit batch allocations
const deliveryAllocationSchema = z.object({
  itemId: z.string(),
  allocations: z.array(z.object({ batchId: z.string(), quantity: z.number().positive() })).min(1),
  giftQty: z.number().min(0).optional(),
});

const partialDeliverySchema = z.object({
  notes: z.string().optional(),
  items: z.array(deliveryAllocationSchema).min(1),
});

router.post('/invoices/:id/partial-deliver', requireRole('INVENTORY', 'MANAGER'), createAuditLog('InventoryDelivery'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const payload = partialDeliverySchema.parse(req.body);

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

    // Transactionally deduct batches according to allocations, record delivery items/batches
    const result = await prisma.$transaction(async (tx) => {
      const delivery = await tx.inventoryDelivery.create({
        data: {
          invoiceId: id,
          deliveredBy: req.user!.id,
          notes: payload.notes,
        },
      });

      // Build a map of ordered quantities per item
      const orderedByItem: Record<string, { qty: Prisma.Decimal; gift: Prisma.Decimal }> = {} as any;
      for (const it of invoice.items) {
        orderedByItem[it.itemId] = {
          qty: new Prisma.Decimal(it.quantity),
          gift: new Prisma.Decimal(it.giftQty),
        };
      }

      // Compute already delivered per item from previous deliveries
      const prevDeliveryItems = await tx.inventoryDeliveryItem.findMany({
        where: { delivery: { invoiceId: id } },
      });
      const deliveredSoFar: Record<string, Prisma.Decimal> = {};
      for (const di of prevDeliveryItems) {
        const prev = deliveredSoFar[di.itemId] || new Prisma.Decimal(0);
        deliveredSoFar[di.itemId] = prev.add(di.quantity).add(di.giftQty);
      }

      for (const itemAlloc of payload.items) {
        const ordered = orderedByItem[itemAlloc.itemId];
        if (!ordered) {
          throw new Error('الصنف غير موجود في الفاتورة');
        }

        const deliverQty = itemAlloc.allocations.reduce((sum, a) => sum.add(new Prisma.Decimal(a.quantity)), new Prisma.Decimal(0));
        const totalDeliver = deliverQty.add(new Prisma.Decimal(itemAlloc.giftQty || 0));
        const previously = deliveredSoFar[itemAlloc.itemId] || new Prisma.Decimal(0);
        const maxAllowed = ordered.qty.add(ordered.gift);
        if (previously.add(totalDeliver).gt(maxAllowed)) {
          throw new Error('الكمية المراد تسليمها تتجاوز المطلوب في الفاتورة');
        }

        // Deduct from batches and record delivery item/batches
        const deliveryItem = await tx.inventoryDeliveryItem.create({
          data: {
            deliveryId: delivery.id,
            itemId: itemAlloc.itemId,
            quantity: deliverQty,
            giftQty: new Prisma.Decimal(itemAlloc.giftQty || 0),
          },
        });

        for (const alloc of itemAlloc.allocations) {
          const batch = await tx.stockBatch.findUnique({ where: { id: alloc.batchId } });
          if (!batch || batch.inventoryId !== invoice.inventoryId || batch.itemId !== itemAlloc.itemId) {
            throw new Error('الدفعة المحددة غير صالحة لهذا المخزن أو الصنف');
          }
          const allocQty = new Prisma.Decimal(alloc.quantity);
          if (new Prisma.Decimal(batch.quantity).lt(allocQty)) {
            throw new Error('الكمية غير متوفرة في الدفعة المحددة');
          }

          await tx.stockBatch.update({
            where: { id: alloc.batchId },
            data: { quantity: new Prisma.Decimal(batch.quantity).sub(allocQty) },
          });

          await tx.inventoryDeliveryBatch.create({
            data: {
              deliveryItemId: deliveryItem.id,
              batchId: alloc.batchId,
              quantity: allocQty,
            },
          });
        }

        // Update total stock for this item
        await tx.inventoryStock.update({
          where: { inventoryId_itemId: { inventoryId: invoice.inventoryId, itemId: itemAlloc.itemId } },
          data: { quantity: { decrement: deliverQty } },
        });

        // Update deliveredSoFar map
        deliveredSoFar[itemAlloc.itemId] = (deliveredSoFar[itemAlloc.itemId] || new Prisma.Decimal(0)).add(totalDeliver);
      }

      // After partial delivery, set invoice status to PARTIAL or DELIVERED if fully delivered
      let allDelivered = true;
      for (const [itemId, ordered] of Object.entries(orderedByItem)) {
        const d = deliveredSoFar[itemId] || new Prisma.Decimal(0);
        if (d.lt(ordered.qty.add(ordered.gift))) {
          allDelivered = false;
          break;
        }
      }

      const updatedInvoice = await tx.salesInvoice.update({
        where: { id },
        data: { deliveryStatus: allDelivered ? 'DELIVERED' : 'PARTIAL' },
        include: {
          items: { include: { item: true } },
          deliveries: { include: { deliveredByUser: true } },
          customer: true,
        },
      });

      return { invoice: updatedInvoice };
    });

    res.json(result);
  } catch (error) {
    console.error('Partial deliver invoice error:', error);
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
      groupBy = 'date',
      viewType = 'grouped' // 'grouped' for period grouping, 'invoices' for invoice-level
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
            giftItem: true, // Include gift item details
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

    // If viewType is 'invoices', return invoice-level data similar to supplier report
    if (viewType === 'invoices') {
      const invoiceReportData = invoices.map(invoice => ({
        invoiceNumber: invoice.invoiceNumber,
        date: invoice.createdAt,
        customer: invoice.customer?.name || 'بدون عميل',
        inventory: invoice.inventory.name,
        notes: invoice.notes || null,
        total: invoice.total.toString(),
        paidAmount: invoice.paidAmount.toString(),
        outstanding: new Prisma.Decimal(invoice.total).sub(invoice.paidAmount).toString(),
        paymentStatus: invoice.paymentStatus,
        deliveryStatus: invoice.deliveryStatus,
        paymentConfirmed: invoice.paymentConfirmed,
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

      // Add initial and final stock for inventory reports
      let stockInfo: any = null;
      if (inventoryId && startDate && endDate) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);

        const initialStocks = await prisma.inventoryStock.findMany({
          where: { inventoryId: inventoryId as string },
          include: { item: true },
        });

        const stockMovements = await prisma.stockMovement.findMany({
          where: {
            inventoryId: inventoryId as string,
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

        stockInfo = {
          initial: initialStockByItem,
          final: finalStockByItem,
          items: initialStocks.map(s => ({
            itemId: s.itemId,
            itemName: s.item.name,
            initialStock: initialStockByItem[s.itemId] || 0,
            finalStock: finalStockByItem[s.itemId] || 0,
          })),
        };
      }

      return res.json({
        period,
        data: invoiceReportData,
        summary: {
          totalInvoices: invoices.length,
          totalSales: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()), 0),
          totalPaid: invoices.reduce((sum, inv) => sum + parseFloat(inv.paidAmount.toString()), 0),
          totalOutstanding: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()) - parseFloat(inv.paidAmount.toString()), 0),
        },
        ...(stockInfo && { stockInfo }),
      });
    }

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

    // Add initial and final stock for inventory reports
    let stockInfo: any = null;
    if (inventoryId && startDate && endDate) {
      const start = new Date(startDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);

      // Get initial stock (opening balance at start date)
      const initialStocks = await prisma.inventoryStock.findMany({
        where: { inventoryId: inventoryId as string },
        include: { item: true },
      });

      // Get stock movements to calculate final stock
      const stockMovements = await prisma.stockMovement.findMany({
        where: {
          inventoryId: inventoryId as string,
          movementDate: {
            gte: start,
            lte: end,
          },
        },
        include: { item: true },
      });

      // Calculate initial stock (from StockMovement if available, otherwise from InventoryStock)
      const initialStockByItem: Record<string, number> = {};
      const finalStockByItem: Record<string, number> = {};

      // Get opening balances from first movement or use current stock as reference
      for (const stock of initialStocks) {
        const firstMovement = stockMovements
          .filter(m => m.itemId === stock.itemId)
          .sort((a, b) => a.movementDate.getTime() - b.movementDate.getTime())[0];
        
        if (firstMovement) {
          initialStockByItem[stock.itemId] = parseFloat(firstMovement.openingBalance.toString());
        } else {
          // Use current stock minus changes in period
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

      // Calculate final stock
      for (const stock of initialStocks) {
        const initial = initialStockByItem[stock.itemId] || 0;
        const movements = stockMovements.filter(m => m.itemId === stock.itemId);
        const totalIncoming = movements.reduce((sum, m) => sum + parseFloat(m.incoming.toString()), 0);
        const totalOutgoing = movements.reduce((sum, m) => sum + parseFloat(m.outgoing.toString()) + parseFloat(m.pendingOutgoing.toString()), 0);
        const totalIncomingGifts = movements.reduce((sum, m) => sum + parseFloat(m.incomingGifts.toString()), 0);
        const totalOutgoingGifts = movements.reduce((sum, m) => sum + parseFloat(m.outgoingGifts.toString()), 0);
        
        finalStockByItem[stock.itemId] = initial + totalIncoming - totalOutgoing + totalIncomingGifts - totalOutgoingGifts;
      }

      stockInfo = {
        initial: initialStockByItem,
        final: finalStockByItem,
        items: initialStocks.map(s => ({
          itemId: s.itemId,
          itemName: s.item.name,
          initialStock: initialStockByItem[s.itemId] || 0,
          finalStock: finalStockByItem[s.itemId] || 0,
        })),
      };
    }

    // Get item-level stock movement data
    // For 'items' viewType, always generate item report data if dates are provided
    let itemReportData: any[] = [];
    if (startDate && endDate) {
      // Get unique inventory IDs from invoices (for non-items viewType)
      const inventoryIds = (viewType !== 'items' && invoices.length > 0)
        ? [...new Set(invoices.map(inv => inv.inventoryId))]
        : [];
      
      // If no invoices but we have inventory filter, use it
      // For 'items' viewType, prioritize inventoryId filter
      let targetInventoryIds = inventoryIds;
      if (viewType === 'items' && inventoryId) {
        // When viewType is 'items', use the selected inventory
        targetInventoryIds = [inventoryId as string];
      } else if (inventoryIds.length === 0 && inventoryId) {
        targetInventoryIds = [inventoryId as string];
      } else if (inventoryIds.length === 0) {
        // Get all inventories that have stock movements in the date range
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);
        
        const movements = await prisma.stockMovement.findMany({
          where: {
            movementDate: {
              gte: start,
              lte: end,
            },
            ...(inventoryId && { inventoryId: inventoryId as string }),
            ...(section && { 
              item: { section: section as any }
            }),
          },
          select: { inventoryId: true },
          distinct: ['inventoryId'],
        });
        targetInventoryIds = movements.map(m => m.inventoryId);
      }
      
      for (const invId of targetInventoryIds) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);

        // Get all items in this inventory (filter by section if provided)
        const stocksWhere: any = { inventoryId: invId };
        if (section) {
          stocksWhere.item = { section: section as any };
        }
        const inventoryStocks = await prisma.inventoryStock.findMany({
          where: stocksWhere,
          include: { item: true },
        });

        // Get stock movements for this inventory in the date range (filter by section if provided)
        const movementsWhere: any = {
          inventoryId: invId,
          movementDate: {
            gte: start,
            lte: end,
          },
        };
        if (section) {
          movementsWhere.item = { section: section as any };
        }
        const stockMovements = await prisma.stockMovement.findMany({
          where: movementsWhere,
          include: { item: true },
        });

        // Group movements by item
        const movementsByItem: Record<string, typeof stockMovements> = {};
        stockMovements.forEach(movement => {
          if (!movementsByItem[movement.itemId]) {
            movementsByItem[movement.itemId] = [];
          }
          movementsByItem[movement.itemId].push(movement);
        });

        // Process each item - only include items with activity in the period
        for (const stock of inventoryStocks) {
          const itemMovements = movementsByItem[stock.itemId] || [];
          
          // Skip items with no activity
          if (itemMovements.length === 0) {
            continue;
          }
          
          // Get opening balance from first movement
          const firstMovement = itemMovements.sort((a, b) => a.movementDate.getTime() - b.movementDate.getTime())[0];
          const openingBalance = parseFloat(firstMovement.openingBalance.toString());

          // Aggregate movements
          const totalOutgoing = itemMovements.reduce((sum, m) => 
            sum + parseFloat(m.outgoing.toString()) + parseFloat(m.pendingOutgoing.toString()), 0
          );
          const totalOutgoingGifts = itemMovements.reduce((sum, m) => 
            sum + parseFloat(m.outgoingGifts.toString()), 0
          );
          const totalIncoming = itemMovements.reduce((sum, m) => 
            sum + parseFloat(m.incoming.toString()), 0
          );
          const totalIncomingGifts = itemMovements.reduce((sum, m) => 
            sum + parseFloat(m.incomingGifts.toString()), 0
          );
          
          const closingBalance = openingBalance + totalIncoming + totalIncomingGifts - totalOutgoing - totalOutgoingGifts;

          itemReportData.push({
            itemId: stock.itemId,
            itemName: stock.item.name,
            openingBalance: openingBalance,
            outgoing: totalOutgoing,
            outgoingGifts: totalOutgoingGifts,
            incoming: totalIncoming,
            incomingGifts: totalIncomingGifts,
            closingBalance: closingBalance,
          });
        }
      }
    }

    // If viewType is 'items', always return item-level data (force item report)
    if (viewType === 'items') {
      // If no item report data was generated, return empty array
      return res.json({
        period,
        data: itemReportData,
        summary: {
          totalInvoices: invoices.length,
          totalSales: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()), 0),
          totalPaid: invoices.reduce((sum, inv) => sum + parseFloat(inv.paidAmount.toString()), 0),
          totalOutstanding: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()) - parseFloat(inv.paidAmount.toString()), 0),
        },
        ...(stockInfo && { stockInfo }),
      });
    }

    res.json({
      period,
      data: itemReportData.length > 0 ? itemReportData : reportData, // Return item data if available, otherwise grouped invoice data
      summary: {
        totalInvoices: invoices.length,
        totalSales: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()), 0),
        totalPaid: invoices.reduce((sum, inv) => sum + parseFloat(inv.paidAmount.toString()), 0),
        totalOutstanding: invoices.reduce((sum, inv) => sum + parseFloat(inv.total.toString()) - parseFloat(inv.paidAmount.toString()), 0),
      },
      ...(stockInfo && { stockInfo }),
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
            giftItem: true, // Include gift item details
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
          customerName: invoice.customer?.name || 'غير محدد',
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


