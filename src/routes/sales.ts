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

// Utility function to calculate payment status based on paidAmount and total
function calculatePaymentStatus(paidAmount: Prisma.Decimal, total: Prisma.Decimal): 'PAID' | 'PARTIAL' | 'CREDIT' {
  if (paidAmount.equals(0)) {
    return 'CREDIT';
  } else if (paidAmount.greaterThanOrEqualTo(total)) {
    return 'PAID';
  } else {
    return 'PARTIAL';
  }
}

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
  priceTier: z.enum(['WHOLESALE', 'RETAIL', 'AGENT', 'AGENT_WHOLESALE', 'AGENT_RETAIL', 'OFFER_1', 'OFFER_2']).optional(), // Optional: Override price tier (for bakery wholesale offers)
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
  pricingTier: z.enum(['WHOLESALE', 'RETAIL', 'AGENT', 'AGENT_WHOLESALE', 'AGENT_RETAIL', 'OFFER_1', 'OFFER_2']).optional(), // Used when no customer selected
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

router.get('/invoices', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER', 'INVENTORY', 'PROCUREMENT'), async (req: AuthRequest, res) => {
  try {
    const { status, inventoryId, section, deliveryStatus, paymentStatus } = req.query;
    const where: any = {};

    if (status) where.deliveryStatus = status;
    if (deliveryStatus) where.deliveryStatus = deliveryStatus;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    // Sales users (including agents) can only see their own invoices or filtered by their access
    if (req.user?.role === 'SALES_GROCERY' || req.user?.role === 'SALES_BAKERY' || req.user?.role === 'AGENT_GROCERY' || req.user?.role === 'AGENT_BAKERY') {
      where.salesUserId = req.user.id;
    }

    // Inventory users can only see payment-confirmed invoices
    if (req.user?.role === 'INVENTORY') {
      where.paymentConfirmationStatus = 'CONFIRMED';
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

router.post('/invoices', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'MANAGER'), checkBalanceOpen, createAuditLog('SalesInvoice'), async (req: AuthRequest, res) => {
  try {
    const data = createInvoiceSchema.parse(req.body);

    // Get customer to determine pricing tier (default to RETAIL if no customer)
    let customer = null;
    let pricingTier: 'WHOLESALE' | 'RETAIL' | 'AGENT' | 'AGENT_WHOLESALE' | 'AGENT_RETAIL' | 'OFFER_1' | 'OFFER_2' = data.pricingTier || 'RETAIL';
    
    const isAgentUser = req.user?.role === 'AGENT_GROCERY' || req.user?.role === 'AGENT_BAKERY';
    
    if (data.customerId) {
      customer = await prisma.customer.findUnique({
        where: { id: data.customerId },
      });

      if (!customer) {
        return res.status(404).json({ error: 'العميل غير موجود' });
      }
      
      // Validate that agents can only create invoices for agent customers
      if (isAgentUser && !customer.isAgentCustomer) {
        return res.status(403).json({ error: 'لا يمكنك إنشاء فاتورة لهذا العميل' });
      }
      
      // Validate that regular sales users cannot create invoices for agent customers
      if (!isAgentUser && customer.isAgentCustomer) {
        return res.status(403).json({ error: 'لا يمكنك إنشاء فاتورة لهذا العميل' });
      }
      
      // For agent users, map customer types to agent pricing tiers
      // If pricingTier is explicitly provided, use it; otherwise map customer type
      if (isAgentUser) {
        if (data.pricingTier) {
          // Use provided pricing tier (could be AGENT_WHOLESALE or AGENT_RETAIL)
          pricingTier = data.pricingTier;
        } else {
          // Map customer type to agent pricing tier
          if (customer.type === 'WHOLESALE') {
            pricingTier = 'AGENT_WHOLESALE';
          } else if (customer.type === 'RETAIL') {
            pricingTier = 'AGENT_RETAIL';
          } else {
            // For AGENT customers, default to AGENT_RETAIL
            pricingTier = 'AGENT_RETAIL';
          }
        }
      } else {
        // For non-agent users, use customer type directly
        pricingTier = customer.type;
      }
    } else if (isAgentUser && !data.pricingTier) {
      // If no customer and agent user, default to AGENT_RETAIL
      pricingTier = 'AGENT_RETAIL';
    }

    // Get items with prices (including gift items)
    const itemIds = data.items.map((i) => i.itemId);
    const giftItemIds = data.items
      .filter((i) => i.giftItemId)
      .map((i) => i.giftItemId!)
      .filter((id) => id); // Remove undefined/null values
    
    const allItemIds = [...new Set([...itemIds, ...giftItemIds])]; // Unique item IDs
    
    // Collect all unique tiers that might be used (from pricingTier and item priceTier overrides)
    const allTiers = new Set([pricingTier]);
    data.items.forEach(item => {
      if (item.priceTier) {
        allTiers.add(item.priceTier);
      }
    });

    // For agent users, always include both agent tiers to ensure we have prices
    // Also include legacy 'AGENT' tier for backward compatibility
    if (isAgentUser) {
      allTiers.add('AGENT_RETAIL');
      allTiers.add('AGENT_WHOLESALE');
      allTiers.add('AGENT'); // Legacy tier
    }

    const items = await prisma.item.findMany({
      where: { id: { in: allItemIds } },
      include: {
        prices: {
          where: {
            tier: { in: Array.from(allTiers) as any }, // Fetch prices for all possible tiers
            OR: [
              { inventoryId: data.inventoryId }, // Inventory-specific price
              { inventoryId: null }, // Global price (applies to all inventories)
            ],
          },
          orderBy: [
            { inventoryId: 'desc' }, // Prefer inventory-specific over global (null comes last with desc)
            { validFrom: 'desc' },
          ],
        },
        offers: {
          where: {
            isActive: true,
            validFrom: { lte: new Date() },
            OR: [
              { validTo: null },
              { validTo: { gte: new Date() } },
            ],
          },
          orderBy: { validFrom: 'desc' },
        },
      } as any,
    });

    // Check stock availability for main items (including old gift system where giftQty is same item)
    // Aggregate quantities per item to handle multiple line items with same item
    const itemQuantities: Record<string, number> = {};
    for (const lineItem of data.items) {
      const currentQty = itemQuantities[lineItem.itemId] || 0;
      // For old gift system: giftQty is the same item, so add it to total needed
      const totalNeeded = lineItem.quantity + (lineItem.giftQty || 0);
      itemQuantities[lineItem.itemId] = currentQty + totalNeeded;
    }

    // Check stock for each unique main item (with aggregated quantities including old giftQty)
    for (const [itemId, totalQuantity] of Object.entries(itemQuantities)) {
      const stock = await prisma.inventoryStock.findUnique({
        where: {
          inventoryId_itemId: {
            inventoryId: data.inventoryId,
            itemId: itemId,
          },
        },
      });

      const totalQuantityDecimal = new Prisma.Decimal(totalQuantity);
      if (!stock || stock.quantity.lessThan(totalQuantityDecimal)) {
        const item = items.find((i) => i.id === itemId);
        throw new Error(`الرصيد غير كافٍ للصنف: ${item?.name || itemId}. المطلوب: ${totalQuantity}, المتاح: ${stock?.quantity.toString() || '0'}`);
      }
    }

    // Check stock availability for new gift items (separate gift items)
    // Aggregate gift quantities per gift item to handle multiple offers with same gift
    const giftQuantities: Record<string, number> = {};
    for (const lineItem of data.items) {
      if (lineItem.giftItemId && lineItem.giftQuantity) {
        const currentQty = giftQuantities[lineItem.giftItemId] || 0;
        giftQuantities[lineItem.giftItemId] = currentQty + lineItem.giftQuantity;
      }
    }

    // Check stock for each unique gift item (with aggregated quantities)
    for (const [giftItemId, totalQuantity] of Object.entries(giftQuantities)) {
      const giftStock = await prisma.inventoryStock.findUnique({
        where: {
          inventoryId_itemId: {
            inventoryId: data.inventoryId,
            itemId: giftItemId,
          },
        },
      });

      const totalQuantityDecimal = new Prisma.Decimal(totalQuantity);
      if (!giftStock || giftStock.quantity.lessThan(totalQuantityDecimal)) {
        const giftItem = items.find((i) => i.id === giftItemId);
        throw new Error(`الرصيد غير كافٍ للهدية: ${giftItem?.name || giftItemId}. المطلوب: ${totalQuantity}, المتاح: ${giftStock?.quantity.toString() || '0'}`);
      }
    }

    // Calculate line totals
    const invoiceItems = data.items.map((lineItem) => {
      const item = items.find((i) => i.id === lineItem.itemId);
      if (!item) {
        throw new Error(`الصنف غير موجود: ${lineItem.itemId}`);
      }

      let unitPrice: Prisma.Decimal;
      const itemWithRelations = item as any; // Type assertion needed until Prisma client is regenerated

      // Determine which price tier to use
      let tierToUse = pricingTier as any;
      if (lineItem.priceTier) {
        // Override with explicitly selected price tier (for bakery wholesale offers)
        tierToUse = lineItem.priceTier;
      }

      // Find the price for the selected tier
      if (itemWithRelations.prices && itemWithRelations.prices.length > 0) {
        // First try to find exact tier match
        let matchingPrices = itemWithRelations.prices
          .filter((p: any) => p.tier === tierToUse)
          .filter((p: any) => {
            // Include inventory-specific price OR global price (inventoryId is null)
            return p.inventoryId === data.inventoryId || p.inventoryId === null;
          })
          .sort((a: any, b: any) => {
            // Prefer inventory-specific over global (null comes last)
            if (a.inventoryId && !b.inventoryId) return -1;
            if (!a.inventoryId && b.inventoryId) return 1;
            // Then by validFrom (most recent first)
            return new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime();
          });

        // If no exact match and looking for AGENT_RETAIL or AGENT_WHOLESALE, try legacy 'AGENT' tier
        if (matchingPrices.length === 0 && (tierToUse === 'AGENT_RETAIL' || tierToUse === 'AGENT_WHOLESALE')) {
          matchingPrices = itemWithRelations.prices
            .filter((p: any) => p.tier === 'AGENT')
            .filter((p: any) => {
              // Include inventory-specific price OR global price (inventoryId is null)
              return p.inventoryId === data.inventoryId || p.inventoryId === null;
            })
            .sort((a: any, b: any) => {
              // Prefer inventory-specific over global (null comes last)
              if (a.inventoryId && !b.inventoryId) return -1;
              if (!a.inventoryId && b.inventoryId) return 1;
              // Then by validFrom (most recent first)
              return new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime();
            });
        }

        if (matchingPrices.length > 0) {
          unitPrice = matchingPrices[0].price;
        } else {
          // Debug: log available prices to help diagnose the issue
          const availablePrices = itemWithRelations.prices.map((p: any) => ({
            tier: p.tier,
            inventoryId: p.inventoryId,
            price: p.price.toString(),
            validFrom: p.validFrom
          }));
          console.error(`Price not found for item ${item.name}, tier: ${tierToUse}, inventory: ${data.inventoryId}`);
          console.error('Available prices:', availablePrices);
          throw new Error(`السعر غير متوفر للصنف ${item.name} للفئة ${tierToUse}`);
        }
      } else {
        console.error(`No prices found for item ${item.name}`);
        throw new Error(`السعر غير متوفر للصنف ${item.name}`);
      }

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

router.get('/invoices/:id', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER', 'INVENTORY', 'PROCUREMENT'), async (req: AuthRequest, res) => {
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
    if (req.user?.role === 'INVENTORY' && invoice.paymentConfirmationStatus !== 'CONFIRMED') {
      return res.status(403).json({ error: 'ليس لديك صلاحية للوصول' });
    }

    res.json(invoice);
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/invoices/:id/payments', requireRole('ACCOUNTANT', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'MANAGER'), checkBalanceOpen, createAuditLog('SalesPayment'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const paymentData = paymentSchema.parse(req.body);

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    // Prevent adding payments to rejected invoices
    if (invoice.paymentConfirmationStatus === 'REJECTED') {
      return res.status(400).json({ error: 'لا يمكن إضافة دفعة للفاتورة المرفوضة' });
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

    // Update invoice payment status using utility function
    const paymentStatus = calculatePaymentStatus(newPaidAmount, invoice.total);

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

    if (invoice.paymentConfirmationStatus === 'CONFIRMED') {
      return res.status(400).json({ error: 'الدفع مؤكد بالفعل' });
    }

    if (invoice.paymentConfirmationStatus === 'REJECTED') {
      return res.status(400).json({ error: 'لا يمكن تأكيد الفاتورة المرفوضة' });
    }

    const updatedInvoice = await prisma.salesInvoice.update({
      where: { id },
      data: {
        paymentConfirmationStatus: 'CONFIRMED',
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

router.post('/invoices/:id/reject', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('SalesInvoice'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    // Only allow rejecting invoices that are NOT payment confirmed
    if (invoice.paymentConfirmationStatus === 'CONFIRMED') {
      return res.status(400).json({ error: 'لا يمكن رفض الفاتورة بعد تأكيد الدفع' });
    }

    if (invoice.paymentConfirmationStatus === 'REJECTED') {
      return res.status(400).json({ error: 'الفاتورة مرفوضة بالفعل' });
    }

    const updatedInvoice = await prisma.salesInvoice.update({
      where: { id },
      data: {
        paymentConfirmationStatus: 'REJECTED',
        paymentConfirmedBy: req.user!.id,
        paymentConfirmedAt: new Date(),
        notes: notes ? (invoice.notes ? `${invoice.notes}\n[مرفوضة: ${notes}]` : `[مرفوضة: ${notes}]`) : invoice.notes || '[مرفوضة]',
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
    console.error('Reject invoice error:', error);
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

    if (invoice.paymentConfirmationStatus !== 'CONFIRMED') {
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

    // Update StockMovement records after successful delivery (outside transaction to avoid deadlocks)
    try {
      const { stockMovementService } = await import('../services/stockMovementService');
      const deliveryDate = new Date(); // Use actual delivery timestamp
      
      for (const item of result.invoice.items) {
        // Calculate delivered quantities for this delivery
        const totalQty = new Prisma.Decimal(item.quantity);
        const totalGiftQty = new Prisma.Decimal(item.giftQty || 0);
        
        // Update stock movement for main item (outgoing)
        await stockMovementService.updateStockMovement(
          result.invoice.inventoryId,
          item.itemId,
          deliveryDate,
          {
            outgoing: parseFloat(totalQty.toString()),
            outgoingGifts: parseFloat(totalGiftQty.toString()),
          }
        );
        
        // Update stock movement for gift item if applicable
        if (item.giftItemId && item.giftQuantity) {
          await stockMovementService.updateStockMovement(
            result.invoice.inventoryId,
            item.giftItemId,
            deliveryDate,
            {
              outgoingGifts: parseFloat(item.giftQuantity.toString()),
            }
          );
        }
      }
    } catch (error) {
      console.error('Failed to update stock movements:', error);
      // Don't fail the delivery if stock movement update fails
    }

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

    if (invoice.paymentConfirmationStatus !== 'CONFIRMED') {
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

// Get available batches for invoice items (grouped by expiry date)
router.get('/invoices/:id/delivery-batches', requireRole('INVENTORY', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            item: true,
          },
        },
        deliveries: {
          include: {
            items: {
              include: {
                batches: {
                  include: {
                    batch: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    // Calculate already delivered quantities per item
    const deliveredByItem: Record<string, Prisma.Decimal> = {};
    for (const delivery of invoice.deliveries) {
      for (const deliveryItem of delivery.items) {
        const current = deliveredByItem[deliveryItem.itemId] || new Prisma.Decimal(0);
        deliveredByItem[deliveryItem.itemId] = current.add(deliveryItem.quantity).add(deliveryItem.giftQty);
      }
    }

    // Get available batches for each item, grouped by expiry date
    const itemsWithBatches = await Promise.all(
      invoice.items.map(async (invoiceItem) => {
        const orderedQty = new Prisma.Decimal(invoiceItem.quantity);
        const orderedGift = new Prisma.Decimal(invoiceItem.giftQty);
        const totalOrdered = orderedQty.add(orderedGift);
        const delivered = deliveredByItem[invoiceItem.itemId] || new Prisma.Decimal(0);
        const remaining = totalOrdered.sub(delivered);

        // Get available batches for this item
        const batches = await prisma.stockBatch.findMany({
          where: {
            inventoryId: invoice.inventoryId,
            itemId: invoiceItem.itemId,
            quantity: {
              gt: 0,
            },
          },
          orderBy: [
            { receivedAt: 'asc' },
          ],
        });

        // Sort batches: expiry date (earliest first, nulls last), then received date
        batches.sort((a, b) => {
          if (a.expiryDate && b.expiryDate) {
            const dateDiff = a.expiryDate.getTime() - b.expiryDate.getTime();
            if (dateDiff !== 0) return dateDiff;
          }
          if (a.expiryDate && !b.expiryDate) return -1;
          if (!a.expiryDate && b.expiryDate) return 1;
          return a.receivedAt.getTime() - b.receivedAt.getTime();
        });

        // Group batches by expiry date
        const batchesByExpiry: Record<string, any[]> = {};
        for (const batch of batches) {
          const expiryKey = batch.expiryDate
            ? new Date(batch.expiryDate).toISOString().split('T')[0]
            : 'no-expiry';
          
          if (!batchesByExpiry[expiryKey]) {
            batchesByExpiry[expiryKey] = [];
          }
          
          batchesByExpiry[expiryKey].push({
            id: batch.id,
            quantity: batch.quantity.toString(),
            expiryDate: batch.expiryDate ? new Date(batch.expiryDate).toISOString() : null,
            receivedAt: new Date(batch.receivedAt).toISOString(),
            notes: batch.notes,
          });
        }

        // Convert to array format with expiry date info
        const expiryGroups = Object.entries(batchesByExpiry).map(([expiryKey, batchList]) => {
          const totalQty = batchList.reduce(
            (sum, b) => sum.add(new Prisma.Decimal(b.quantity)),
            new Prisma.Decimal(0)
          );
          
          return {
            expiryDate: expiryKey === 'no-expiry' ? null : expiryKey,
            batches: batchList,
            totalQuantity: totalQty.toString(),
          };
        });

        // Sort expiry groups: earliest expiry first, no-expiry last
        expiryGroups.sort((a, b) => {
          if (!a.expiryDate && !b.expiryDate) return 0;
          if (!a.expiryDate) return 1;
          if (!b.expiryDate) return -1;
          return a.expiryDate.localeCompare(b.expiryDate);
        });

        return {
          itemId: invoiceItem.itemId,
          itemName: invoiceItem.item.name,
          orderedQuantity: orderedQty.toString(),
          orderedGift: orderedGift.toString(),
          totalOrdered: totalOrdered.toString(),
          delivered: delivered.toString(),
          remaining: remaining.toString(),
          expiryGroups,
        };
      })
    );

    res.json({
      invoiceId: id,
      items: itemsWithBatches,
    });
  } catch (error) {
    console.error('Get delivery batches error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

// Sales Reports endpoint
router.get('/reports', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { 
      date,       // Single date for daily report
      startDate,  // Date range start
      endDate,    // Date range end
      period = 'daily', 
      inventoryId, 
      section,
      paymentMethod,
      groupBy = 'date',
      viewType = 'grouped', // 'grouped' for period grouping, 'invoices' for invoice-level
      salesUserRole, // Filter by sales user role (e.g., 'AGENT_GROCERY', 'AGENT_BAKERY')
    } = req.query;

    const where: any = {};
    
    // Date filtering - support single date or date range
    if (date) {
      // Single date - convert to start/end of day
      const singleDate = new Date(date as string);
      const startOfDay = new Date(singleDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(singleDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      where.createdAt = {
        gte: startOfDay,
        lte: endOfDay,
      };
    } else if (startDate && endDate) {
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
    
    // Filter by sales user role (for agent sales filtering)
    if (salesUserRole) {
      const roleFilter = salesUserRole === 'AGENT' 
        ? { in: ['AGENT_GROCERY', 'AGENT_BAKERY'] }
        : salesUserRole;
      
      // Get all users with the specified role(s)
      const usersWithRole = await prisma.user.findMany({
        where: { role: roleFilter as any },
        select: { id: true },
      });
      
      const userIds = usersWithRole.map(u => u.id);
      if (userIds.length > 0) {
        where.salesUserId = { in: userIds };
      } else {
        // No users with this role, return empty result
        where.salesUserId = { in: [] };
      }
    }

    // Get invoices with detailed information - exclude rejected invoices
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        ...where,
        paymentConfirmationStatus: { not: 'REJECTED' },
      },
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
      const invoiceReportData = invoices.map(invoice => {
        // Recalculate payment status to ensure correctness
        const correctPaymentStatus = calculatePaymentStatus(invoice.paidAmount, invoice.total);
        
        return {
        invoiceNumber: invoice.invoiceNumber,
        date: invoice.createdAt,
        customer: invoice.customer?.name || 'بدون عميل',
        inventory: invoice.inventory.name,
        notes: invoice.notes || null,
        total: invoice.total.toString(),
        paidAmount: invoice.paidAmount.toString(),
        outstanding: new Prisma.Decimal(invoice.total).sub(invoice.paidAmount).toString(),
          paymentStatus: correctPaymentStatus,
        deliveryStatus: invoice.deliveryStatus,
        paymentConfirmationStatus: invoice.paymentConfirmationStatus,
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
        };
      });

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
    if (inventoryId && (date || (startDate && endDate))) {
      // Use single date or date range
      let start: Date, end: Date;
      
      if (date) {
        start = new Date(date as string);
      start.setHours(0, 0, 0, 0);
        end = new Date(date as string);
      end.setHours(23, 59, 59, 999);
      } else {
        start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);
      }

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

    // Get item-level stock movement data from database
    // The StockMovement table now stores opening and closing balances for each day
    // For 'items' viewType, always generate item report data if dates are provided
    let itemReportData: any[] = [];
    if (date || (startDate && endDate)) {
      // Determine actual start and end dates
      let actualStart: string, actualEnd: string;
      if (date) {
        actualStart = date as string;
        actualEnd = date as string;
      } else {
        actualStart = startDate as string;
        actualEnd = endDate as string;
      }
      // Get unique inventory IDs from invoices (for non-items viewType)
      const inventoryIds = (viewType !== 'items' && invoices.length > 0)
        ? [...new Set(invoices.map(inv => inv.inventoryId))]
        : [];
      
      // If no invoices but we have inventory filter, use it
      // For 'items' viewType, prioritize inventoryId filter
      let targetInventoryIds: string[] = [];
      
      if (viewType === 'items') {
        // When viewType is 'items', determine which inventories to process
        if (inventoryId) {
          // Use the selected inventory
          targetInventoryIds = [inventoryId as string];
        } else {
          // No inventory filter - get all inventories that have stock movements in the date range
          const start = new Date(actualStart);
          start.setHours(0, 0, 0, 0);
          const end = new Date(actualEnd);
          end.setHours(23, 59, 59, 999);
          
          const movements = await prisma.stockMovement.findMany({
            where: {
              movementDate: {
                gte: start,
                lte: end,
              },
              ...(section && { 
                item: { section: section as any }
              }),
            },
            select: { inventoryId: true },
            distinct: ['inventoryId'],
          });
          targetInventoryIds = movements.map(m => m.inventoryId);
          
          // If no movements found but we have section filter, try to get inventories from InventoryStock
          if (targetInventoryIds.length === 0 && section) {
            const stocks = await prisma.inventoryStock.findMany({
              where: {
                item: { section: section as any }
              },
              select: { inventoryId: true },
              distinct: ['inventoryId'],
            });
            targetInventoryIds = stocks.map(s => s.inventoryId);
          }
        }
      } else {
        // For non-items viewType, use existing logic
        targetInventoryIds = inventoryIds;
        if (inventoryIds.length === 0 && inventoryId) {
          targetInventoryIds = [inventoryId as string];
        } else if (inventoryIds.length === 0) {
          // Get all inventories that have stock movements in the date range
          const start = new Date(actualStart);
          start.setHours(0, 0, 0, 0);
          const end = new Date(actualEnd);
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
      }
      
      // Calculate stockInfo first if not already calculated (for items viewType)
      if (viewType === 'items' && inventoryId && !stockInfo) {
        const start = new Date(actualStart);
        start.setHours(0, 0, 0, 0);
        const end = new Date(actualEnd);
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

        // Get deliveries IN period to calculate opening balance when StockMovement records don't exist
        const deliveries = await prisma.inventoryDelivery.findMany({
          where: {
            invoice: {
              inventoryId: inventoryId as string,
              deliveryStatus: 'DELIVERED',
            },
            deliveredAt: {
              gte: start,
              lte: end,
            },
          },
          include: {
            items: {
              include: { item: true },
            },
          },
        });

        // Get procurement receipts IN period for opening balance calculations
        const receipts = await prisma.inventoryReceipt.findMany({
          where: {
            order: {
              inventoryId: inventoryId as string,
            },
            receivedAt: {
              gte: start,
              lte: end,
            },
          },
          include: {
            order: {
              include: {
                items: true,
              },
            },
          },
        });

        const initialStockByItem: Record<string, number> = {};
        const finalStockByItem: Record<string, number> = {};

        for (const stock of initialStocks) {
          const firstMovement = stockMovements
            .filter(m => m.itemId === stock.itemId)
            .sort((a, b) => a.movementDate.getTime() - b.movementDate.getTime())[0];
          
          if (firstMovement) {
            // Use opening balance from first StockMovement record
            initialStockByItem[stock.itemId] = parseFloat(firstMovement.openingBalance.toString());
          } else {
            // No StockMovement records in period - try to get the last movement BEFORE the period
            const dayBeforeStart = new Date(start);
            dayBeforeStart.setDate(dayBeforeStart.getDate() - 1);
            dayBeforeStart.setHours(23, 59, 59, 999);
            
            const lastMovementBeforePeriod = await prisma.stockMovement.findFirst({
              where: {
                inventoryId: inventoryId as string,
                itemId: stock.itemId,
                movementDate: {
                  lte: dayBeforeStart,
                },
              },
              orderBy: {
                movementDate: 'desc',
              },
            });
            
            if (lastMovementBeforePeriod) {
              // Use closing balance from the last movement before the period as opening balance
              initialStockByItem[stock.itemId] = parseFloat(lastMovementBeforePeriod.closingBalance.toString());
            } else {
              // No movements at all - calculate opening balance from current stock and changes in period
              // Formula: Opening = Current + Outgoing_in_period - Incoming_in_period
              // This works because: Current = Opening + Incoming_in_period - Outgoing_in_period
              const currentStock = parseFloat(stock.quantity.toString());
              
              // Calculate total outgoing from deliveries in the period
              const totalOutgoingFromDeliveries = deliveries.reduce((sum, delivery) => {
                const deliveryItem = delivery.items?.find((di: any) => di.itemId === stock.itemId);
                if (deliveryItem) {
                  return sum + parseFloat(deliveryItem.quantity.toString()) + 
                         parseFloat((deliveryItem.giftQty || 0).toString());
                }
                return sum;
              }, 0);
              
              // Calculate total incoming from procurement receipts in the period
              const totalIncomingFromReceipts = receipts.reduce((sum, receipt) => {
                const receiptItem = receipt.order?.items?.find((i: any) => i.itemId === stock.itemId);
                if (receiptItem) {
                  return sum + parseFloat(receiptItem.quantity.toString());
                }
                return sum;
              }, 0);
              
              // Opening balance = current stock + outgoing in period - incoming in period
              // This reverses the changes that happened in the period to get the opening balance
              const calculatedOpening = currentStock + totalOutgoingFromDeliveries - totalIncomingFromReceipts;
              initialStockByItem[stock.itemId] = calculatedOpening;
            }
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

      for (const invId of targetInventoryIds) {
        const start = new Date(actualStart);
        start.setHours(0, 0, 0, 0);
        const end = new Date(actualEnd);
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

        // Also get deliveries directly if StockMovement records are missing or incomplete
        // This ensures we capture sales even if aggregators haven't run
        const deliveriesWhere: any = {
          invoice: {
            inventoryId: invId,
            deliveryStatus: 'DELIVERED',
          },
          deliveredAt: {
              gte: start,
              lte: end,
          },
        };
        if (section) {
          deliveriesWhere.items = {
            some: {
              item: { section: section as any }
            }
          };
        }
        const deliveries = await prisma.inventoryDelivery.findMany({
          where: deliveriesWhere,
          include: {
            items: {
              include: {
                item: true,
              },
            },
            invoice: {
              include: {
                items: true,
              },
            },
          },
        });

        // Group movements by item
        const movementsByItem: Record<string, typeof stockMovements> = {};
        stockMovements.forEach(movement => {
          if (!movementsByItem[movement.itemId]) {
            movementsByItem[movement.itemId] = [];
          }
          movementsByItem[movement.itemId].push(movement);
        });

        // If we have deliveries but no movements for an item, create synthetic movement data
        // This handles cases where aggregators haven't run yet
        for (const delivery of deliveries) {
          for (const deliveryItem of delivery.items) {
            const itemId = deliveryItem.itemId;
            
            // Filter by section if provided
            if (section && deliveryItem.item.section !== section) {
              continue;
            }
            
            const movementDate = new Date(delivery.deliveredAt);
            movementDate.setHours(0, 0, 0, 0);
            
            // Check if we already have a real movement for this item on this date
            const existingMovement = stockMovements.find(
              m => m.itemId === itemId && 
              m.movementDate.getTime() === movementDate.getTime()
            );
            
            if (!existingMovement) {
              // Create a synthetic movement entry
              if (!movementsByItem[itemId]) {
                movementsByItem[itemId] = [];
              }
              
              // Check if we already added a synthetic movement for this date
              const syntheticMovement = movementsByItem[itemId].find(
                (m: any) => m.isSynthetic && m.movementDate?.getTime() === movementDate.getTime()
              );
              
              if (syntheticMovement) {
                // Add to existing synthetic movement
                const currentOutgoing = typeof syntheticMovement.outgoing === 'object' && 'toString' in syntheticMovement.outgoing
                  ? parseFloat(syntheticMovement.outgoing.toString())
                  : (typeof syntheticMovement.outgoing === 'number' ? syntheticMovement.outgoing : 0);
                const currentGifts = typeof syntheticMovement.outgoingGifts === 'object' && 'toString' in syntheticMovement.outgoingGifts
                  ? parseFloat(syntheticMovement.outgoingGifts.toString())
                  : (typeof syntheticMovement.outgoingGifts === 'number' ? syntheticMovement.outgoingGifts : 0);
                
                syntheticMovement.outgoing = new Prisma.Decimal(currentOutgoing)
                  .add(deliveryItem.quantity);
                syntheticMovement.outgoingGifts = new Prisma.Decimal(currentGifts)
                  .add(deliveryItem.giftQty || 0);
              } else {
                // Create new synthetic movement
                movementsByItem[itemId].push({
                  id: `synthetic-${itemId}-${movementDate.toISOString()}`,
                  inventoryId: invId,
                  itemId: itemId,
                  movementDate: movementDate,
                  openingBalance: new Prisma.Decimal(0), // Will be calculated from first real movement or stock
                  outgoing: deliveryItem.quantity,
                  pendingOutgoing: new Prisma.Decimal(0),
                  incoming: new Prisma.Decimal(0),
                  incomingGifts: new Prisma.Decimal(0),
                  outgoingGifts: deliveryItem.giftQty || new Prisma.Decimal(0),
                  closingBalance: new Prisma.Decimal(0),
                  createdAt: delivery.deliveredAt,
                  updatedAt: delivery.deliveredAt,
                  item: deliveryItem.item,
                  isSynthetic: true,
                } as any);
              }
            }
          }
        }

        // Process each item
        // For 'items' viewType, show all items even if they have no movements
        // For other viewTypes, only show items with activity
        for (const stock of inventoryStocks) {
          const itemMovements = movementsByItem[stock.itemId] || [];
          
          let openingBalance = 0;
          let totalOutgoing = 0;
          let totalOutgoingGifts = 0;
          let totalIncoming = 0;
          let totalIncomingGifts = 0;
          
          if (itemMovements.length > 0) {
            // Sort movements by date
            const sortedMovements = itemMovements.sort((a, b) => {
              const dateA = a.movementDate?.getTime() || 0;
              const dateB = b.movementDate?.getTime() || 0;
              return dateA - dateB;
            });
            
            // Aggregate movements (including synthetic ones) FIRST
            totalOutgoing = sortedMovements.reduce((sum, m) => {
              const outgoing = typeof m.outgoing === 'object' && 'toString' in m.outgoing
                ? parseFloat(m.outgoing.toString())
                : (typeof m.outgoing === 'number' ? m.outgoing : 0);
              const pending = typeof m.pendingOutgoing === 'object' && 'toString' in m.pendingOutgoing
                ? parseFloat(m.pendingOutgoing.toString())
                : (typeof m.pendingOutgoing === 'number' ? m.pendingOutgoing : 0);
              return sum + outgoing + pending;
            }, 0);
            
            totalOutgoingGifts = sortedMovements.reduce((sum, m) => {
              const gifts = typeof m.outgoingGifts === 'object' && 'toString' in m.outgoingGifts
                ? parseFloat(m.outgoingGifts.toString())
                : (typeof m.outgoingGifts === 'number' ? m.outgoingGifts : 0);
              return sum + gifts;
            }, 0);
            
            totalIncoming = sortedMovements.reduce((sum, m) => {
              const incoming = typeof m.incoming === 'object' && 'toString' in m.incoming
                ? parseFloat(m.incoming.toString())
                : (typeof m.incoming === 'number' ? m.incoming : 0);
              return sum + incoming;
            }, 0);
            
            totalIncomingGifts = sortedMovements.reduce((sum, m) => {
              const gifts = typeof m.incomingGifts === 'object' && 'toString' in m.incomingGifts
                ? parseFloat(m.incomingGifts.toString())
                : (typeof m.incomingGifts === 'number' ? m.incomingGifts : 0);
              return sum + gifts;
            }, 0);

            // Get opening balance from first non-synthetic movement, or calculate from stockInfo/current stock
            const firstRealMovement = sortedMovements.find((m: any) => !m.isSynthetic);
            if (firstRealMovement) {
              // Use opening balance from first real StockMovement record
              openingBalance = parseFloat(firstRealMovement.openingBalance.toString());
            } else if (stockInfo && stockInfo.initial && stockInfo.initial[stock.itemId] !== undefined) {
              // Use stockInfo initial if no real movements
              openingBalance = stockInfo.initial[stock.itemId];
            } else {
              // No real movements and no stockInfo - calculate from current stock by reversing the changes
              // Opening balance = current stock + outgoing - incoming
              const currentStock = parseFloat(stock.quantity.toString());
              openingBalance = currentStock + totalOutgoing + totalOutgoingGifts - totalIncoming - totalIncomingGifts;
            }
          } else {
            // No movements in the period - for 'items' viewType, show item with zero values
            // Get opening balance from current stock minus any changes (if stockInfo is available)
            if (viewType === 'items') {
              // For items viewType, use the initial stock from stockInfo if available
              // Otherwise use current stock quantity
              openingBalance = parseFloat(stock.quantity.toString());
              // If stockInfo has initial stock for this item, use it
              if (stockInfo && stockInfo.initial && stockInfo.initial[stock.itemId] !== undefined) {
                openingBalance = stockInfo.initial[stock.itemId];
              }
            } else {
              // For non-items viewType, skip items with no activity
              continue;
            }
          }
          
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
router.get('/reports/daily-by-item', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'INVENTORY', 'MANAGER'), async (req: AuthRequest, res) => {
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

    // Get all invoices for the day - exclude rejected invoices
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        ...where,
        paymentConfirmationStatus: { not: 'REJECTED' },
      },
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

// Fix payment status for all invoices (admin utility endpoint)
router.post('/invoices/fix-payment-status', requireRole('MANAGER'), async (req: AuthRequest, res) => {
  try {
    const invoices = await prisma.salesInvoice.findMany({
      select: {
        id: true,
        paidAmount: true,
        total: true,
        paymentStatus: true,
      },
    });

    let fixed = 0;
    let unchanged = 0;

    for (const invoice of invoices) {
      const correctStatus = calculatePaymentStatus(invoice.paidAmount, invoice.total);
      
      if (invoice.paymentStatus !== correctStatus) {
        await prisma.salesInvoice.update({
          where: { id: invoice.id },
          data: { paymentStatus: correctStatus },
        });
        fixed++;
      } else {
        unchanged++;
      }
    }

    res.json({
      message: 'تم تصحيح حالة الدفع للفواتير',
      fixed,
      unchanged,
      total: invoices.length,
    });
  } catch (error) {
    console.error('Fix payment status error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;


