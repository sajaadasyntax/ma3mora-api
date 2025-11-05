import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(blockAuditorWrites);

const createItemSchema = z.object({
  name: z.string().min(1),
  section: z.enum(['GROCERY', 'BAKERY']),
  wholesalePrice: z.number().positive(),
  retailPrice: z.number().positive(),
  agentPrice: z.number().positive().optional(),
});

const updatePriceSchema = z.object({
  wholesalePrice: z.number().positive().optional(),
  retailPrice: z.number().positive().optional(),
  agentPrice: z.number().positive().optional(),
  inventoryId: z.string().optional(), // If provided, update price for specific inventory
});

router.get('/', async (req: AuthRequest, res) => {
  try {
    const { section } = req.query;
    const where: any = {};
    if (section) {
      where.section = section;
    }

    const items = await prisma.item.findMany({
      where,
      include: {
        prices: {
          include: {
            inventory: true,
          },
          orderBy: { validFrom: 'desc' },
        },
        stocks: {
          include: {
            inventory: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Calculate total stock for each item
    const itemsWithTotalStock = items.map((item) => ({
      ...item,
      totalStock: item.stocks.reduce((sum, stock) => sum + parseFloat(stock.quantity.toString()), 0),
    }));

    res.json(itemsWithTotalStock);
  } catch (error) {
    console.error('Get items error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/', requireRole('PROCUREMENT', 'MANAGER'), createAuditLog('Item'), async (req: AuthRequest, res) => {
  try {
    const { name, section, wholesalePrice, retailPrice, agentPrice } = createItemSchema.parse(req.body);

    const pricesToCreate: Array<{ tier: 'WHOLESALE' | 'RETAIL' | 'AGENT'; price: number }> = [
      { tier: 'WHOLESALE' as const, price: wholesalePrice },
      { tier: 'RETAIL' as const, price: retailPrice },
    ];
    
    // Add agent price if provided, otherwise use retail price as default
    if (agentPrice !== undefined) {
      pricesToCreate.push({ tier: 'AGENT' as const, price: agentPrice });
    } else {
      pricesToCreate.push({ tier: 'AGENT' as const, price: retailPrice });
    }

    const item = await prisma.item.create({
      data: {
        name,
        section,
        prices: {
          create: pricesToCreate,
        },
      },
      include: {
        prices: true,
      },
    });

    // Create stock entries for all inventories
    const inventories = await prisma.inventory.findMany();
    await Promise.all(
      inventories.map((inventory) =>
        prisma.inventoryStock.create({
          data: {
            inventoryId: inventory.id,
            itemId: item.id,
            quantity: 0,
          },
        })
      )
    );

    res.status(201).json(item);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create item error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/:id/prices', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { inventoryId } = req.query;

    const where: any = { itemId: id };
    if (inventoryId) {
      // Get prices for specific inventory OR global prices (inventoryId is null)
      where.OR = [
        { inventoryId: inventoryId as string },
        { inventoryId: null },
      ];
    }

    const prices = await prisma.itemPrice.findMany({
      where,
      include: {
        inventory: true,
      },
      orderBy: { validFrom: 'desc' },
    });

    res.json(prices);
  } catch (error) {
    console.error('Get prices error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/:id/prices', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ItemPrice'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { wholesalePrice, retailPrice, agentPrice, inventoryId } = updatePriceSchema.parse(req.body);

    const updates = [];

    if (wholesalePrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: inventoryId || null, // null means applies to all inventories
            tier: 'WHOLESALE',
            price: wholesalePrice,
          },
        })
      );
    }

    if (retailPrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: inventoryId || null, // null means applies to all inventories
            tier: 'RETAIL',
            price: retailPrice,
          },
        })
      );
    }

    if (agentPrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: inventoryId || null, // null means applies to all inventories
            tier: 'AGENT',
            price: agentPrice,
          },
        })
      );
    }

    const newPrices = await Promise.all(updates);

    res.json(newPrices);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Update prices error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.delete('/:id', requireRole('PROCUREMENT', 'MANAGER'), createAuditLog('Item'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Check if item exists
    const item = await prisma.item.findUnique({
      where: { id },
    });

    if (!item) {
      return res.status(404).json({ error: 'الصنف غير موجود' });
    }

    // Check all inventory stocks for this item
    const stocks = await prisma.inventoryStock.findMany({
      where: { itemId: id },
    });

    // Verify all stocks are 0
    const hasNonZeroStock = stocks.some((stock) => parseFloat(stock.quantity.toString()) !== 0);
    
    if (hasNonZeroStock) {
      return res.status(400).json({ error: 'لا يمكن حذف الصنف. يوجد كمية في المخزون' });
    }

    // Delete in transaction
    await prisma.$transaction(async (tx) => {
      // Delete all prices
      await tx.itemPrice.deleteMany({
        where: { itemId: id },
      });

      // Delete all stock entries
      await tx.inventoryStock.deleteMany({
        where: { itemId: id },
      });

      // Delete the item
      await tx.item.delete({
        where: { id },
      });
    });

    res.json({ message: 'تم حذف الصنف بنجاح' });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

