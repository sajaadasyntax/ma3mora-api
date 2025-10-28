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

const orderItemSchema = z.object({
  itemId: z.string(),
  quantity: z.number().positive(),
  unitCost: z.number().positive(),
});

const createOrderSchema = z.object({
  inventoryId: z.string(),
  section: z.enum(['GROCERY', 'BAKERY']),
  supplierId: z.string(),
  items: z.array(orderItemSchema).min(1),
  notes: z.string().optional(),
});

// Generate order number
async function generateOrderNumber(): Promise<string> {
  const count = await prisma.procOrder.count();
  return `PO-${String(count + 1).padStart(6, '0')}`;
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

    // Calculate line totals
    const orderItems = data.items.map((lineItem) => {
      const lineTotal = new Prisma.Decimal(lineItem.quantity).mul(lineItem.unitCost);

      return {
        itemId: lineItem.itemId,
        quantity: lineItem.quantity,
        unitCost: lineItem.unitCost,
        lineTotal,
      };
    });

    const total = orderItems.reduce(
      (sum, item) => sum.add(item.lineTotal),
      new Prisma.Decimal(0)
    );

    const orderNumber = await generateOrderNumber();

    const order = await prisma.procOrder.create({
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
          },
        },
        supplier: true,
        inventory: true,
      },
    });

    res.status(201).json(order);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
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
        items: true,
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
  refundMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']).optional(),
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

    if (order.status === 'RECEIVED') {
      return res.status(400).json({ error: 'لا يمكن إلغاء أمر شراء مستلم بالفعل' });
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

    res.json(updatedOrder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Cancel procurement order error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const receiveOrderSchema = z.object({
  notes: z.string().optional(),
  partial: z.boolean().optional(),
  batches: z.array(batchItemSchema).optional(), // Optional batches with expiry dates
});

router.post('/orders/:id/receive', requireRole('INVENTORY', 'MANAGER'), createAuditLog('InventoryReceipt'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { notes, partial, batches } = receiveOrderSchema.parse(req.body);

    const order = await prisma.procOrder.findUnique({
      where: { id },
      include: {
        items: true,
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
        // Process batches with expiry dates
        for (const batch of batches) {
          // Verify this item exists in the order
          const orderItem = order.items.find((oi) => oi.itemId === batch.itemId);
          if (!orderItem) {
            throw new Error(`الصنف ${batch.itemId} غير موجود في أمر الشراء`);
          }

          const stock = await tx.inventoryStock.findUnique({
            where: {
              inventoryId_itemId: {
                inventoryId: order.inventoryId,
                itemId: batch.itemId,
              },
            },
          });

          if (!stock) {
            throw new Error(`المخزون غير موجود للصنف ${batch.itemId}`);
          }

          // Include gift quantity in total
          const totalQuantity = new Prisma.Decimal(batch.quantity).add(orderItem.giftQty || 0);

          // Create stock batch with expiry date (including gift quantity)
          await tx.stockBatch.create({
            data: {
              inventoryId: order.inventoryId,
              itemId: batch.itemId,
              quantity: totalQuantity,
              expiryDate: batch.expiryDate ? new Date(batch.expiryDate) : null,
              receiptId: receipt.id,
              notes: batch.notes || (orderItem?.giftQty && orderItem.giftQty.gt(0) ? `يشمل ${orderItem.giftQty.toString()} هدية` : undefined),
            },
          });

          // Update stock quantity (including gift quantity)
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: order.inventoryId,
                itemId: batch.itemId,
              },
            },
            data: {
              quantity: {
                increment: totalQuantity,
              },
            },
          });
        }
      } else {
        // Default behavior: create batches without expiry dates
        for (const item of order.items) {
          const stock = await tx.inventoryStock.findUnique({
            where: {
              inventoryId_itemId: {
                inventoryId: order.inventoryId,
                itemId: item.itemId,
              },
            },
          });

          if (!stock) {
            throw new Error(`المخزون غير موجود للصنف ${item.itemId}`);
          }

          // Create stock batch without expiry date
          await tx.stockBatch.create({
            data: {
              inventoryId: order.inventoryId,
              itemId: item.itemId,
              quantity: item.quantity,
              receiptId: receipt.id,
            },
          });

          // Update stock quantity
          await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: order.inventoryId,
                itemId: item.itemId,
              },
            },
            data: {
              quantity: {
                increment: item.quantity,
              },
            },
          });
        }
      }

      // Update order status
      const updatedOrder = await tx.procOrder.update({
        where: { id },
        data: {
          status: partial ? 'PARTIAL' : 'RECEIVED',
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

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Receive order error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANK', 'BANK_NILE']),
  notes: z.string().optional(),
  receiptUrl: z.string().optional(),
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

    const newPaidAmount = new Prisma.Decimal(order.paidAmount).add(paymentData.amount);

    if (newPaidAmount.greaterThan(order.total)) {
      return res.status(400).json({ error: 'المبلغ المدفوع يتجاوز إجمالي أمر الشراء' });
    }

    const payment = await prisma.procOrderPayment.create({
      data: {
        orderId: id,
        amount: paymentData.amount,
        method: paymentData.method,
        recordedBy: req.user!.id,
        notes: paymentData.notes,
        receiptUrl: paymentData.receiptUrl
      },
    });

    // Update order paid amount
    const updatedOrder = await prisma.procOrder.update({
      where: { id },
      data: {
        paidAmount: newPaidAmount,
      },
      include: {
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

    res.json({ payment, order: updatedOrder });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
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
    if (status) where.status = status;

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

    res.json({
      period,
      data: reportData,
      summary: {
        totalOrders: orders.length,
        totalAmount: orders.reduce((sum, order) => sum + parseFloat(order.total.toString()), 0),
        paidOrders: orders.filter(order => order.paymentConfirmed).length,
        unpaidOrders: orders.filter(order => !order.paymentConfirmed).length,
      },
    });
  } catch (error) {
    console.error('Procurement reports error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

