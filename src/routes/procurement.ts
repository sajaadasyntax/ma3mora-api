import { Router } from 'express';
import { Prisma, CustomerType, Section } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';
import { aggregationService } from '../services/aggregationService';
import { prisma } from '../lib/prisma';

const router = Router();

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

const orderItemSchema = z.object({
  itemId: z.string(),
  quantity: z.number().positive(),
  giftQty: z.number().min(0).default(0).optional(), // Deprecated: kept for backward compatibility
  giftItemId: z.string().optional(), // New: The item being given as gift
  giftQuantity: z.number().min(0).optional(), // New: Quantity of the gift item
  unitCost: z.number().positive(),
}).refine((data) => {
  // Either use old giftQty or new giftItemId/giftQuantity, but not both
  const hasOldGift = data.giftQty !== undefined && data.giftQty > 0;
  const hasNewGift = data.giftItemId && data.giftQuantity && data.giftQuantity > 0;
  return !(hasOldGift && hasNewGift);
}, {
  message: 'لا يمكن استخدام نظام الهدية القديم والجديد معاً',
  path: ['giftItemId'],
});

const createOrderSchema = z.object({
  inventoryId: z.string(),
  section: z.enum(['GROCERY', 'BAKERY']),
  supplierId: z.string(),
  items: z.array(orderItemSchema).min(1),
  notes: z.string().optional(),
});

// Generate order number inside transaction to avoid race conditions
async function generateOrderNumber(tx: any): Promise<string> {
  const lastOrder = await tx.procOrder.findFirst({
    orderBy: { orderNumber: 'desc' },
    select: { orderNumber: true },
  });

  if (lastOrder) {
    const match = lastOrder.orderNumber.match(/PO-(\d+)/);
    if (match) {
      const nextNum = parseInt(match[1], 10) + 1;
      return `PO-${String(nextNum).padStart(6, '0')}`;
    }
  }

  const count = await tx.procOrder.count();
  return `PO-${String(count + 1).padStart(6, '0')}`;
}

// Random 6-digit suffix for PO fallback (collision-resistant, avoids timestamp)
function randomPOFallback(): string {
  return `PO-${String(Math.floor(100000 + Math.random() * 900000))}`;
}

