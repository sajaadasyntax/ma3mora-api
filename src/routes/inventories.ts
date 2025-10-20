import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const inventories = await prisma.inventory.findMany({
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    });
    res.json(inventories);
  } catch (error) {
    console.error('Get inventories error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/:id/stocks', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { section } = req.query;

    const where: any = { inventoryId: id };
    if (section) {
      where.item = { section };
    }

    const stocks = await prisma.inventoryStock.findMany({
      where,
      include: {
        item: {
          include: {
            prices: true,
          },
        },
      },
      orderBy: {
        item: { name: 'asc' },
      },
    });

    res.json(stocks);
  } catch (error) {
    console.error('Get stocks error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

