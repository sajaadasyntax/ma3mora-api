import { PrismaClient, Prisma } from '@prisma/client';
import { aggregationService } from '../src/services/aggregationService';

const prisma = new PrismaClient();

interface AggregateIssue {
  date: Date;
  inventoryId?: string;
  inventoryName?: string;
  section?: string;
  issues: string[];
  calculated: {
    salesTotal: Prisma.Decimal;
    salesReceived: Prisma.Decimal;
    salesCount: number;
    procurementTotal: Prisma.Decimal;
    procurementPaid: Prisma.Decimal;
    procurementCount: number;
    expensesTotal: Prisma.Decimal;
    expensesCount: number;
  };
  stored: {
    salesTotal: Prisma.Decimal;
    salesReceived: Prisma.Decimal;
    salesCount: number;
    procurementTotal: Prisma.Decimal;
    procurementPaid: Prisma.Decimal;
    procurementCount: number;
    expensesTotal: Prisma.Decimal;
    expensesCount: number;
  };
}

class FinancialAggregateRecalculator {
  private issues: AggregateIssue[] = [];
  private recalculated: number = 0;
  private failed: number = 0;
  private dryRun: boolean;

  constructor(dryRun: boolean = true) {
    this.dryRun = dryRun;
  }

  /**
   * Find all dates with aggregate issues
   */
  async findIssues(startDate?: Date, endDate?: Date): Promise<void> {
    console.log('🔍 Finding financial aggregate issues...\n');

    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.date = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        dateFilter.date.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.date.lte = end;
      }
    }

    const aggregates = await prisma.dailyFinancialAggregate.findMany({
      where: dateFilter,
      include: {
        inventory: true,
      },
      orderBy: {
        date: 'desc',
      },
    });

    console.log(`Checking ${aggregates.length} daily aggregates...\n`);

    for (const aggregate of aggregates) {
      const dateOnly = new Date(aggregate.date);
      dateOnly.setHours(0, 0, 0, 0);
      const dateEnd = new Date(dateOnly);
      dateEnd.setHours(23, 59, 59, 999);

      const where: any = {
        createdAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      };
      if (aggregate.inventoryId) where.inventoryId = aggregate.inventoryId;
      if (aggregate.section) where.section = aggregate.section;

      // Recalculate from source transactions
      const invoices = await prisma.salesInvoice.findMany({
        where: {
          ...where,
          paymentConfirmationStatus: { not: 'REJECTED' },
        },
      });

      const orders = await prisma.procOrder.findMany({ where });
      const expenses = await prisma.expense.findMany({ where });
      const salaries = await prisma.salary.findMany({
        where: {
          paidAt: {
            gte: dateOnly,
            lte: dateEnd,
          },
        },
      });
      const advances = await prisma.advance.findMany({
        where: {
          paidAt: {
            gte: dateOnly,
            lte: dateEnd,
          },
        },
      });

      // Calculate totals
      const calculated = {
        salesTotal: invoices.reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
        salesReceived: invoices.reduce((sum, inv) => sum.add(inv.paidAmount), new Prisma.Decimal(0)),
        salesCount: invoices.length,
        procurementTotal: orders
          .filter(o => o.status !== 'CANCELLED')
          .reduce((sum, o) => sum.add(o.total), new Prisma.Decimal(0)),
        procurementPaid: orders.reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0)),
        procurementCount: orders.filter(o => o.status !== 'CANCELLED').length,
        expensesTotal: expenses.reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
        expensesCount: expenses.length,
      };

      const stored = {
        salesTotal: aggregate.salesTotal,
        salesReceived: aggregate.salesReceived,
        salesCount: aggregate.salesCount,
        procurementTotal: aggregate.procurementTotal,
        procurementPaid: aggregate.procurementPaid,
        procurementCount: aggregate.procurementCount,
        expensesTotal: aggregate.expensesTotal,
        expensesCount: aggregate.expensesCount,
      };

      // Compare with tolerance
      const tolerance = new Prisma.Decimal(0.01);
      const issues: string[] = [];

      if (calculated.salesTotal.sub(stored.salesTotal).abs().gt(tolerance)) {
        issues.push(`Sales total: ${calculated.salesTotal.toString()} vs ${stored.salesTotal.toString()}`);
      }
      if (calculated.salesReceived.sub(stored.salesReceived).abs().gt(tolerance)) {
        issues.push(`Sales received: ${calculated.salesReceived.toString()} vs ${stored.salesReceived.toString()}`);
      }
      if (calculated.salesCount !== stored.salesCount) {
        issues.push(`Sales count: ${calculated.salesCount} vs ${stored.salesCount}`);
      }
      if (calculated.procurementTotal.sub(stored.procurementTotal).abs().gt(tolerance)) {
        issues.push(`Procurement total: ${calculated.procurementTotal.toString()} vs ${stored.procurementTotal.toString()}`);
      }
      if (calculated.procurementPaid.sub(stored.procurementPaid).abs().gt(tolerance)) {
        issues.push(`Procurement paid: ${calculated.procurementPaid.toString()} vs ${stored.procurementPaid.toString()}`);
      }
      if (calculated.procurementCount !== stored.procurementCount) {
        issues.push(`Procurement count: ${calculated.procurementCount} vs ${stored.procurementCount}`);
      }
      if (calculated.expensesTotal.sub(stored.expensesTotal).abs().gt(tolerance)) {
        issues.push(`Expenses total: ${calculated.expensesTotal.toString()} vs ${stored.expensesTotal.toString()}`);
      }
      if (calculated.expensesCount !== stored.expensesCount) {
        issues.push(`Expenses count: ${calculated.expensesCount} vs ${stored.expensesCount}`);
      }

      if (issues.length > 0) {
        this.issues.push({
          date: aggregate.date,
          inventoryId: aggregate.inventoryId || undefined,
          inventoryName: aggregate.inventory?.name,
          section: aggregate.section || undefined,
          issues,
          calculated,
          stored,
        });
      }
    }

    console.log(`Found ${this.issues.length} dates with issues\n`);
  }

  /**
   * Recalculate aggregates for all dates with issues
   */
  async recalculateAll(): Promise<void> {
    console.log('🔄 Recalculating financial aggregates...\n');
    console.log(`Mode: ${this.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be applied)'}\n`);

    if (this.issues.length === 0) {
      console.log('No issues found. Run findIssues() first.\n');
      return;
    }

    for (const issue of this.issues) {
      const dateStr = issue.date.toISOString().split('T')[0];
      console.log(`Recalculating ${dateStr}...`);

      if (issue.inventoryId) {
        console.log(`  Inventory: ${issue.inventoryName || issue.inventoryId}`);
      }
      if (issue.section) {
        console.log(`  Section: ${issue.section}`);
      }

      try {
        if (!this.dryRun) {
          await aggregationService.recalculateDate(
            issue.date,
            issue.inventoryId,
            issue.section as any
          );
          this.recalculated++;
          console.log(`  ✅ Recalculated successfully`);
        } else {
          console.log(`  [DRY RUN] Would recalculate`);
        }
      } catch (error) {
        this.failed++;
        console.error(`  ❌ Failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.generateReport();
  }

  /**
   * Generate report
   */
  generateReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 FINANCIAL AGGREGATE RECALCULATION REPORT');
    console.log('='.repeat(80) + '\n');

    console.log('📈 SUMMARY');
    console.log('-'.repeat(80));
    console.log(`Dates with issues: ${this.issues.length}`);
    console.log(`Recalculated: ${this.recalculated}`);
    console.log(`Failed: ${this.failed}\n`);

    if (this.issues.length > 0) {
      console.log('📋 ISSUES FOUND');
      console.log('-'.repeat(80));
      this.issues.slice(0, 10).forEach((issue, idx) => {
        const dateStr = issue.date.toISOString().split('T')[0];
        console.log(`\n${idx + 1}. Date: ${dateStr}`);
        if (issue.inventoryId) console.log(`   Inventory: ${issue.inventoryName || issue.inventoryId}`);
        if (issue.section) console.log(`   Section: ${issue.section}`);
        issue.issues.forEach(i => console.log(`   - ${i}`));
      });

      if (this.issues.length > 10) {
        console.log(`\n... and ${this.issues.length - 10} more dates with issues\n`);
      }
    }

    if (this.dryRun) {
      console.log('\n⚠️  DRY RUN MODE - No changes were made');
      console.log('Run with --apply flag to apply changes\n');
    } else {
      console.log('\n✅ Recalculation completed!\n');
    }

    console.log('='.repeat(80) + '\n');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  const startDate = args.find(arg => arg.startsWith('--start='))?.split('=')[1];
  const endDate = args.find(arg => arg.startsWith('--end='))?.split('=')[1];

  const recalculator = new FinancialAggregateRecalculator(dryRun);

  try {
    await recalculator.findIssues(
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined
    );
    await recalculator.recalculateAll();
  } catch (error) {
    console.error('Error during recalculation:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

