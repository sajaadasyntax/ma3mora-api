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
  paymentMethod: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'DEBT', 'OTHERS']).default('CASH'),
  notes: z.string().optional(),
});

const advanceSchema = z.object({
  employeeId: z.string().min(1, 'الموظف مطلوب'),
  amount: z.number().positive('المبلغ يجب أن يكون موجب'),
  reason: z.string().min(1, 'السبب مطلوب'),
  paymentMethod: z.enum(['CASH', 'BANKAK', 'BANK_NILE', 'DEBT', 'OTHERS']).default('CASH'),
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
    
    // Validate amount doesn't exceed database limit
    const maxAmount = new Prisma.Decimal('999999999999999.99'); // Decimal(15,2) max value
    const amountDecimal = new Prisma.Decimal(data.amount);
    
    if (amountDecimal.greaterThan(maxAmount)) {
      return res.status(400).json({ error: 'المبلغ كبير جداً. الحد الأقصى هو 999,999,999,999,999.99' });
    }
    
    // Check if previous month's salary exists and is unpaid
    let prevMonthNote = '';
    const prevMonth = data.month === 1 ? 12 : data.month - 1;
    const prevYear = data.month === 1 ? data.year - 1 : data.year;

    const previousSalary = await prisma.salary.findFirst({
      where: {
        employeeId: data.employeeId,
        month: prevMonth,
        year: prevYear,
        paidAt: null,
      },
    });

    if (previousSalary) {
      prevMonthNote = `تنبيه: راتب الشهر السابق (${prevMonth}/${prevYear}) لم يتم دفعه بعد - مبلغ ${previousSalary.amount}`;
    }

    const notes = [data.notes, prevMonthNote].filter(Boolean).join(' | ');

    const salary = await prisma.salary.create({
      data: {
        ...data,
        amount: amountDecimal,
        notes: notes || data.notes || null,
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
    
    res.status(201).json({
      ...salary,
      ...(previousSalary ? { unpaidPreviousMonth: { month: prevMonth, year: prevYear, amount: previousSalary.amount } } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create salary error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Pay salary (with advance deduction logic)
router.post('/salaries/:id/pay', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('Salary'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Fetch salary first to get employeeId and amount
    const existingSalary = await prisma.salary.findUnique({
      where: { id },
      include: { employee: true },
    });

    if (!existingSalary) {
      return res.status(404).json({ error: 'الراتب غير موجود' });
    }

    if (existingSalary.paidAt) {
      return res.status(400).json({ error: 'تم دفع هذا الراتب مسبقاً' });
    }

    const salary = await prisma.$transaction(async (tx) => {
      // Get all outstanding (unpaid) advances for this employee, oldest first
      const outstandingAdvances = await tx.advance.findMany({
        where: {
          employeeId: existingSalary.employeeId,
          isFullyPaid: false,
        },
        orderBy: { createdAt: 'asc' },
      });

      // Calculate total outstanding loan balance
      const totalOutstandingAdvances = outstandingAdvances.reduce(
        (sum, adv) => sum.add(adv.remainingBalance),
        new Prisma.Decimal(0)
      );

      const salaryAmount = existingSalary.amount;

      // Deductions = min(totalOutstandingAdvances, salary amount)
      const deductions = totalOutstandingAdvances.greaterThan(salaryAmount)
        ? salaryAmount
        : totalOutstandingAdvances;

      const netAmount = salaryAmount.sub(deductions);
      const openingLoanBalance = totalOutstandingAdvances;
      const closingLoanBalance = totalOutstandingAdvances.sub(deductions);

      // Deduct from advances starting from oldest
      let remainingDeduction = new Prisma.Decimal(deductions.toString());

      for (const advance of outstandingAdvances) {
        if (remainingDeduction.lessThanOrEqualTo(0)) break;

        const deductFromThis = remainingDeduction.greaterThan(advance.remainingBalance)
          ? advance.remainingBalance
          : remainingDeduction;

        const newRemainingBalance = advance.remainingBalance.sub(deductFromThis);
        const isFullyPaid = newRemainingBalance.lessThanOrEqualTo(0);

        await tx.advance.update({
          where: { id: advance.id },
          data: {
            remainingBalance: newRemainingBalance,
            isFullyPaid,
          },
        });

        remainingDeduction = remainingDeduction.sub(deductFromThis);
      }

      // Update the salary record with payment and deduction info
      const updatedSalary = await tx.salary.update({
        where: { id },
        data: {
          paidAt: new Date(),
          deductions,
          netAmount,
          openingLoanBalance,
          closingLoanBalance,
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

      // Create/update EmployeeLoanBalance record for the month
      await tx.employeeLoanBalance.upsert({
        where: {
          employeeId_month_year: {
            employeeId: existingSalary.employeeId,
            month: existingSalary.month,
            year: existingSalary.year,
          },
        },
        create: {
          employeeId: existingSalary.employeeId,
          month: existingSalary.month,
          year: existingSalary.year,
          openingBalance: openingLoanBalance,
          advancesTaken: new Prisma.Decimal(0),
          deductions,
          closingBalance: closingLoanBalance,
        },
        update: {
          openingBalance: openingLoanBalance,
          deductions,
          closingBalance: closingLoanBalance,
        },
      });

      return updatedSalary;
    });

    // Update aggregates (async, don't block response)
    try {
      if (salary.paidAt) {
        const paymentDate = salary.paidAt;
        const salaryAmount = salary.amount;
        const paymentMethod = (salary as any).paymentMethod || 'CASH';
        const salariesByMethod = {
          CASH: paymentMethod === 'CASH' ? salaryAmount : new Prisma.Decimal(0),
          BANKAK: paymentMethod === 'BANKAK' ? salaryAmount : new Prisma.Decimal(0),
          BANK_NILE: paymentMethod === 'BANK_NILE' ? salaryAmount : new Prisma.Decimal(0),
        };

        await aggregationService.updateDailyFinancialAggregate(
          paymentDate,
          {
            salariesTotal: salaryAmount,
            salariesCount: 1,
            salariesCash: salariesByMethod.CASH,
            salariesBank: salariesByMethod.BANKAK,
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
    
    // Validate amount doesn't exceed database limit
    const maxAmount = new Prisma.Decimal('999999999999999.99'); // Decimal(15,2) max value
    const amountDecimal = new Prisma.Decimal(data.amount);
    
    if (amountDecimal.greaterThan(maxAmount)) {
      return res.status(400).json({ error: 'المبلغ كبير جداً. الحد الأقصى هو 999,999,999,999,999.99' });
    }
    
    const advance = await prisma.advance.create({
      data: {
        ...data,
        amount: amountDecimal,
        remainingBalance: amountDecimal,
        isFullyPaid: false,
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

    // Update EmployeeLoanBalance for the current month (track advancesTaken)
    try {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      await prisma.employeeLoanBalance.upsert({
        where: {
          employeeId_month_year: {
            employeeId: data.employeeId,
            month: currentMonth,
            year: currentYear,
          },
        },
        create: {
          employeeId: data.employeeId,
          month: currentMonth,
          year: currentYear,
          openingBalance: new Prisma.Decimal(0),
          advancesTaken: amountDecimal,
          deductions: new Prisma.Decimal(0),
          closingBalance: amountDecimal,
        },
        update: {
          advancesTaken: { increment: amountDecimal },
          closingBalance: { increment: amountDecimal },
        },
      });
    } catch (loanErr) {
      console.error('EmployeeLoanBalance update error (non-blocking):', loanErr);
    }
    
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
          BANKAK: paymentMethod === 'BANKAK' ? advanceAmount : new Prisma.Decimal(0),
          BANK_NILE: paymentMethod === 'BANK_NILE' ? advanceAmount : new Prisma.Decimal(0),
        };

        await aggregationService.updateDailyFinancialAggregate(
          paymentDate,
          {
            advancesTotal: advanceAmount,
            advancesCount: 1,
            advancesCash: advancesByMethod.CASH,
            advancesBank: advancesByMethod.BANKAK,
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

// Get employee loan balance / loan aging report
router.get('/:id/loan-balance', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();

    // Verify employee exists
    const employee = await prisma.employee.findUnique({
      where: { id },
      select: { id: true, name: true, position: true },
    });

    if (!employee) {
      return res.status(404).json({ error: 'الموظف غير موجود' });
    }

    const loanBalances = await prisma.employeeLoanBalance.findMany({
      where: {
        employeeId: id,
        year,
      },
      orderBy: { month: 'asc' },
    });

    // Calculate grand totals
    const grandTotal = loanBalances.reduce(
      (totals, record) => ({
        totalOpeningBalance: totals.totalOpeningBalance.add(record.openingBalance),
        totalAdvancesTaken: totals.totalAdvancesTaken.add(record.advancesTaken),
        totalDeductions: totals.totalDeductions.add(record.deductions),
        totalClosingBalance: totals.totalClosingBalance.add(record.closingBalance),
      }),
      {
        totalOpeningBalance: new Prisma.Decimal(0),
        totalAdvancesTaken: new Prisma.Decimal(0),
        totalDeductions: new Prisma.Decimal(0),
        totalClosingBalance: new Prisma.Decimal(0),
      }
    );

    // Get current outstanding balance (sum of unpaid advances)
    const outstandingAdvances = await prisma.advance.aggregate({
      where: {
        employeeId: id,
        isFullyPaid: false,
      },
      _sum: {
        remainingBalance: true,
      },
    });

    res.json({
      employee,
      year,
      records: loanBalances.map((record) => ({
        month: record.month,
        year: record.year,
        openingBalance: record.openingBalance,
        advancesTaken: record.advancesTaken,
        deductions: record.deductions,
        closingBalance: record.closingBalance,
      })),
      grandTotal,
      currentOutstandingBalance: outstandingAdvances._sum.remainingBalance || new Prisma.Decimal(0),
    });
  } catch (error) {
    console.error('Get loan balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get formatted payslip for a salary
router.get('/payslips/:salaryId', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { salaryId } = req.params;

    const salary = await prisma.salary.findUnique({
      where: { id: salaryId },
      include: {
        employee: true,
        creator: {
          select: { username: true, role: true },
        },
      },
    });

    if (!salary) {
      return res.status(404).json({ error: 'الراتب غير موجود' });
    }

    // Get advances that were deducted during this salary payment
    // These are advances for the same employee that have been partially/fully paid
    const advanceDeductions: Array<{
      advanceId: string;
      reason: string;
      originalAmount: Prisma.Decimal;
      deductedAmount: Prisma.Decimal;
      remainingBalance: Prisma.Decimal;
      createdAt: Date;
    }> = [];

    if (salary.paidAt && salary.deductions.greaterThan(0)) {
      // Retrieve all advances for this employee to show deduction breakdown
      const employeeAdvances = await prisma.advance.findMany({
        where: {
          employeeId: salary.employeeId,
        },
        orderBy: { createdAt: 'asc' },
      });

      // Reconstruct deduction breakdown: advances where amount != remainingBalance
      // or isFullyPaid = true indicate previous deductions
      let totalDeductionsAccounted = new Prisma.Decimal(0);
      for (const adv of employeeAdvances) {
        const deducted = adv.amount.sub(adv.remainingBalance);
        if (deducted.greaterThan(0) && totalDeductionsAccounted.lessThan(salary.deductions)) {
          const applicableDeduction = Prisma.Decimal.min(
            deducted,
            salary.deductions.sub(totalDeductionsAccounted)
          );
          advanceDeductions.push({
            advanceId: adv.id,
            reason: (adv as any).reason || 'سلفة',
            originalAmount: adv.amount,
            deductedAmount: applicableDeduction,
            remainingBalance: adv.remainingBalance,
            createdAt: adv.createdAt,
          });
          totalDeductionsAccounted = totalDeductionsAccounted.add(applicableDeduction);
        }
      }
    }

    // Get loan balance record for context
    const loanBalance = await prisma.employeeLoanBalance.findUnique({
      where: {
        employeeId_month_year: {
          employeeId: salary.employeeId,
          month: salary.month,
          year: salary.year,
        },
      },
    });

    res.json({
      payslip: {
        salaryId: salary.id,
        employee: {
          id: salary.employee.id,
          name: salary.employee.name,
          position: salary.employee.position,
        },
        month: salary.month,
        year: salary.year,
        grossAmount: salary.amount,
        deductions: salary.deductions,
        netAmount: salary.netAmount,
        paymentMethod: (salary as any).paymentMethod || 'CASH',
        paidAt: salary.paidAt,
        createdAt: salary.createdAt,
        createdBy: salary.creator,
        notes: (salary as any).notes || null,
      },
      deductionBreakdown: advanceDeductions,
      loanSummary: {
        openingLoanBalance: salary.openingLoanBalance,
        closingLoanBalance: salary.closingLoanBalance,
        monthlyLoanBalance: loanBalance
          ? {
              openingBalance: loanBalance.openingBalance,
              advancesTaken: loanBalance.advancesTaken,
              deductions: loanBalance.deductions,
              closingBalance: loanBalance.closingBalance,
            }
          : null,
      },
    });
  } catch (error) {
    console.error('Get payslip error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get employee report with time period filter
router.get('/report', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, employeeId } = req.query;
    
    // Build date filter
    let dateFilter: any = {};
    if (startDate && endDate) {
      const start = new Date(startDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      
      dateFilter = {
        gte: start,
        lte: end,
      };
    } else if (startDate) {
      const start = new Date(startDate as string);
      start.setHours(0, 0, 0, 0);
      dateFilter = { gte: start };
    } else if (endDate) {
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      dateFilter = { lte: end };
    }
    
    // Build employee filter
    const employeeWhere: any = {};
    if (employeeId) {
      employeeWhere.id = employeeId as string;
    }
    
    // Get all employees (or specific employee)
    const employees = await prisma.employee.findMany({
      where: employeeWhere,
      orderBy: { name: 'asc' },
      include: {
        salaries: {
          where: {
            ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
          },
          include: {
            creator: {
              select: { username: true, role: true },
            },
          },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
        },
        advances: {
          where: {
            ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
          },
          include: {
            creator: {
              select: { username: true, role: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    
    // Calculate totals for each employee
    const reportData = employees.map((employee) => {
      const totalSalaries = employee.salaries.reduce(
        (sum, salary) => sum + parseFloat(salary.amount.toString()),
        0
      );
      const paidSalaries = employee.salaries
        .filter((s) => s.paidAt)
        .reduce((sum, salary) => sum + parseFloat(salary.amount.toString()), 0);
      const unpaidSalaries = totalSalaries - paidSalaries;
      
      const totalAdvances = employee.advances.reduce(
        (sum, advance) => sum + parseFloat(advance.amount.toString()),
        0
      );
      const paidAdvances = employee.advances
        .filter((a) => a.paidAt)
        .reduce((sum, advance) => sum + parseFloat(advance.amount.toString()), 0);
      const unpaidAdvances = totalAdvances - paidAdvances;
      
      return {
        ...employee,
        totalSalaries,
        paidSalaries,
        unpaidSalaries,
        salaryCount: employee.salaries.length,
        paidSalaryCount: employee.salaries.filter((s) => s.paidAt).length,
        totalAdvances,
        paidAdvances,
        unpaidAdvances,
        advanceCount: employee.advances.length,
        paidAdvanceCount: employee.advances.filter((a) => a.paidAt).length,
        totalPaid: paidSalaries + paidAdvances,
        totalUnpaid: unpaidSalaries + unpaidAdvances,
        totalAmount: totalSalaries + totalAdvances,
      };
    });
    
    // Calculate grand totals
    const grandTotals = {
      totalSalaries: reportData.reduce((sum, emp) => sum + emp.totalSalaries, 0),
      paidSalaries: reportData.reduce((sum, emp) => sum + emp.paidSalaries, 0),
      unpaidSalaries: reportData.reduce((sum, emp) => sum + emp.unpaidSalaries, 0),
      totalAdvances: reportData.reduce((sum, emp) => sum + emp.totalAdvances, 0),
      paidAdvances: reportData.reduce((sum, emp) => sum + emp.paidAdvances, 0),
      unpaidAdvances: reportData.reduce((sum, emp) => sum + emp.unpaidAdvances, 0),
      totalPaid: reportData.reduce((sum, emp) => sum + emp.totalPaid, 0),
      totalUnpaid: reportData.reduce((sum, emp) => sum + emp.totalUnpaid, 0),
      totalAmount: reportData.reduce((sum, emp) => sum + emp.totalAmount, 0),
      salaryCount: reportData.reduce((sum, emp) => sum + emp.salaryCount, 0),
      paidSalaryCount: reportData.reduce((sum, emp) => sum + emp.paidSalaryCount, 0),
      advanceCount: reportData.reduce((sum, emp) => sum + emp.advanceCount, 0),
      paidAdvanceCount: reportData.reduce((sum, emp) => sum + emp.paidAdvanceCount, 0),
    };
    
    res.json({
      employees: reportData,
      totals: grandTotals,
      period: {
        startDate: startDate || null,
        endDate: endDate || null,
      },
    });
  } catch (error) {
    console.error('Get employee report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;
