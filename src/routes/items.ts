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
  agentWholesalePrice: z.number().positive().optional(),
  agentRetailPrice: z.number().positive().optional(),
  agentPrice: z.number().positive().optional(), // Deprecated: kept for backward compatibility
  offer1Price: z.number().positive().optional(), // First offer price (for bakery items)
  offer2Price: z.number().positive().optional(), // Second offer price (for bakery items)
});

const updatePriceSchema = z.object({
  wholesalePrice: z.number().positive().optional(),
  retailPrice: z.number().positive().optional(),
  agentWholesalePrice: z.number().positive().optional(),
  agentRetailPrice: z.number().positive().optional(),
  agentPrice: z.number().positive().optional(), // Deprecated: kept for backward compatibility
  offer1Price: z.number().positive().optional(), // First offer price (for bakery items)
  offer2Price: z.number().positive().optional(), // Second offer price (for bakery items)
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
    const { name, section, wholesalePrice, retailPrice, agentWholesalePrice, agentRetailPrice, agentPrice, offer1Price, offer2Price } = createItemSchema.parse(req.body);

    const pricesToCreate: Array<{ tier: any; price: number }> = [
      { tier: 'WHOLESALE', price: wholesalePrice },
      { tier: 'RETAIL', price: retailPrice },
    ];
    
    // Add agent prices - prioritize new separate prices, fallback to legacy agentPrice
    if (agentWholesalePrice !== undefined) {
      pricesToCreate.push({ tier: 'AGENT_WHOLESALE', price: agentWholesalePrice });
    } else if (agentPrice !== undefined) {
      // Legacy: use agentPrice for both agent tiers if new prices not provided
      pricesToCreate.push({ tier: 'AGENT_WHOLESALE', price: agentPrice });
    } else {
      pricesToCreate.push({ tier: 'AGENT_WHOLESALE', price: wholesalePrice });
    }
    
    if (agentRetailPrice !== undefined) {
      pricesToCreate.push({ tier: 'AGENT_RETAIL', price: agentRetailPrice });
    } else if (agentPrice !== undefined) {
      // Legacy: use agentPrice for both agent tiers if new prices not provided
      pricesToCreate.push({ tier: 'AGENT_RETAIL', price: agentPrice });
    } else {
      pricesToCreate.push({ tier: 'AGENT_RETAIL', price: retailPrice });
    }

    // Add offer prices for bakery items
    if (section === 'BAKERY') {
      if (offer1Price !== undefined) {
        pricesToCreate.push({ tier: 'OFFER_1', price: offer1Price });
      }
      if (offer2Price !== undefined) {
        pricesToCreate.push({ tier: 'OFFER_2', price: offer2Price });
      }
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
    const { wholesalePrice, retailPrice, agentWholesalePrice, agentRetailPrice, agentPrice, offer1Price, offer2Price, inventoryId } = updatePriceSchema.parse(req.body);

    // Verify item exists
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, section: true, name: true },
    });

    if (!item) {
      return res.status(404).json({ error: 'الصنف غير موجود' });
    }

    // Validate that offer prices are only for bakery items
    if ((offer1Price !== undefined || offer2Price !== undefined) && item.section !== 'BAKERY') {
      return res.status(400).json({ error: 'عروض الأسعار متاحة فقط لأصناف الأفران' });
    }

    // Determine which tiers we're updating
    const tiersToUpdate: string[] = [];
    if (wholesalePrice !== undefined) tiersToUpdate.push('WHOLESALE');
    if (retailPrice !== undefined) tiersToUpdate.push('RETAIL');
    if (agentWholesalePrice !== undefined) tiersToUpdate.push('AGENT_WHOLESALE');
    if (agentRetailPrice !== undefined) tiersToUpdate.push('AGENT_RETAIL');
    if (agentPrice !== undefined && agentWholesalePrice === undefined && agentRetailPrice === undefined) {
      tiersToUpdate.push('AGENT_WHOLESALE', 'AGENT_RETAIL');
    }
    if (offer1Price !== undefined) tiersToUpdate.push('OFFER_1');
    if (offer2Price !== undefined) tiersToUpdate.push('OFFER_2');

    if (tiersToUpdate.length === 0) {
      return res.status(400).json({ error: 'لم يتم تحديد أي أسعار للتحديث' });
    }

    // Delete existing prices for the tiers being updated (for this inventoryId or null)
    const targetInventoryId = inventoryId || null;
    await prisma.itemPrice.deleteMany({
      where: {
        itemId: id,
        tier: { in: tiersToUpdate as any },
        inventoryId: targetInventoryId,
      },
    });

    // Create new prices
    const updates = [];

    if (wholesalePrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
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
            inventoryId: targetInventoryId,
            tier: 'RETAIL',
            price: retailPrice,
          },
        })
      );
    }

    if (agentWholesalePrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
            tier: 'AGENT_WHOLESALE' as any,
            price: agentWholesalePrice,
          },
        })
      );
    }

    if (agentRetailPrice !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
            tier: 'AGENT_RETAIL' as any,
            price: agentRetailPrice,
          },
        })
      );
    }

    // Legacy: if agentPrice is provided but new prices are not, use it for both
    if (agentPrice !== undefined && agentWholesalePrice === undefined && agentRetailPrice === undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
            tier: 'AGENT_WHOLESALE' as any,
            price: agentPrice,
          },
        })
      );
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
            tier: 'AGENT_RETAIL' as any,
            price: agentPrice,
          },
        })
      );
    }

    if (offer1Price !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
            tier: 'OFFER_1' as any,
            price: offer1Price,
          },
        })
      );
    }

    if (offer2Price !== undefined) {
      updates.push(
        prisma.itemPrice.create({
          data: {
            itemId: id,
            inventoryId: targetInventoryId,
            tier: 'OFFER_2' as any,
            price: offer2Price,
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error details:', errorMessage);
    res.status(500).json({ 
      error: 'خطأ في الخادم',
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
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

