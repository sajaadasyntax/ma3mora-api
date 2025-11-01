import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';
import { aggregationService } from '../services/aggregationService';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(blockAuditorWrites);

const employeeSchema = z.object({
  name: z.string().min(1, 'الاسم مطلوب'),
  position: z.string().min(1, 'المنصب مطلوب'),
  phone: z.string().optional(),
  address: z.string().optional(),
  salary: z.number().positive('الراتب يجب أن يكون موجب'),
});

const salarySchema = z.object({
  employeeId: z.string().min(1, 'الموظف مطلوب'),
  amount: z.number().positive('المبلغ يجب أن يكون موجب'),
  month: z.number().min(1).max(12, 'الشهر يجب أن يكون بين 1 و 12'),
  year: z.number().min(2020, 'السنة غير صالحة'),
  paymentMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']).default('CASH'),
  notes: z.string().optional(),
});

const advanceSchema = z.object({
  employeeId: z.string().min(1, 'الموظف مطلوب'),
  amount: z.number().positive('المبلغ يجب أن يكون موجب'),
  reason: z.string().min(1, 'السبب مطلوب'),
  paymentMethod: z.enum(['CASH', 'BANK', 'BANK_NILE']).default('CASH'),
  notes: z.string().optional(),
});

// Get all employees
router.get('/', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const employees = await prisma.employee.findMany({
      orderBy: { name: 'asc' },
      include: {
        salaries: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        advances: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
    res.json(employees);
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Create employee
router.post('/', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Employee'), async (req: AuthRequest, res) => {
  try {
    const data = employeeSchema.parse(req.body);
    
    const employee = await prisma.employee.create({
      data: {
        ...data,
        salary: data.salary,
      },
    });
    
    res.status(201).json(employee);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create employee error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Update employee
router.put('/:id', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Employee'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = employeeSchema.parse(req.body);
    
    const employee = await prisma.employee.update({
      where: { id },
      data: {
        ...data,
        salary: data.salary,
      },
    });
    
    res.json(employee);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Update employee error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Delete employee
router.delete('/:id', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Employee'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    await prisma.employee.delete({
      where: { id },
    });
    
    res.json({ message: 'تم حذف الموظف بنجاح' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get employee salaries
router.get('/:id/salaries', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { year, month } = req.query;
    
    const where: any = { employeeId: id };
    if (year) where.year = parseInt(year as string);
    if (month) where.month = parseInt(month as string);
    
    const salaries = await prisma.salary.findMany({
      where,
      include: {
        creator: {
          select: { username: true, role: true },
        },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    
    res.json(salaries);
  } catch (error) {
    console.error('Get salaries error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Create salary
router.post('/salaries', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Salary'), async (req: AuthRequest, res) => {
  try {
    const data = salarySchema.parse(req.body);
    
    const salary = await prisma.salary.create({
      data: {
        ...data,
        amount: data.amount,
        paymentMethod: data.paymentMethod || 'CASH',
        createdBy: req.user!.id,
      },
      include: {
        employee: {
          select: { name: true, position: true },
        },
        creator: {
          select: { username: true, role: true },
        },
      },
    });
    
    res.status(201).json(salary);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create salary error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Pay salary
router.post('/salaries/:id/pay', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Salary'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    const salary = await prisma.salary.update({
      where: { id },
      data: { paidAt: new Date() },
      include: {
        employee: {
          select: { name: true, position: true },
        },
        creator: {
          select: { username: true, role: true },
        },
      },
    });

    // Update aggregates (async, don't block response)
    try {
      if (salary.paidAt) {
        const paymentDate = salary.paidAt;
        const salaryAmount = salary.amount;
        const paymentMethod = (salary as any).paymentMethod || 'CASH';
        const salariesByMethod = {
          CASH: paymentMethod === 'CASH' ? salaryAmount : new Prisma.Decimal(0),
          BANK: paymentMethod === 'BANK' ? salaryAmount : new Prisma.Decimal(0),
          BANK_NILE: paymentMethod === 'BANK_NILE' ? salaryAmount : new Prisma.Decimal(0),
        };

        await aggregationService.updateDailyFinancialAggregate(
          paymentDate,
          {
            salariesTotal: salaryAmount,
            salariesCount: 1,
            salariesCash: salariesByMethod.CASH,
            salariesBank: salariesByMethod.BANK,
            salariesBankNile: salariesByMethod.BANK_NILE,
          }
        );
      }
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }
    
    res.json(salary);
  } catch (error) {
    console.error('Pay salary error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get employee advances
router.get('/:id/advances', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    const advances = await prisma.advance.findMany({
      where: { employeeId: id },
      include: {
        creator: {
          select: { username: true, role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    
    res.json(advances);
  } catch (error) {
    console.error('Get advances error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Create advance
router.post('/advances', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Advance'), async (req: AuthRequest, res) => {
  try {
    const data = advanceSchema.parse(req.body);
    
    const advance = await prisma.advance.create({
      data: {
        ...data,
        amount: data.amount,
        paymentMethod: data.paymentMethod || 'CASH',
        createdBy: req.user!.id,
      },
      include: {
        employee: {
          select: { name: true, position: true },
        },
        creator: {
          select: { username: true, role: true },
        },
      },
    });
    
    res.status(201).json(advance);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create advance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Pay advance
router.post('/advances/:id/pay', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Advance'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    
    const advance = await prisma.advance.update({
      where: { id },
      data: { paidAt: new Date() },
      include: {
        employee: {
          select: { name: true, position: true },
        },
        creator: {
          select: { username: true, role: true },
        },
      },
    });

    // Update aggregates (async, don't block response)
    try {
      if (advance.paidAt) {
        const paymentDate = advance.paidAt;
        const advanceAmount = advance.amount;
        const paymentMethod = (advance as any).paymentMethod || 'CASH';
        const advancesByMethod = {
          CASH: paymentMethod === 'CASH' ? advanceAmount : new Prisma.Decimal(0),
          BANK: paymentMethod === 'BANK' ? advanceAmount : new Prisma.Decimal(0),
          BANK_NILE: paymentMethod === 'BANK_NILE' ? advanceAmount : new Prisma.Decimal(0),
        };

        await aggregationService.updateDailyFinancialAggregate(
          paymentDate,
          {
            advancesTotal: advanceAmount,
            advancesCount: 1,
            advancesCash: advancesByMethod.CASH,
            advancesBank: advancesByMethod.BANK,
            advancesBankNile: advancesByMethod.BANK_NILE,
          }
        );
      }
    } catch (aggError) {
      console.error('Aggregation update error (non-blocking):', aggError);
    }
    
    res.json(advance);
  } catch (error) {
    console.error('Pay advance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