router.get('/orders', requireRole('PROCUREMENT', 'ACCOUNTANT', 'AUDITOR', 'MANAGER', 'INVENTORY'), async (req: AuthRequest, res) => {
  try {
    const { status, inventoryId, section } = req.query;
    const where: any = {};

    // Procurement users can only see their own orders
    if (req.user?.role === 'PROCUREMENT') {
      where.createdBy = req.user.id;
    }

    // Inventory users can only see payment-confirmed orders that are not cancelled
    if (req.user?.role === 'INVENTORY') {
      where.paymentConfirmed = true;
      // If status filter is provided and it's CANCELLED, ignore it for inventory users
      if (status && status !== 'CANCELLED') {
        where.status = status;
      } else if (!status) {
        where.status = { not: 'CANCELLED' };
      }
    } else {
      // For other roles, apply status filter normally
      if (status) where.status = status;
    }

    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    const orders = await prisma.procOrder.findMany({
      where,
      include: {
        supplier: true,
        inventory: true,
        creator: {
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

    res.json(orders);
  } catch (error) {
    console.error('Get procurement orders error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/orders', requireRole('PROCUREMENT', 'MANAGER'), checkBalanceOpen, createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
  try {
    const data = createOrderSchema.parse(req.body);

    // Upfront validation: ensure inventory, supplier, and all items exist before creating order
    const [inventory, supplier, itemsExist] = await Promise.all([
      prisma.inventory.findUnique({ where: { id: data.inventoryId }, select: { id: true } }),
      prisma.supplier.findUnique({ where: { id: data.supplierId }, select: { id: true } }),
      prisma.item.findMany({
        where: { id: { in: data.items.map(i => i.itemId) } },
        select: { id: true },
      }),
    ]);

    if (!inventory) {
      return res.status(400).json({ error: 'المخزن غير موجود' });
    }
    if (!supplier) {
      return res.status(400).json({ error: 'المورد غير موجود' });
    }

    const existingItemIds = new Set(itemsExist.map(i => i.id));
    const missingItemIds = data.items
      .map(i => i.itemId)
      .filter(id => !existingItemIds.has(id));
    if (missingItemIds.length > 0) {
      return res.status(400).json({
        error: 'صنف أو أكثر غير موجود',
        details: missingItemIds,
      });
    }

    // Validate gift items if present
    const giftItemIds = data.items
      .filter(i => i.giftItemId)
      .map(i => i.giftItemId!);
    if (giftItemIds.length > 0) {
      const giftItemsExist = await prisma.item.findMany({
        where: { id: { in: giftItemIds } },
        select: { id: true },
      });
      const existingGiftIds = new Set(giftItemsExist.map(i => i.id));
      const missingGiftIds = giftItemIds.filter(id => !existingGiftIds.has(id));
      if (missingGiftIds.length > 0) {
        return res.status(400).json({
          error: 'صنف الهدية غير موجود',
          details: missingGiftIds,
        });
      }
    }

    // Calculate line totals
    const orderItems = data.items.map((lineItem) => {
      const lineTotal = new Prisma.Decimal(lineItem.quantity).mul(lineItem.unitCost);

      return {
        itemId: lineItem.itemId,
        quantity: lineItem.quantity,
        giftQty: lineItem.giftQty || 0, // Keep for backward compatibility
        giftItemId: lineItem.giftItemId || null,
        giftQuantity: lineItem.giftQuantity ? new Prisma.Decimal(lineItem.giftQuantity) : null,
        unitCost: lineItem.unitCost,
        lineTotal,
      };
    });

    const total = orderItems.reduce(
      (sum, item) => sum.add(item.lineTotal),
      new Prisma.Decimal(0)
    );

    let order!: Awaited<ReturnType<typeof prisma.procOrder.create>>;
    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        order = await prisma.$transaction(async (tx) => {
          const orderNumber = attempt < maxRetries - 1
            ? await generateOrderNumber(tx)
            : randomPOFallback();
          return tx.procOrder.create({
            data: {
              orderNumber,
              inventoryId: data.inventoryId,
              section: data.section,
              createdBy: req.user!.id,
              supplierId: data.supplierId,
              status: 'CREATED',
              total,
              notes: data.notes,
              items: {
                create: orderItems,
              },
            },
            include: {
              items: {
                include: {
                  item: true,
                  giftItem: true, // Include gift item details
                },
              },
              supplier: true,
              inventory: true,
            },
          });
        });
        break;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          if (attempt === maxRetries - 1) {
            throw new Error('فشل في إنشاء رقم طلب فريد بعد محاولات متعددة. يرجى المحاولة مرة أخرى.');
          }
          continue;
        }
        throw error;
      }
    }

    // Update aggregates (async, don't block response)
    try {
      const orderDate = order.createdAt;
      await aggregationService.updateDailyFinancialAggregate(
        orderDate,
        {
          procurementTotal: total,
          procurementDebt: total, // No payment yet
          procurementCount: 1,
        },
        data.inventoryId,
        data.section
      );

      // Update supplier aggregate
      await aggregationService.updateSupplierCumulativeAggregate(
        order.supplierId,
        orderDate,
        {
          totalPurchases: total,
          orderCount: 1,
        }
      );
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }

    res.status(201).json(order);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2003') {
        return res.status(400).json({
          error: 'بيانات مرجعية غير صالحة: المخزن أو المورد أو الصنف غير موجود',
        });
      }
    }
    console.error('Create procurement order error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/orders/:id', requireRole('PROCUREMENT', 'ACCOUNTANT', 'AUDITOR', 'MANAGER', 'INVENTORY'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const order = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
        paymentConfirmedByUser: {
          select: { id: true, username: true },
        },
        refundedByUser: {
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
        returns: {
          include: {
            returnedByUser: {
              select: { id: true, username: true },
            },
          },
          orderBy: { returnedAt: 'desc' },
        },
        receipts: {
          include: {
            receivedByUser: {
              select: { id: true, username: true },
            },
            batches: {
              include: {
                item: true,
              },
            },
          },
          orderBy: { receivedAt: 'desc' },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    // Inventory users can only see payment-confirmed orders
    if (req.user?.role === 'INVENTORY' && !order.paymentConfirmed) {
      return res.status(403).json({ error: 'لا يمكنك الوصول إلى هذا الأمر حتى يتم تأكيد الدفع' });
    }

    // Inventory users cannot see cancelled orders
    if (req.user?.role === 'INVENTORY' && order.status === 'CANCELLED') {
      return res.status(403).json({ error: 'لا يمكنك الوصول إلى أمر شراء ملغي' });
    }

    res.json(order);
  } catch (error) {
    console.error('Get procurement order error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const addGiftsSchema = z.object({
  gifts: z.array(z.object({
    itemId: z.string(),
    giftQty: z.number().min(0),
  })).min(1),
});

// Add gifts to order items (before payment confirmation)
router.post('/orders/:id/add-gifts', requireRole('MANAGER'), createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { gifts } = addGiftsSchema.parse(req.body);

    const order = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            item: true,
            giftItem: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    if (order.paymentConfirmed) {
      return res.status(400).json({ error: 'لا يمكن إضافة هدايا بعد تأكيد الدفع' });
    }

    if (order.status === 'CANCELLED') {
      return res.status(400).json({ error: 'لا يمكن إضافة هدايا لأمر شراء ملغي' });
    }

    if (order.status === 'RECEIVED') {
      return res.status(400).json({ error: 'لا يمكن إضافة هدايا لأمر شراء مستلم بالفعل' });
    }

    // Update gift quantities
    await prisma.$transaction(async (tx) => {
      for (const gift of gifts) {
        const orderItem = order.items.find(item => item.itemId === gift.itemId);
        if (!orderItem) {
          throw new Error(`الصنف ${gift.itemId} غير موجود في أمر الشراء`);
        }

        await tx.procOrderItem.update({
          where: { id: orderItem.id },
          data: {
            giftQty: new Prisma.Decimal(gift.giftQty),
          },
        });
      }
    });

    // Reload order with updated data
    const updatedOrder = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            item: true,
            giftItem: true, // Include gift item details
          },
        },
        supplier: true,
        inventory: true,
      },
    });

    res.json(updatedOrder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Add gifts error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

router.post('/orders/:id/confirm-payment', requireRole('MANAGER'), createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const order = await prisma.procOrder.findUnique({
      where: { id },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    if (order.paymentConfirmed) {
      return res.status(400).json({ error: 'الدفع مؤكد بالفعل' });
    }

    const updatedOrder = await prisma.procOrder.update({
      where: { id },
      data: {
        paymentConfirmed: true,
        paymentConfirmedBy: req.user!.id,
        paymentConfirmedAt: new Date(),
      },
      include: {
        supplier: true,
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
        paymentConfirmedByUser: {
          select: { id: true, username: true },
        },
      },
    });

    res.json(updatedOrder);
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const batchItemSchema = z.object({
  itemId: z.string(),
  quantity: z.number().positive(),
  expiryDate: z.string().optional().nullable(), // ISO date string or null
  notes: z.string().optional(),
});

const cancelOrderSchema = z.object({
  reason: z.string().optional(),
  notes: z.string().optional(),
  refundMethod: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'DEBT', 'OTHERS']).optional(),
  refundAmount: z.number().optional(),
  refundNotes: z.string().optional(),
}).refine((data) => {
  // If refundMethod is provided, refundAmount must also be provided
  if (data.refundMethod && !data.refundAmount) {
    return false;
  }
  return true;
}, {
  message: 'يجب تحديد مبلغ الاسترجاع عند تحديد طريقة الاسترجاع',
  path: ['refundAmount'],
});

// Cancel procurement order (manager can cancel any order) - placed before more specific routes
router.post('/orders/:id/cancel', requireRole('MANAGER'), createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const cancelData = cancelOrderSchema.parse(req.body);

    const order = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        payments: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    if (order.status === 'CANCELLED') {
      return res.status(400).json({ error: 'أمر الشراء ملغي بالفعل' });
    }

    if (order.status === 'RECEIVED' || order.status === 'PARTIAL') {
      return res.status(400).json({ error: 'لا يمكن إلغاء أمر شراء مستلم أو مستلم جزئياً' });
    }

    // Check if order has payments - require refund information
    const hasPayments = order.paidAmount && order.paidAmount.greaterThan(0);
    if (hasPayments) {
      if (!cancelData.refundMethod || !cancelData.refundAmount) {
        return res.status(400).json({ 
          error: 'يجب تحديد طريقة ومبلغ استرجاع المبلغ لأن الأمر مدفوع',
          required: ['refundMethod', 'refundAmount']
        });
      }

      // Validate refund amount matches paid amount (or can be partial)
      if (new Prisma.Decimal(cancelData.refundAmount).greaterThan(order.paidAmount)) {
        return res.status(400).json({ 
          error: `مبلغ الاسترجاع (${cancelData.refundAmount}) أكبر من المبلغ المدفوع (${order.paidAmount})` 
        });
      }
    }

    const updatedOrder = await prisma.procOrder.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        notes: cancelData.notes || cancelData.reason 
          ? `${order.notes || ''}\n[ملغي - ${cancelData.reason || 'بدون سبب'}]`.trim() 
          : order.notes,
        refundMethod: cancelData.refundMethod || null,
        refundAmount: cancelData.refundAmount ? new Prisma.Decimal(cancelData.refundAmount) : null,
        refundNotes: cancelData.refundNotes || null,
        refundedBy: hasPayments ? req.user!.id : null,
        refundedAt: hasPayments ? new Date() : null,
      },
      include: {
        supplier: true,
        inventory: true,
        creator: {
          select: { id: true, username: true },
        },
        refundedByUser: {
          select: { id: true, username: true },
        },
        items: {
          include: {
            item: true,
            giftItem: true,
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
    });

    try {
      const orderTotal = parseFloat(order.total.toString());
      const orderPaid = parseFloat(order.paidAmount.toString());
      await aggregationService.updateDailyFinancialAggregate(order.createdAt, {
        procurementTotal: new Prisma.Decimal(-orderTotal),
        procurementPaid: new Prisma.Decimal(-orderPaid),
        procurementDebt: new Prisma.Decimal(-(orderTotal - orderPaid)),
        procurementCount: -1,
      });

      await aggregationService.updateSupplierCumulativeAggregate(
        order.supplierId,
        order.createdAt,
        {
          totalPurchases: new Prisma.Decimal(-orderTotal),
          totalPaid: new Prisma.Decimal(-orderPaid),
          orderCount: -1,
        }
      );
    } catch (aggError) {
      console.error('Aggregation reversal error:', aggError);
    }

    res.json(updatedOrder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Cancel procurement order error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const extraItemSchema = z.object({
  itemId: z.string(),
  quantity: z.number().positive(),
  isGiftCompensation: z.literal(true),
});

const receiveOrderSchema = z.object({
  notes: z.string().optional(),
  partial: z.boolean().optional(),
  batches: z.array(batchItemSchema).optional(), // Optional batches with expiry dates
  extraItems: z.array(extraItemSchema).optional(), // Extra gift/compensation items added during GRN
});

router.post('/orders/:id/receive', requireRole('INVENTORY', 'MANAGER'), checkBalanceOpen, createAuditLog('InventoryReceipt'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { notes, partial, batches, extraItems } = receiveOrderSchema.parse(req.body);

    const order = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            item: true,
            giftItem: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    if (!order.paymentConfirmed) {
      return res.status(400).json({ error: 'يجب تأكيد الدفع من المحاسب أولاً' });
    }

    if (order.status === 'RECEIVED') {
      return res.status(400).json({ error: 'أمر الشراء مستلم بالفعل' });
    }

    if (order.status === 'CANCELLED') {
      return res.status(400).json({ error: 'أمر الشراء ملغي' });
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      const freshOrder = await tx.procOrder.findUnique({ where: { id }, include: { items: { include: { item: true, giftItem: true } } } });
      if (!freshOrder || freshOrder.status === 'RECEIVED') {
        throw new Error('ALREADY_RECEIVED');
      }

      // Create receipt record
      const receipt = await tx.inventoryReceipt.create({
        data: {
          orderId: id,
          receivedBy: req.user!.id,
          notes,
        },
      });

      // If batches are provided, use them; otherwise create default batches
      if (batches && batches.length > 0) {
        // Aggregate batches by itemId and expiryDate to prevent duplicate increments
        // If same itemId+expiryDate appears multiple times, sum their quantities
        const aggregatedBatches = new Map<string, { itemId: string; quantity: number; expiryDate: string | null; notes?: string }>();
        
        for (const batch of batches) {
          // Normalize expiryDate: empty string, null, or undefined all become 'no-expiry' for aggregation
          // This ensures batches with no expiry date are properly aggregated together
          const normalizedExpiry = (batch.expiryDate && typeof batch.expiryDate === 'string' && batch.expiryDate.trim() !== '') 
            ? batch.expiryDate 
            : 'no-expiry';
          const key = `${batch.itemId}|${normalizedExpiry}`;
          const existing = aggregatedBatches.get(key);
          
          if (existing) {
            // Aggregate quantities for same itemId+expiryDate
            existing.quantity += batch.quantity;
            // Merge notes if both have them
            if (batch.notes && existing.notes) {
              existing.notes = `${existing.notes}, ${batch.notes}`;
            } else if (batch.notes) {
              existing.notes = batch.notes;
            }
          } else {
            aggregatedBatches.set(key, {
              itemId: batch.itemId,
              quantity: batch.quantity,
              expiryDate: batch.expiryDate || null,
              notes: batch.notes,
            });
          }
        }
        
        // Process aggregated batches - skip 0-quantity batches
        for (const batch of aggregatedBatches.values()) {
          // Skip batches with 0 or negative quantity
          if (batch.quantity <= 0) {
            console.log(`Skipping batch with 0 quantity for item ${batch.itemId}`);
            continue;
          }

          // Verify this item exists in the order (either as main item or gift item)
          const orderItem = freshOrder.items.find((oi) => oi.itemId === batch.itemId);
          const giftOrderItem = !orderItem ? freshOrder.items.find((oi) => oi.giftItemId === batch.itemId) : null;
          
          if (!orderItem && !giftOrderItem) {
            throw new Error(`الصنف ${batch.itemId} غير موجود في أمر الشراء`);
          }

          // Determine if this batch is for a gift item or main item
          const isGiftItem = giftOrderItem !== null;
          const actualOrderItem = orderItem || giftOrderItem;

          if (!actualOrderItem) {
            throw new Error(`الصنف ${batch.itemId} غير موجود في أمر الشراء`);
          }

          const stock = await tx.inventoryStock.findUnique({
            where: {
              inventoryId_itemId: {
                inventoryId: freshOrder.inventoryId,
                itemId: batch.itemId,
              },
            },
          });

          if (!stock) {
            throw new Error(`المخزون غير موجود للصنف ${batch.itemId}`);
          }

          // When batches are provided, batch.quantity is the total quantity received
          // (it already includes any gift quantity for the same item in the old system)
          // For gift items (new system), use batch quantity as is
          const totalQuantity = new Prisma.Decimal(batch.quantity);

          // Create stock batch with expiry date
          // For gift items, mark it as a gift. For main items, include old gift quantity note
          const batchNotes = isGiftItem 
            ? (batch.notes ? `${batch.notes} - هدية` : 'هدية')
            : (batch.notes || (orderItem?.giftQty && orderItem.giftQty.gt(0) ? `يشمل ${orderItem.giftQty.toString()} هدية` : undefined));
          
          await tx.stockBatch.create({
            data: {
              inventoryId: freshOrder.inventoryId,
              itemId: batch.itemId,
              quantity: totalQuantity,
              initialQuantity: totalQuantity,
              expiryDate: batch.expiryDate ? new Date(batch.expiryDate) : null,
              receiptId: receipt.id,
              notes: batchNotes,
            },
          });

          // Update stock quantity
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: freshOrder.inventoryId,
                itemId: batch.itemId,
              },
            },
            data: {
              quantity: {
                increment: totalQuantity,
              },
            },
          });

          // Handle gift item (new system - separate item) ONLY if this is not already a gift item batch
          if (!isGiftItem && orderItem && orderItem.giftItemId && orderItem.giftQuantity) {
            // Check if gift item is already processed in aggregated batches (regardless of quantity)
            // This prevents duplicate entries if someone explicitly includes the gift item with any quantity
            const giftBatchExists = Array.from(aggregatedBatches.values()).some((b) => b.itemId === orderItem.giftItemId);
            
            // Only process gift item if it's not in batches (legacy support)
            if (!giftBatchExists) {
              const giftStock = await tx.inventoryStock.findUnique({
                where: {
                  inventoryId_itemId: {
                    inventoryId: freshOrder.inventoryId,
                    itemId: orderItem.giftItemId,
                  },
                },
              });

              if (!giftStock) {
                throw new Error(`المخزون غير موجود للهدية: ${orderItem.giftItemId}`);
              }

              // Create stock batch for gift item (no expiry date for legacy gifts)
              await tx.stockBatch.create({
                data: {
                  inventoryId: freshOrder.inventoryId,
                  itemId: orderItem.giftItemId,
                  quantity: orderItem.giftQuantity,
                  initialQuantity: orderItem.giftQuantity,
                  receiptId: receipt.id,
                  notes: 'هدية',
                },
              });

              // Update stock quantity for gift item
              await tx.inventoryStock.update({
                where: {
                  inventoryId_itemId: {
                    inventoryId: freshOrder.inventoryId,
                    itemId: orderItem.giftItemId,
                  },
                },
                data: {
                  quantity: {
                    increment: orderItem.giftQuantity,
                  },
                },
              });
            }
          }
        }
      } else {
        // Default behavior: create batches without expiry dates
        for (const item of freshOrder.items) {
          const stock = await tx.inventoryStock.findUnique({
            where: {
              inventoryId_itemId: {
                inventoryId: freshOrder.inventoryId,
                itemId: item.itemId,
              },
            },
          });

          if (!stock) {
            throw new Error(`المخزون غير موجود للصنف ${item.itemId}`);
          }

          // Include gift quantity (old system - same item)
          const totalQuantity = new Prisma.Decimal(item.quantity).add(item.giftQty || 0);

          // Create stock batch without expiry date
          await tx.stockBatch.create({
            data: {
              inventoryId: freshOrder.inventoryId,
              itemId: item.itemId,
              quantity: totalQuantity,
              initialQuantity: totalQuantity,
              receiptId: receipt.id,
              notes: item.giftQty && item.giftQty.gt(0) ? `يشمل ${item.giftQty.toString()} هدية` : undefined,
            },
          });

          // Update stock quantity
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: freshOrder.inventoryId,
                itemId: item.itemId,
              },
            },
            data: {
              quantity: {
                increment: totalQuantity,
              },
            },
          });

          // Handle gift item (new system - separate item)
          if (item.giftItemId && item.giftQuantity) {
            const giftStock = await tx.inventoryStock.findUnique({
              where: {
                inventoryId_itemId: {
                  inventoryId: freshOrder.inventoryId,
                  itemId: item.giftItemId,
                },
              },
            });

            if (!giftStock) {
              throw new Error(`المخزون غير موجود للهدية: ${item.giftItemId}`);
            }

            // Create stock batch for gift item
            await tx.stockBatch.create({
              data: {
                inventoryId: freshOrder.inventoryId,
                itemId: item.giftItemId,
                quantity: item.giftQuantity,
                initialQuantity: item.giftQuantity,
                receiptId: receipt.id,
                notes: 'هدية',
              },
            });

            // Update stock quantity for gift item
            await tx.inventoryStock.update({
              where: {
                inventoryId_itemId: {
                  inventoryId: freshOrder.inventoryId,
                  itemId: item.giftItemId,
                },
              },
              data: {
                quantity: {
                  increment: item.giftQuantity,
                },
              },
            });
          }
        }
      }

      // Process extra gift/compensation items
      if (extraItems && extraItems.length > 0) {
        for (const extra of extraItems) {
          // Create ProcOrderItem with isGiftCompensation=true
          await tx.procOrderItem.create({
            data: {
              orderId: id,
              itemId: extra.itemId,
              quantity: extra.quantity,
              unitCost: 0,
              lineTotal: 0,
              isGiftCompensation: true,
            },
          });

          // Ensure stock record exists
          const extraStock = await tx.inventoryStock.findUnique({
            where: {
              inventoryId_itemId: {
                inventoryId: freshOrder.inventoryId,
                itemId: extra.itemId,
              },
            },
          });

          if (!extraStock) {
            throw new Error(`المخزون غير موجود للصنف ${extra.itemId}`);
          }

          const extraQty = new Prisma.Decimal(extra.quantity);

          // Create stock batch for extra gift/compensation item
          await tx.stockBatch.create({
            data: {
              inventoryId: freshOrder.inventoryId,
              itemId: extra.itemId,
              quantity: extraQty,
              initialQuantity: extraQty,
              receiptId: receipt.id,
              notes: 'هدية/تعويض',
            },
          });

          // Update stock quantity
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: freshOrder.inventoryId,
                itemId: extra.itemId,
              },
            },
            data: {
              quantity: {
                increment: extraQty,
              },
            },
          });
        }
      }

      // Calculate received quantities from all receipts using initialQuantity
      // (initialQuantity preserves original received amount; quantity changes with sales)
      const receivedByItem: Record<string, Prisma.Decimal> = {};
      const allReceipts = await tx.inventoryReceipt.findMany({
        where: { orderId: id },
        include: { batches: true },
      });
      
      for (const r of allReceipts) {
        for (const b of r.batches) {
          const key = b.itemId;
          const qty = new Prisma.Decimal(b.initialQuantity ?? b.quantity);
          receivedByItem[key] = (receivedByItem[key] || new Prisma.Decimal(0)).add(qty);
        }
      }

      // Over-receiving guard: ensure received qty doesn't exceed 150% of ordered qty
      for (const it of freshOrder.items) {
        if ((it as any).isGiftCompensation) continue;
        const orderedQty = new Prisma.Decimal(it.quantity);
        const totalReceived = receivedByItem[it.itemId] || new Prisma.Decimal(0);
        if (totalReceived.greaterThan(orderedQty.mul(1.5))) {
          throw new Error(`الكمية المستلمة للصنف ${it.item.name} تتجاوز الحد الأقصى المسموح (150%)`);
        }
      }

      // Check if all items are fully received
      let allFullyReceived = true;
      const receivedTotals: Prisma.Decimal[] = [];
      for (const it of freshOrder.items) {
        // For old system: giftQty is a separate quantity that needs to be received
        // The total ordered is quantity + giftQty (both need to be received)
        const orderedMain = new Prisma.Decimal(it.quantity).add(it.giftQty || 0);
        const receivedMain = receivedByItem[it.itemId] || new Prisma.Decimal(0);
        receivedTotals.push(receivedMain);
        if (receivedMain.lessThan(orderedMain)) {
          allFullyReceived = false;
        }

        // Check new system gift items
        if (it.giftItemId && it.giftQuantity) {
          const orderedGift = new Prisma.Decimal(it.giftQuantity);
          const receivedGift = receivedByItem[it.giftItemId] || new Prisma.Decimal(0);
          receivedTotals.push(receivedGift);
          if (receivedGift.lessThan(orderedGift)) {
            allFullyReceived = false;
          }
        }
      }

      // Determine status:
      // - If all items fully received with any positive receipt qty: RECEIVED
      // - If some qty received but not all: PARTIAL
      // - If no quantities received at all (e.g., empty receipt): CREATED
      const hasPositiveReceipt = receivedTotals.some(total => total.gt(0));
      let newStatus: 'CREATED' | 'PARTIAL' | 'RECEIVED';
      if (allFullyReceived && hasPositiveReceipt) {
        newStatus = 'RECEIVED';
      } else if (hasPositiveReceipt) {
        newStatus = 'PARTIAL';
      } else {
        newStatus = 'CREATED';
      }

      // Update order status based on actual received quantities
      const updatedOrder = await tx.procOrder.update({
        where: { id },
        data: {
          status: newStatus,
        },
        include: {
          items: {
            include: {
              item: true,
            },
          },
          supplier: true,
        },
      });

      return { receipt, order: updatedOrder };
    });

    // Update StockMovement records after successful receipt (outside transaction to avoid deadlocks)
    try {
      const { stockMovementService } = await import('../services/stockMovementService');
      const receiptDate = new Date();

      // Query actual received quantities from this receipt's batches
      const receiptBatches = await prisma.stockBatch.findMany({
        where: { receiptId: result.receipt.id },
      });
      const receivedByItem: Record<string, number> = {};
      for (const batch of receiptBatches) {
        const qty = parseFloat(batch.quantity.toString());
        receivedByItem[batch.itemId] = (receivedByItem[batch.itemId] || 0) + qty;
      }

      for (const item of result.order.items) {
        if ((item as any).isGiftCompensation) continue;

        const actualReceived = receivedByItem[item.itemId] || 0;
        if (actualReceived > 0) {
          const giftQty = parseFloat((item.giftQty || 0).toString());
          await stockMovementService.updateStockMovement(
            result.order.inventoryId,
            item.itemId,
            receiptDate,
            {
              incoming: Math.max(0, actualReceived - giftQty),
              incomingGifts: Math.min(giftQty, actualReceived),
            }
          );
        }

        // Update stock movement for gift item if applicable (new system)
        if (item.giftItemId && item.giftQuantity) {
          const giftReceived = receivedByItem[item.giftItemId] || 0;
          if (giftReceived > 0) {
            await stockMovementService.updateStockMovement(
              result.order.inventoryId,
              item.giftItemId,
              receiptDate,
              {
                incomingGifts: giftReceived,
              }
            );
          }
        }
      }
    } catch (error) {
      console.error('Failed to update stock movements:', error);
    }

    // Update StockMovement records for extra gift/compensation items
    if (extraItems && extraItems.length > 0) {
      try {
        const { stockMovementService } = await import('../services/stockMovementService');
        const extraReceiptDate = new Date();

        for (const extra of extraItems) {
          await stockMovementService.updateStockMovement(
            result.order.inventoryId,
            extra.itemId,
            extraReceiptDate,
            {
              incomingGifts: extra.quantity,
            }
          );

          // Set movementType to INBOUND_GIFT on the stock movement record
          const movementDate = new Date(extraReceiptDate);
          movementDate.setHours(0, 0, 0, 0);
          await prisma.stockMovement.update({
            where: {
              inventoryId_itemId_movementDate: {
                inventoryId: result.order.inventoryId,
                itemId: extra.itemId,
                movementDate,
              },
            },
            data: {
              movementType: 'INBOUND_GIFT',
            },
          });
        }
      } catch (error) {
        console.error('Failed to update stock movements for extra items:', error);
        // Don't fail the receipt if stock movement update fails
      }
    }

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    if (error instanceof Error && error.message === 'ALREADY_RECEIVED') {
      return res.status(400).json({ error: 'أمر الشراء مستلم بالفعل' });
    }
    console.error('Receive order error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'COMMISSION', 'DEBT', 'OTHERS']),
  notes: z.string().optional(),
  receiptUrl: z.string().optional(),
  receiptNumber: z.string().optional(),
}).refine((data) => {
  // COMMISSION, DEBT and OTHERS don't need receipt number
  if (data.method !== 'CASH' && data.method !== 'COMMISSION' && data.method !== 'DEBT' && data.method !== 'OTHERS' && !data.receiptNumber) {
    return false;
  }
  return true;
}, {
  message: 'رقم الإيصال مطلوب لطرق الدفع البنكية',
  path: ['receiptNumber'],
});

