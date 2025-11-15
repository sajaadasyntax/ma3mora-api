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
  type: z.enum(['WHOLESALE', 'RETAIL', 'AGENT']),
  division: z.enum(['GROCERY', 'BAKERY']),
  isAgentCustomer: z.boolean().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

router.get('/', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { type, division } = req.query;
    const where: any = {};
    
    // Filter customers based on user role
    const user = req.user;
    if (user?.role === 'AGENT_GROCERY' || user?.role === 'AGENT_BAKERY') {
      // Agent users only see agent customers
      where.isAgentCustomer = true;
    } else if (user?.role === 'SALES_GROCERY' || user?.role === 'SALES_BAKERY') {
      // Regular sales users only see non-agent customers
      where.isAgentCustomer = false;
    }
    // ACCOUNTANT, AUDITOR, MANAGER can see all customers
    
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

router.post('/', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'MANAGER'), createAuditLog('Customer'), async (req: AuthRequest, res) => {
  try {
    const data = createCustomerSchema.parse(req.body);
    
    // Automatically set isAgentCustomer based on user role
    const user = req.user;
    const isAgentCustomer = user?.role === 'AGENT_GROCERY' || user?.role === 'AGENT_BAKERY';

    const customer = await prisma.customer.create({
      data: {
        ...data,
        isAgentCustomer: data.isAgentCustomer !== undefined ? data.isAgentCustomer : isAgentCustomer,
      },
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

router.get('/:id', requireRole('SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'ACCOUNTANT', 'AUDITOR', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        salesInvoices: {
          where: {
            paymentConfirmationStatus: { not: 'REJECTED' },
          },
          include: {
            items: {
              include: {
                item: true
              }
            },
            payments: {
              orderBy: { paidAt: 'desc' }
            }
          },
          orderBy: { createdAt: 'desc' },
        },
        openingBalance: {
          where: { isClosed: false },
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

router.put('/:id', requireRole('MANAGER'), createAuditLog('Customer'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = createCustomerSchema.parse(req.body);

    // Check if customer exists
    const existingCustomer = await prisma.customer.findUnique({
      where: { id },
    });

    if (!existingCustomer) {
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    // Update customer
    const customer = await prisma.customer.update({
      where: { id },
      data: {
        name: data.name,
        type: data.type,
        division: data.division,
        phone: data.phone || null,
        address: data.address || null,
        isAgentCustomer: data.isAgentCustomer !== undefined ? data.isAgentCustomer : existingCustomer.isAgentCustomer,
      },
    });

    res.json(customer);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

