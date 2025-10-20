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
});

const updatePriceSchema = z.object({
  wholesalePrice: z.number().positive().optional(),
  retailPrice: z.number().positive().optional(),
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

router.post('/', requireRole('PROCUREMENT'), createAuditLog('Item'), async (req: AuthRequest, res) => {
  try {
    const { name, section, wholesalePrice, retailPrice } = createItemSchema.parse(req.body);

    const item = await prisma.item.create({
      data: {
        name,
        section,
        prices: {
          create: [
            { tier: 'WHOLESALE', price: wholesalePrice },
            { tier: 'RETAIL', price: retailPrice },
          ],
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

    const prices = await prisma.itemPrice.findMany({
      where: { itemId: id },
      orderBy: { validFrom: 'desc' },
    });

    res.json(prices);
  } catch (error) {
    console.error('Get prices error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/:id/prices', requireRole('ACCOUNTANT'), createAuditLog('ItemPrice'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { wholesalePrice, retailPrice } = updatePriceSchema.parse(req.body);

    const updates = [];

    if (wholesalePrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
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
            tier: 'RETAIL',
            price: retailPrice,
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

router.delete('/:id', requireRole('PROCUREMENT'), createAuditLog('Item'), async (req: AuthRequest, res) => {
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