// Add payment to procurement order
router.post('/orders/:id/payments', requireRole('MANAGER'), checkBalanceOpen, createAuditLog('ProcOrderPayment'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const paymentData = paymentSchema.parse(req.body);

    const order = await prisma.procOrder.findUnique({
      where: { id },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    if (order.status === 'CANCELLED') {
      return res.status(400).json({ error: 'لا يمكن الدفع لأمر شراء ملغي' });
    }

    const newPaidAmount = new Prisma.Decimal(order.paidAmount).add(paymentData.amount);

    if (newPaidAmount.greaterThan(order.total)) {
      return res.status(400).json({ error: 'المبلغ المدفوع يتجاوز إجمالي أمر الشراء' });
    }

    // Enforce cross-app unique receiptNumber if provided
    if (paymentData.receiptNumber) {
      // Check existing in procurement payments
      const existingProcPay = await prisma.procOrderPayment.findFirst({
        where: { receiptNumber: paymentData.receiptNumber },
        include: {
          order: {
            include: { supplier: true },
          },
          recordedByUser: {
            select: { id: true, username: true },
          },
        },
      });
      if (existingProcPay) {
        return res.status(400).json({
          error: 'رقم الإيصال مستخدم بالفعل في دفعة مشتريات',
          existingTransaction: {
            id: existingProcPay.id,
            orderId: existingProcPay.orderId,
            supplier: existingProcPay.order.supplier.name,
            amount: existingProcPay.amount.toString(),
            method: existingProcPay.method,
            receiptNumber: existingProcPay.receiptNumber,
            receiptUrl: existingProcPay.receiptUrl,
            paidAt: existingProcPay.paidAt,
            recordedBy: existingProcPay.recordedByUser.username,
            notes: existingProcPay.notes,
          },
        });
      }

      // Check existing in sales payments
      const existingSalesPayment = await prisma.salesPayment.findUnique({
        where: { receiptNumber: paymentData.receiptNumber as any },
        include: {
          invoice: { include: { customer: true } },
          recordedByUser: { select: { id: true, username: true } },
        },
      });
      if (existingSalesPayment) {
        return res.status(400).json({
          error: 'رقم الإيصال مستخدم بالفعل في دفعة مبيعات',
          existingTransaction: {
            id: existingSalesPayment.id,
            invoiceId: existingSalesPayment.invoiceId,
            invoiceNumber: (existingSalesPayment as any).invoice.invoiceNumber,
            customer: (existingSalesPayment as any).invoice.customer.name,
            amount: existingSalesPayment.amount.toString(),
            method: existingSalesPayment.method,
            receiptNumber: (existingSalesPayment as any).receiptNumber,
            receiptUrl: existingSalesPayment.receiptUrl,
            paidAt: existingSalesPayment.paidAt,
            recordedBy: (existingSalesPayment as any).recordedByUser.username,
            notes: existingSalesPayment.notes,
          },
        });
      }

      // Check existing in cash exchanges
      const existingExchange = await (prisma as any).cashExchange.findUnique({
        where: { receiptNumber: paymentData.receiptNumber },
        include: {
          createdByUser: { select: { id: true, username: true } },
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
          },
        });
      }
    }

    // Ensure sufficient balance for selected method before paying
    // Opening balances (open cashbox only)
    const openingBalances = await prisma.openingBalance.findMany({ where: { scope: 'CASHBOX', isClosed: false } });
    const openingByMethod: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: openingBalances.filter((b: any) => b.paymentMethod === 'CASH').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
      BANKAK: openingBalances.filter((b: any) => b.paymentMethod === 'BANKAK').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
      BANK_NILE: openingBalances.filter((b: any) => b.paymentMethod === 'BANK_NILE').reduce((s, b) => s.add(b.amount), new Prisma.Decimal(0)),
    };

    // Sales payments inflow (only confirmed invoices)
    const confirmedInvoiceIds = (await prisma.salesInvoice.findMany({
      where: { paymentConfirmationStatus: 'CONFIRMED' } as any,
      select: { id: true },
    })).map(i => i.id);
    const salesPays = await prisma.salesPayment.findMany({ where: { invoiceId: { in: confirmedInvoiceIds } } });
    const salesIn: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: salesPays.filter(p => p.method === 'CASH').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
      BANKAK: salesPays.filter(p => p.method === 'BANKAK').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
      BANK_NILE: salesPays.filter(p => p.method === 'BANK_NILE').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    };

    // Existing procurement payments out (only confirmed orders)
    const procPays = await prisma.procOrderPayment.findMany({ where: { order: { paymentConfirmed: true } } });
  // Commission payments are already paid by suppliers as gift, so they don't subtract from liquid assets
  const procOut: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
    CASH: procPays.filter(p => p.method === 'CASH').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    BANKAK: procPays.filter(p => p.method === 'BANKAK').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    BANK_NILE: procPays.filter(p => p.method === 'BANK_NILE').reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0)),
    // COMMISSION payments are excluded - they don't subtract from liquid assets
  };

    // Expenses out - exclude debts from balance calculation
    const expenses = await prisma.expense.findMany();
    const expOut: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: expenses.filter(e => e.method === 'CASH' && !e.isDebt).reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
      BANKAK: expenses.filter(e => e.method === 'BANKAK' && !e.isDebt).reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
      BANK_NILE: expenses.filter(e => e.method === 'BANK_NILE' && !e.isDebt).reduce((s, e) => s.add(e.amount), new Prisma.Decimal(0)),
    };

    // Salaries & advances out
    const paidSalaries = await prisma.salary.findMany({ where: { paidAt: { not: null } } });
    const paidAdvances = await prisma.advance.findMany({ where: { paidAt: { not: null } } });
    const salOut: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: paidSalaries.filter((s: any) => s.paymentMethod === 'CASH').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANKAK: paidSalaries.filter((s: any) => s.paymentMethod === 'BANKAK').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANK_NILE: paidSalaries.filter((s: any) => s.paymentMethod === 'BANK_NILE').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
    };
    const advOut: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: paidAdvances.filter((a: any) => a.paymentMethod === 'CASH').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANKAK: paidAdvances.filter((a: any) => a.paymentMethod === 'BANKAK').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANK_NILE: paidAdvances.filter((a: any) => a.paymentMethod === 'BANK_NILE').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
    };

    // Income in - exclude debts from balance calculation
    const income = await prisma.income.findMany();
    const incomeIn: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: income.filter(i => i.method === 'CASH' && !i.isDebt).reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0)),
      BANKAK: income.filter(i => i.method === 'BANKAK' && !i.isDebt).reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0)),
      BANK_NILE: income.filter(i => i.method === 'BANK_NILE' && !i.isDebt).reduce((s, i) => s.add(i.amount), new Prisma.Decimal(0)),
    };

    // Cash exchanges impact
    const exchanges = await prisma.cashExchange.findMany();
    const exImpact: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = { CASH: new Prisma.Decimal(0), BANKAK: new Prisma.Decimal(0), BANK_NILE: new Prisma.Decimal(0) };
    exchanges.forEach((e) => {
      const fromMethod = e.fromMethod as 'CASH'|'BANKAK'|'BANK_NILE';
      const toMethod = e.toMethod as 'CASH'|'BANKAK'|'BANK_NILE';
      exImpact[fromMethod] = exImpact[fromMethod].sub(e.amount);
      exImpact[toMethod] = exImpact[toMethod].add(e.amount);
    });

    const available: Record<'CASH'|'BANKAK'|'BANK_NILE', Prisma.Decimal> = {
      CASH: openingByMethod.CASH.add(salesIn.CASH).add(incomeIn.CASH).add(exImpact.CASH).sub(expOut.CASH).sub(salOut.CASH).sub(advOut.CASH).sub(procOut.CASH),
      BANKAK: openingByMethod.BANKAK.add(salesIn.BANKAK).add(incomeIn.BANKAK).add(exImpact.BANKAK).sub(expOut.BANKAK).sub(salOut.BANKAK).sub(advOut.BANKAK).sub(procOut.BANKAK),
      BANK_NILE: openingByMethod.BANK_NILE.add(salesIn.BANK_NILE).add(incomeIn.BANK_NILE).add(exImpact.BANK_NILE).sub(expOut.BANK_NILE).sub(salOut.BANK_NILE).sub(advOut.BANK_NILE).sub(procOut.BANK_NILE),
    };

    // COMMISSION, DEBT, and OTHERS don't need balance check - not liquid asset methods
    if (paymentData.method !== 'COMMISSION' && paymentData.method !== 'DEBT' && paymentData.method !== 'OTHERS') {
      const method = paymentData.method as 'CASH'|'BANKAK'|'BANK_NILE';
      if (available[method].lessThan(paymentData.amount)) {
        return res.status(400).json({ error: 'الرصيد غير كافٍ لطريقة الدفع المحددة' });
      }
    }

    const { payment, updatedOrder } = await prisma.$transaction(async (tx) => {
      const txPayment = await tx.procOrderPayment.create({
        data: {
          orderId: id,
          amount: paymentData.amount,
          method: paymentData.method,
          recordedBy: req.user!.id,
          notes: paymentData.notes,
          receiptUrl: paymentData.receiptUrl,
          receiptNumber: paymentData.receiptNumber || null,
        },
      });

      const txUpdatedOrder = await tx.procOrder.update({
        where: { id },
        data: { paidAmount: newPaidAmount },
        include: {
          payments: {
            include: { recordedByUser: { select: { id: true, username: true } } },
            orderBy: { paidAt: 'desc' },
          },
          supplier: true,
        },
      });

      return { payment: txPayment, updatedOrder: txUpdatedOrder };
    });

    // Update aggregates (async, don't block response)
    try {
      const paymentDate = payment.paidAt;
      const paymentAmount = new Prisma.Decimal(paymentData.amount);
      const procurementPaidByMethod = {
        CASH: paymentData.method === 'CASH' ? paymentAmount : new Prisma.Decimal(0),
        BANKAK: paymentData.method === 'BANKAK' ? paymentAmount : new Prisma.Decimal(0),
        BANK_NILE: paymentData.method === 'BANK_NILE' ? paymentAmount : new Prisma.Decimal(0),
        DEBT: paymentData.method === 'DEBT' ? paymentAmount : new Prisma.Decimal(0),
        OTHERS: (paymentData.method === 'OTHERS' || paymentData.method === 'COMMISSION') ? paymentAmount : new Prisma.Decimal(0),
      };

      await aggregationService.updateDailyFinancialAggregate(
        paymentDate,
        {
          procurementPaid: paymentAmount,
          procurementDebt: paymentAmount.neg(),
          procurementCash: procurementPaidByMethod.CASH,
          procurementBank: procurementPaidByMethod.BANKAK,
          procurementBankNile: procurementPaidByMethod.BANK_NILE,
          procurementDebtMethod: procurementPaidByMethod.DEBT,
          procurementOthers: procurementPaidByMethod.OTHERS,
        },
        order.inventoryId,
        order.section
      );

      // Update supplier aggregate
      await aggregationService.updateSupplierCumulativeAggregate(
        order.supplierId,
        paymentDate,
        {
          totalPaid: paymentAmount,
          purchasesCash: procurementPaidByMethod.CASH,
          purchasesBank: procurementPaidByMethod.BANKAK,
          purchasesBankNile: procurementPaidByMethod.BANK_NILE,
        }
      );
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }

    res.json({ payment, order: updatedOrder });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'رقم الإيصال مستخدم بالفعل' });
      }
    }
    console.error('Create procurement payment error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const returnSchema = z.object({
  reason: z.string().min(1, 'السبب مطلوب'),
  notes: z.string().optional(),
});

