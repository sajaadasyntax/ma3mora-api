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

// ─── Schemas ────────────────────────────────────────────────────────────────

const createSalesDepositSchema = z.object({
  customerId: z.string().min(1),
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANKAK', 'BANK_NILE']),
  description: z.string().optional(),
});

const createRecoveredLoanSchema = z.object({
  entityName: z.string().min(1),
  entityType: z.enum(['PERSONAL', 'BUSINESS']),
  amount: z.number().positive(),
  method: z.enum(['CASH', 'BANKAK', 'BANK_NILE']),
  description: z.string().optional(),
});

// ─── POST /sales-deposits — Record sales deposit (advance payment) ──────────

router.post(
  '/sales-deposits',
  requireRole('ACCOUNTANT', 'MANAGER'),
  createAuditLog('SalesDeposit'),
  async (req: AuthRequest, res) => {
    try {
      const data = createSalesDepositSchema.parse(req.body);

      // Verify customer exists
      const customer = await prisma.customer.findUnique({
        where: { id: data.customerId },
      });

      if (!customer) {
        return res.status(404).json({ error: 'العميل غير موجود' });
      }

      const amountDecimal = new Prisma.Decimal(data.amount);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Create deposit and update aggregate in a transaction
      const deposit = await prisma.$transaction(async (tx) => {
        // 1. Create the SalesDeposit record
        const newDeposit = await tx.salesDeposit.create({
          data: {
            customerId: data.customerId,
            amount: amountDecimal,
            method: data.method,
            description: data.description || null,
            createdBy: req.user!.id,
          },
          include: {
            customer: true,
            creator: {
              select: { id: true, username: true },
            },
          },
        });

        // 2. Update CustomerCumulativeAggregate for today
        //    Decrease totalOutstanding, increase totalAccountPayments
        const previousAggregate = await tx.customerCumulativeAggregate.findFirst({
          where: {
            customerId: data.customerId,
            date: { lte: today },
          },
          orderBy: { date: 'desc' },
        });

        const totalInvoices = previousAggregate?.totalInvoices || 0;
        const totalSales = previousAggregate?.totalSales || new Prisma.Decimal(0);
        const totalPaid = (previousAggregate?.totalPaid || new Prisma.Decimal(0)).add(amountDecimal);
        const totalOutstanding = totalSales.sub(totalPaid);
        const totalAccountPayments = (previousAggregate?.totalAccountPayments || new Prisma.Decimal(0)).add(amountDecimal);

        const salesCash = previousAggregate?.salesCash || new Prisma.Decimal(0);
        const salesBank = previousAggregate?.salesBank || new Prisma.Decimal(0);
        const salesBankNile = previousAggregate?.salesBankNile || new Prisma.Decimal(0);
        const salesDebtMethod = previousAggregate?.salesDebtMethod || new Prisma.Decimal(0);
        const salesOthers = previousAggregate?.salesOthers || new Prisma.Decimal(0);

        await tx.customerCumulativeAggregate.upsert({
          where: {
            customerId_date: {
              customerId: data.customerId,
              date: today,
            },
          },
          update: {
            totalPaid,
            totalOutstanding,
            totalAccountPayments,
          },
          create: {
            customerId: data.customerId,
            date: today,
            totalInvoices,
            totalSales,
            totalPaid,
            totalOutstanding,
            totalAccountPayments,
            salesCash,
            salesBank,
            salesBankNile,
            salesDebtMethod,
            salesOthers,
          },
        });

        return newDeposit;
      });

      res.status(201).json(deposit);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Create sales deposit error:', error);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  }
);

// ─── GET /sales-deposits — List sales deposits ──────────────────────────────

router.get('/sales-deposits', async (req: AuthRequest, res) => {
  try {
    const { customerId, dateFrom, dateTo } = req.query;

    const where: any = {};
    if (customerId) where.customerId = customerId as string;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    const deposits = await prisma.salesDeposit.findMany({
      where,
      include: {
        customer: true,
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate grand total
    const grandTotal = deposits.reduce(
      (sum, d) => sum.add(d.amount),
      new Prisma.Decimal(0)
    );

    res.json({ deposits, grandTotal: grandTotal.toString() });
  } catch (error) {
    console.error('List sales deposits error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─── POST /recovered-loans — Record recovered loan ──────────────────────────

router.post(
  '/recovered-loans',
  requireRole('ACCOUNTANT', 'MANAGER'),
  createAuditLog('RecoveredLoan'),
  async (req: AuthRequest, res) => {
    try {
      const data = createRecoveredLoanSchema.parse(req.body);

      const amountDecimal = new Prisma.Decimal(data.amount);

      const loan = await prisma.recoveredLoan.create({
        data: {
          entityName: data.entityName,
          entityType: data.entityType,
          amount: amountDecimal,
          method: data.method,
          description: data.description || null,
          createdBy: req.user!.id,
        },
        include: {
          creator: {
            select: { id: true, username: true },
          },
        },
      });

      res.status(201).json(loan);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Create recovered loan error:', error);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  }
);

// ─── GET /recovered-loans — List recovered loans ────────────────────────────

router.get('/recovered-loans', async (req: AuthRequest, res) => {
  try {
    const { entityType, dateFrom, dateTo } = req.query;

    const where: any = {};
    if (entityType) where.entityType = entityType as string;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom as string);
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    const loans = await prisma.recoveredLoan.findMany({
      where,
      include: {
        creator: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate grand total
    const grandTotal = loans.reduce(
      (sum, l) => sum.add(l.amount),
      new Prisma.Decimal(0)
    );

    res.json({ loans, grandTotal: grandTotal.toString() });
  } catch (error) {
    console.error('List recovered loans error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
