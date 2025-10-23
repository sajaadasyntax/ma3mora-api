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

router.get('/orders', async (req: AuthRequest, res) => {
  try {
    const { status, inventoryId, section } = req.query;
    const where: any = {};

    if (status) where.status = status;
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    // Procurement users can only see their own orders
    if (req.user?.role === 'PROCUREMENT') {
      where.createdBy = req.user.id;
    }

    // Inventory users can only see payment-confirmed orders
    if (req.user?.role === 'INVENTORY') {
      where.paymentConfirmed = true;
    }

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

router.post('/orders', requireRole('PROCUREMENT'), checkBalanceOpen, createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
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

router.get('/orders/:id', async (req: AuthRequest, res) => {
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
        items: {
          include: {
            item: true,
          },
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

    res.json(order);
  } catch (error) {
    console.error('Get procurement order error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/orders/:id/confirm-payment', requireRole('ACCOUNTANT'), createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
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

router.post('/orders/:id/receive', requireRole('INVENTORY'), createAuditLog('InventoryReceipt'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { notes, partial } = req.body;

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
      // Increase stock
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

      // Create receipt record
      const receipt = await tx.inventoryReceipt.create({
        data: {
          orderId: id,
          receivedBy: req.user!.id,
          notes,
        },
      });

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
    console.error('Receive order error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'خطأ في الخادم' });
  }
});

export default router;

