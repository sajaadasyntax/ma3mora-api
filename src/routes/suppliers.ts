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

const createSupplierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().optional(),
});

router.get('/', requireRole('PROCUREMENT', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      orderBy: { name: 'asc' },
    });

    res.json(suppliers);
  } catch (error) {
    console.error('Get suppliers error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/', requireRole('PROCUREMENT'), createAuditLog('Supplier'), async (req: AuthRequest, res) => {
  try {
    const data = createSupplierSchema.parse(req.body);

    const supplier = await prisma.supplier.create({
      data,
    });

    res.status(201).json(supplier);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create supplier error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/:id/orders', requireRole('PROCUREMENT', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const orders = await prisma.procOrder.findMany({
      where: { supplierId: id },
      include: {
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
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(orders);
  } catch (error) {
    console.error('Get supplier orders error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

