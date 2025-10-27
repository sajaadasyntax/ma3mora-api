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

const createCustomerSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['WHOLESALE', 'RETAIL']),
  division: z.enum(['GROCERY', 'BAKERY']),
  phone: z.string().optional(),
  address: z.string().optional(),
});

router.get('/', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { type, division } = req.query;
    const where: any = {};
    
    if (type) where.type = type;
    if (division) where.division = division;

    const customers = await prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    res.json(customers);
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'MANAGER'), createAuditLog('Customer'), async (req: AuthRequest, res) => {
  try {
    const data = createCustomerSchema.parse(req.body);

    const customer = await prisma.customer.create({
      data,
    });

    res.status(201).json(customer);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create customer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/:id', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        salesInvoices: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    res.json(customer);
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

