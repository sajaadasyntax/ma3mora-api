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

router.get('/orders', requireRole('PROCUREMENT', 'ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
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

router.get('/orders/:id', requireRole('PROCUREMENT', 'ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
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

router.post('/orders/:id/confirm-payment', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ProcOrder'), async (req: AuthRequest, res) => {
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

router.post('/orders/:id/receive', requireRole('INVENTORY', 'MANAGER'), createAuditLog('InventoryReceipt'), async (req: AuthRequest, res) => {
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