// Return procurement order (only if not paid)
router.post('/orders/:id/return', requireRole('MANAGER'), createAuditLog('ProcOrderReturn'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const returnData = returnSchema.parse(req.body);

    const order = await prisma.procOrder.findUnique({
      where: { id },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    // Check if order is already paid
    if (order.paidAmount.greaterThan(0)) {
      return res.status(400).json({ error: 'لا يمكن إرجاع أمر الشراء بعد الدفع' });
    }

    // Check if order is already returned
    const existingReturn = await prisma.procOrderReturn.findFirst({
      where: { orderId: id },
    });

    if (existingReturn) {
      return res.status(400).json({ error: 'تم إرجاع هذا الأمر مسبقاً' });
    }

    const orderReturn = await prisma.procOrderReturn.create({
      data: {
        orderId: id,
        reason: returnData.reason,
        returnedBy: req.user!.id,
        notes: returnData.notes,
      },
      include: {
        returnedByUser: {
          select: { id: true, username: true },
        },
      },
    });

    res.status(201).json(orderReturn);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Return procurement order error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Procurement Reports endpoint
router.get('/reports', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      period = 'daily', 
      inventoryId, 
      section,
      status,
      groupBy = 'date'
    } = req.query;

    const where: any = {};
    
    // Date filtering
    if (startDate && endDate) {
      const endDateObj = new Date(endDate as string);
      endDateObj.setHours(23, 59, 59, 999);
      where.createdAt = {
        gte: new Date(startDate as string),
        lte: endDateObj,
      };
    } else if (startDate) {
      where.createdAt = {
        gte: new Date(startDate as string),
      };
    } else if (endDate) {
      const endDateObj = new Date(endDate as string);
      endDateObj.setHours(23, 59, 59, 999);
      where.createdAt = {
        lte: endDateObj,
      };
    }

    // Additional filters
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;
    
    // Exclude cancelled orders by default (unless status filter explicitly requests them)
    if (status) {
      where.status = status;
    } else {
      where.status = { not: 'CANCELLED' };
    }

    // Get orders with detailed information
    const orders = await prisma.procOrder.findMany({
      where,
      include: {
        supplier: true,
        inventory: true,
        creator: {
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

    // Group data based on period
    let groupedData: any = {};
    
    if (period === 'daily') {
      orders.forEach(order => {
        const date = order.createdAt.toISOString().split('T')[0];
        if (!groupedData[date]) {
          groupedData[date] = {
            date,
            orders: [],
            totalAmount: 0,
            orderCount: 0,
            statuses: {},
            suppliers: {},
            items: {},
          };
        }
        
        groupedData[date].orders.push(order);
        groupedData[date].totalAmount += parseFloat(order.total.toString());
        groupedData[date].orderCount += 1;
        
        // Group by status
        const status = order.status;
        if (!groupedData[date].statuses[status]) {
          groupedData[date].statuses[status] = {
            count: 0,
            amount: 0,
          };
        }
        groupedData[date].statuses[status].count += 1;
        groupedData[date].statuses[status].amount += parseFloat(order.total.toString());
        
        // Group by suppliers
        const supplierName = order.supplier.name;
        if (!groupedData[date].suppliers[supplierName]) {
          groupedData[date].suppliers[supplierName] = {
            count: 0,
            amount: 0,
          };
        }
        groupedData[date].suppliers[supplierName].count += 1;
        groupedData[date].suppliers[supplierName].amount += parseFloat(order.total.toString());
        
        // Group by items
        order.items.forEach(item => {
          const itemName = item.item.name;
          if (!groupedData[date].items[itemName]) {
            groupedData[date].items[itemName] = {
              quantity: 0,
              totalAmount: 0,
              unitCost: parseFloat(item.unitCost.toString()),
            };
          }
          groupedData[date].items[itemName].quantity += parseFloat(item.quantity.toString());
          groupedData[date].items[itemName].totalAmount += parseFloat(item.lineTotal.toString());
        });
      });
    } else if (period === 'monthly') {
      orders.forEach(order => {
        const month = order.createdAt.toISOString().substring(0, 7); // YYYY-MM
        if (!groupedData[month]) {
          groupedData[month] = {
            month,
            orders: [],
            totalAmount: 0,
            orderCount: 0,
            statuses: {},
            suppliers: {},
            items: {},
          };
        }
        
        groupedData[month].orders.push(order);
        groupedData[month].totalAmount += parseFloat(order.total.toString());
        groupedData[month].orderCount += 1;
        
        // Group by status
        const status = order.status;
        if (!groupedData[month].statuses[status]) {
          groupedData[month].statuses[status] = {
            count: 0,
            amount: 0,
          };
        }
        groupedData[month].statuses[status].count += 1;
        groupedData[month].statuses[status].amount += parseFloat(order.total.toString());
        
        // Group by suppliers
        const supplierName = order.supplier.name;
        if (!groupedData[month].suppliers[supplierName]) {
          groupedData[month].suppliers[supplierName] = {
            count: 0,
            amount: 0,
          };
        }
        groupedData[month].suppliers[supplierName].count += 1;
        groupedData[month].suppliers[supplierName].amount += parseFloat(order.total.toString());
        
        // Group by items
        order.items.forEach(item => {
          const itemName = item.item.name;
          if (!groupedData[month].items[itemName]) {
            groupedData[month].items[itemName] = {
              quantity: 0,
              totalAmount: 0,
              unitCost: parseFloat(item.unitCost.toString()),
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

      // Get initial stock
      const initialStocks = await prisma.inventoryStock.findMany({
        where: { inventoryId: inventoryId as string },
        include: { item: true },
      });

      // Get stock movements
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

    res.json({
      period,
      data: reportData,
      summary: {
        totalOrders: orders.length,
        totalAmount: orders.reduce((sum, order) => sum + parseFloat(order.total.toString()), 0),
        paidOrders: orders.filter(order => order.paymentConfirmed).length,
        unpaidOrders: orders.filter(order => !order.paymentConfirmed).length,
      },
      ...(stockInfo && { stockInfo }),
    });
  } catch (error) {
    console.error('Procurement reports error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Assign partial procurement as fully received (no stock changes), validates full quantities received
router.post('/orders/:id/assign-delivered', requireRole('INVENTORY', 'MANAGER'), createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const order = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        items: {
          include: { item: true, giftItem: true },
        },
        receipts: {
          include: { batches: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'أمر الشراء غير موجود' });
    }

    if (!order.paymentConfirmed) {
      return res.status(400).json({ error: 'يجب تأكيد الدفع أولاً' });
    }

    if (order.status === 'CANCELLED') {
      return res.status(400).json({ error: 'أمر الشراء ملغي' });
    }

    if (order.status === 'RECEIVED') {
      return res.status(400).json({ error: 'أمر الشراء مستلم بالفعل' });
    }

    // Sum received quantities by itemId using initialQuantity
    // (initialQuantity preserves original received amount; quantity changes with sales)
    const receivedByItem: Record<string, Prisma.Decimal> = {};
    for (const r of order.receipts) {
      for (const b of r.batches) {
        const key = b.itemId;
        const qty = new Prisma.Decimal(b.initialQuantity ?? b.quantity);
        receivedByItem[key] = (receivedByItem[key] || new Prisma.Decimal(0)).add(qty);
      }
    }

    // Validate that each ordered item (and its gift item if any) is fully received
    const errors: string[] = [];
    for (const it of order.items) {
      // For old system: giftQty is a separate quantity that needs to be received
      // The total ordered is quantity + giftQty (both need to be received)
      const orderedMain = new Prisma.Decimal(it.quantity).add(it.giftQty || 0);
      const receivedMain = receivedByItem[it.itemId] || new Prisma.Decimal(0);
      if (receivedMain.lessThan(orderedMain)) {
        const pending = orderedMain.sub(receivedMain);
        errors.push(`${it.item.name}: متبقي ${pending.toString()}`);
      }

      if (it.giftItemId && it.giftQuantity) {
        const orderedGift = new Prisma.Decimal(it.giftQuantity);
        const receivedGift = receivedByItem[it.giftItemId] || new Prisma.Decimal(0);
        if (receivedGift.lessThan(orderedGift)) {
          const pendingGift = orderedGift.sub(receivedGift);
          errors.push(`${it.giftItem?.name || it.giftItemId} (هدية): متبقي ${pendingGift.toString()}`);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'لا يمكن التعيين كمستلم كامل قبل اكتمال الاستلام', details: errors });
    }

    const updated = await prisma.procOrder.update({
      where: { id },
      data: { status: 'RECEIVED' },
      include: {
        supplier: true,
        inventory: true,
        items: { include: { item: true, giftItem: true } },
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Assign delivered error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PO vs. GRN Variance Report
router.get('/reports/po-vs-grn', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { dateFrom, dateTo, inventoryId, section } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'dateFrom و dateTo مطلوبان' });
    }

    const endDate = new Date(dateTo as string);
    endDate.setHours(23, 59, 59, 999);
    const where: any = {
      status: { in: ['RECEIVED', 'PARTIAL'] },
      createdAt: {
        gte: new Date(dateFrom as string),
        lte: endDate,
      },
    };
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    const orders = await prisma.procOrder.findMany({
      where,
      include: {
        supplier: true,
        inventory: true,
        items: {
          include: { item: true },
        },
        receipts: {
          include: { batches: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows: any[] = [];
    let grandTotalOrdered = 0;
    let grandTotalReceived = 0;
    let grandTotalGiftComp = 0;

    for (const order of orders) {
      // Aggregate received quantities per item using initialQuantity
      // (initialQuantity preserves original received amount; quantity changes with sales)
      const totalReceivedByItem: Record<string, number> = {};
      for (const receipt of order.receipts) {
        for (const batch of receipt.batches) {
          const qty = parseFloat((batch.initialQuantity ?? batch.quantity).toString());
          totalReceivedByItem[batch.itemId] = (totalReceivedByItem[batch.itemId] || 0) + qty;
        }
      }

      // Separate received quantities per (itemId, isGiftCompensation) to prevent
      // double-counting when the same item appears as both regular and gift/compensation
      const giftQtyByItemId: Record<string, number> = {};
      for (const item of order.items) {
        if ((item as any).isGiftCompensation) {
          giftQtyByItemId[item.itemId] = (giftQtyByItemId[item.itemId] || 0) + parseFloat(item.quantity.toString());
        }
      }

      const receivedByItemType: Record<string, number> = {};
      for (const [itemId, totalReceived] of Object.entries(totalReceivedByItem)) {
        const giftOrdered = giftQtyByItemId[itemId] || 0;
        if (giftOrdered > 0) {
          const giftReceived = Math.min(giftOrdered, totalReceived);
          receivedByItemType[`${itemId}:gift`] = giftReceived;
          receivedByItemType[`${itemId}:regular`] = totalReceived - giftReceived;
        } else {
          receivedByItemType[`${itemId}:regular`] = totalReceived;
        }
      }

      for (const item of order.items) {
        const ordered = parseFloat(item.quantity.toString());
        const isGift = (item as any).isGiftCompensation === true;
        const key = `${item.itemId}:${isGift ? 'gift' : 'regular'}`;
        const received = receivedByItemType[key] || 0;
        const variance = isGift ? received : received - ordered;
        const giftCompQty = isGift ? received : 0;

        rows.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          supplierName: order.supplier.name,
          inventoryName: order.inventory.name,
          section: order.section,
          orderDate: order.createdAt,
          status: order.status,
          itemId: item.itemId,
          itemName: item.item.name,
          orderedQty: isGift ? 0 : ordered,
          receivedQty: received,
          variance,
          giftCompensationQty: giftCompQty,
          isGiftCompensation: isGift,
          unitCost: parseFloat(item.unitCost.toString()),
          lineTotal: parseFloat(item.lineTotal.toString()),
        });

        if (!isGift) {
          grandTotalOrdered += ordered;
        }
        grandTotalReceived += received;
        if (isGift) {
          grandTotalGiftComp += received;
        }
      }
    }

    res.json({
      rows,
      grandTotal: {
        totalOrdered: grandTotalOrdered,
        totalReceived: grandTotalReceived,
        totalVariance: grandTotalReceived - grandTotalOrdered,
        totalGiftCompensation: grandTotalGiftComp,
        orderCount: orders.length,
      },
    });
  } catch (error) {
    console.error('PO vs GRN report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Purchases by Category Report
router.get('/reports/by-category', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'dateFrom و dateTo مطلوبان' });
    }

    const endDate = new Date(dateTo as string);
    endDate.setHours(23, 59, 59, 999);
    const where: any = {
      status: { not: 'CANCELLED' },
      createdAt: {
        gte: new Date(dateFrom as string),
        lte: endDate,
      },
    };

    const orders = await prisma.procOrder.findMany({
      where,
      include: {
        items: {
          include: { item: true },
        },
      },
    });

    const categoryMap: Record<string, { totalAmount: number; itemCount: number; orderCount: number }> = {};

    for (const order of orders) {
      const cat = order.section; // GROCERY or BAKERY
      if (!categoryMap[cat]) {
        categoryMap[cat] = { totalAmount: 0, itemCount: 0, orderCount: 0 };
      }
      categoryMap[cat].orderCount += 1;
      categoryMap[cat].totalAmount += parseFloat(order.total.toString());

      for (const item of order.items) {
        if (!(item as any).isGiftCompensation) {
          categoryMap[cat].itemCount += parseFloat(item.quantity.toString());
        }
      }
    }

    const rows = Object.entries(categoryMap).map(([category, data]) => ({
      category,
      totalAmount: data.totalAmount,
      itemCount: data.itemCount,
      orderCount: data.orderCount,
    }));

    const grandTotal = {
      totalAmount: rows.reduce((sum, r) => sum + r.totalAmount, 0),
      totalItemCount: rows.reduce((sum, r) => sum + r.itemCount, 0),
      totalOrderCount: rows.reduce((sum, r) => sum + r.orderCount, 0),
    };

    res.json({ rows, grandTotal });
  } catch (error) {
    console.error('Purchases by category report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/** Pick WHOLESALE / RETAIL list prices for an inventory (جملة / تفصيل reference). */
function pickWholesaleRetailPrices(
  prices: { tier: CustomerType; price: Prisma.Decimal; inventoryId: string | null }[],
  inventoryId: string
) {
  const matchInv = (p: { inventoryId: string | null }) =>
    p.inventoryId === inventoryId || p.inventoryId === null;
  const wholesale = prices.find((p) => p.tier === CustomerType.WHOLESALE && matchInv(p));
  const retail = prices.find((p) => p.tier === CustomerType.RETAIL && matchInv(p));
  return {
    wholesalePrice: wholesale ? parseFloat(wholesale.price.toString()) : null,
    retailPrice: retail ? parseFloat(retail.price.toString()) : null,
  };
}

function pickWholesaleRetailFirst(
  prices: { tier: CustomerType; price: Prisma.Decimal; inventoryId: string | null }[]
) {
  const wholesale = prices.find((p) => p.tier === CustomerType.WHOLESALE);
  const retail = prices.find((p) => p.tier === CustomerType.RETAIL);
  return {
    wholesalePrice: wholesale ? parseFloat(wholesale.price.toString()) : null,
    retailPrice: retail ? parseFloat(retail.price.toString()) : null,
  };
}

// Detailed purchases for one specific item
router.get('/reports/item-purchases', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { itemId, dateFrom, dateTo, inventoryId } = req.query;

    if (!itemId || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'itemId و dateFrom و dateTo مطلوبة' });
    }

    const start = new Date(dateFrom as string);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateTo as string);
    end.setHours(23, 59, 59, 999);

    const orderWhere: Prisma.ProcOrderWhereInput = {
      status: { not: 'CANCELLED' },
      createdAt: { gte: start, lte: end },
      ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
    };

    const lines = await prisma.procOrderItem.findMany({
      where: {
        itemId: itemId as string,
        order: orderWhere,
      },
      include: {
        order: {
          include: {
            supplier: true,
            inventory: true,
            creator: { select: { username: true } },
          },
        },
        item: { include: { prices: true } },
      },
      orderBy: { order: { createdAt: 'desc' } },
    });

    const item = await prisma.item.findUnique({
      where: { id: itemId as string },
      include: { prices: true },
    });

    if (!item) {
      return res.status(404).json({ error: 'الصنف غير موجود' });
    }

    const mainLines = lines.filter((l) => !l.isGiftCompensation);
    const totalQuantity = mainLines.reduce((s, l) => s + parseFloat(l.quantity.toString()), 0);
    const totalAmount = mainLines.reduce((s, l) => s + parseFloat(l.lineTotal.toString()), 0);
    const orderIds = new Set(lines.map((l) => l.orderId));

    const detailRows = lines.map((l) => {
      const invId = l.order.inventoryId;
      const { wholesalePrice, retailPrice } = pickWholesaleRetailPrices(l.item.prices, invId);
      return {
        lineId: l.id,
        orderId: l.orderId,
        orderNumber: l.order.orderNumber,
        orderDate: l.order.createdAt.toISOString(),
        supplierName: l.order.supplier.name,
        warehouseName: l.order.inventory.name,
        inventoryId: invId,
        quantity: parseFloat(l.quantity.toString()),
        giftQty: l.giftQty ? parseFloat(l.giftQty.toString()) : 0,
        unitCost: parseFloat(l.unitCost.toString()),
        lineTotal: parseFloat(l.lineTotal.toString()),
        paymentConfirmed: l.order.paymentConfirmed,
        orderStatus: l.order.status,
        isGiftCompensation: l.isGiftCompensation,
        wholesalePrice,
        retailPrice,
        createdBy: l.order.creator?.username ?? null,
      };
    });

    res.json({
      item: {
        id: item.id,
        name: item.name,
        section: item.section,
      },
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      summary: {
        totalQuantity,
        totalAmount,
        lineCount: mainLines.length,
        orderCount: orderIds.size,
      },
      lines: detailRows,
    });
  } catch (error) {
    console.error('Item purchases report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Purchases by section (BAKERY or GROCERY): جملة (summary per item) + تفصيل (each line)
router.get('/reports/section-by-items', requireRole('ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { section, dateFrom, dateTo, inventoryId } = req.query;

    if (!section || !dateFrom || !dateTo) {
      return res.status(400).json({ error: 'section و dateFrom و dateTo مطلوبة' });
    }

    const sec = section as string;
    if (sec !== Section.BAKERY && sec !== Section.GROCERY) {
      return res.status(400).json({ error: 'section يجب أن يكون BAKERY أو GROCERY' });
    }

    const start = new Date(dateFrom as string);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dateTo as string);
    end.setHours(23, 59, 59, 999);

    const orderWhere: Prisma.ProcOrderWhereInput = {
      status: { not: 'CANCELLED' },
      section: sec as Section,
      createdAt: { gte: start, lte: end },
      ...(inventoryId ? { inventoryId: inventoryId as string } : {}),
    };

    const lines = await prisma.procOrderItem.findMany({
      where: {
        order: orderWhere,
      },
      include: {
        order: {
          include: {
            supplier: true,
            inventory: true,
            creator: { select: { username: true } },
          },
        },
        item: { include: { prices: true } },
      },
      orderBy: [{ order: { createdAt: 'desc' } }, { item: { name: 'asc' } }],
    });

    const summaryMap = new Map<
      string,
      {
        itemId: string;
        itemName: string;
        totalQuantity: number;
        totalAmount: number;
        lineCount: number;
        orderIds: Set<string>;
      }
    >();

    for (const l of lines) {
      if (l.isGiftCompensation) continue;

      const id = l.itemId;
      const qty = parseFloat(l.quantity.toString());
      const amt = parseFloat(l.lineTotal.toString());

      if (!summaryMap.has(id)) {
        summaryMap.set(id, {
          itemId: id,
          itemName: l.item.name,
          totalQuantity: 0,
          totalAmount: 0,
          lineCount: 0,
          orderIds: new Set(),
        });
      }
      const row = summaryMap.get(id)!;
      row.totalQuantity += qty;
      row.totalAmount += amt;
      row.lineCount += 1;
      row.orderIds.add(l.orderId);
    }

    const itemIds = [...summaryMap.keys()];
    const itemsForPrices = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: { prices: true },
    });
    const priceByItemId = new Map(itemsForPrices.map((it) => [it.id, it.prices]));

    const summary = [...summaryMap.values()]
      .map((r) => {
        const prices = priceByItemId.get(r.itemId) ?? [];
        const listPrices = inventoryId
          ? pickWholesaleRetailPrices(prices, inventoryId as string)
          : pickWholesaleRetailFirst(prices);
        const avgUnitCost = r.totalQuantity > 0 ? r.totalAmount / r.totalQuantity : 0;
        return {
          itemId: r.itemId,
          itemName: r.itemName,
          totalQuantity: r.totalQuantity,
          totalAmount: r.totalAmount,
          avgUnitCost,
          lineCount: r.lineCount,
          orderCount: r.orderIds.size,
          wholesalePrice: listPrices.wholesalePrice,
          retailPrice: listPrices.retailPrice,
        };
      })
      .sort((a, b) => a.itemName.localeCompare(b.itemName, 'ar'));

    const details = lines.map((l) => {
      const invId = l.order.inventoryId;
      const { wholesalePrice, retailPrice } = pickWholesaleRetailPrices(l.item.prices, invId);
      return {
        lineId: l.id,
        orderNumber: l.order.orderNumber,
        orderDate: l.order.createdAt.toISOString(),
        supplierName: l.order.supplier.name,
        warehouseName: l.order.inventory.name,
        inventoryId: invId,
        itemId: l.itemId,
        itemName: l.item.name,
        quantity: parseFloat(l.quantity.toString()),
        giftQty: l.giftQty ? parseFloat(l.giftQty.toString()) : 0,
        unitCost: parseFloat(l.unitCost.toString()),
        lineTotal: parseFloat(l.lineTotal.toString()),
        paymentConfirmed: l.order.paymentConfirmed,
        orderStatus: l.order.status,
        isGiftCompensation: l.isGiftCompensation,
        wholesalePrice,
        retailPrice,
        createdBy: l.order.creator?.username ?? null,
      };
    });

    const nonGift = lines.filter((l) => !l.isGiftCompensation);
    const grandTotals = {
      totalQuantity: nonGift.reduce((s, l) => s + parseFloat(l.quantity.toString()), 0),
      totalAmount: nonGift.reduce((s, l) => s + parseFloat(l.lineTotal.toString()), 0),
      lineCount: nonGift.length,
    };

    res.json({
      section: sec,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      summary,
      details,
      grandTotals,
    });
  } catch (error) {
    console.error('Section by items report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

