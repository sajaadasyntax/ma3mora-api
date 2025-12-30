import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface Issue {
  type: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  details?: any;
}

interface BatchCheckResult {
  inventoryId: string;
  inventoryName: string;
  itemId: string;
  itemName: string;
  issues: Issue[];
  stockQuantity: Prisma.Decimal;
  batchSum: Prisma.Decimal;
  difference: Prisma.Decimal;
  batchCount: number;
  expiredBatches: number;
  negativeBatches: number;
}

interface DeliveryBatchCheckResult {
  deliveryId: string;
  invoiceNumber: string;
  itemId: string;
  itemName: string;
  issues: Issue[];
  deliveryQuantity: Prisma.Decimal;
  batchSum: Prisma.Decimal;
  difference: Prisma.Decimal;
}

interface FinancialAggregateCheckResult {
  date: Date;
  inventoryId?: string;
  section?: string;
  issues: Issue[];
  calculated: any;
  stored: any;
}

class BatchTransactionChecker {
  private issues: Issue[] = [];
  private batchResults: BatchCheckResult[] = [];
  private deliveryResults: DeliveryBatchCheckResult[] = [];
  private financialResults: FinancialAggregateCheckResult[] = [];

  /**
   * Check all batch transactions for issues
   */
  async checkAll(startDate?: Date, endDate?: Date): Promise<void> {
    console.log('🔍 Starting Batch Transaction Check...\n');
    console.log(`Date Range: ${startDate ? startDate.toISOString().split('T')[0] : 'All'} - ${endDate ? endDate.toISOString().split('T')[0] : 'All'}\n`);

    await this.checkBatchQuantities(startDate, endDate);
    await this.checkDeliveryBatches(startDate, endDate);
    await this.checkOrphanedBatches();
    await this.checkExpiredBatches();
    await this.checkFinancialAggregates(startDate, endDate);
    
    this.generateReport();
  }

  /**
   * Check batch quantity consistency with stock
   */
  async checkBatchQuantities(startDate?: Date, endDate?: Date): Promise<void> {
    console.log('📦 Checking batch quantity consistency...');

    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.receivedAt = {};
      if (startDate) dateFilter.receivedAt.gte = startDate;
      if (endDate) dateFilter.receivedAt.lte = endDate;
    }

    // Get all stocks with batches
    const stocks = await prisma.inventoryStock.findMany({
      include: {
        batches: {
          where: dateFilter,
          include: {
            deliveryBatches: true,
          },
        },
        inventory: true,
        item: true,
      },
    });

    for (const stock of stocks) {
      const batchSum = stock.batches.reduce(
        (sum, batch) => sum.add(batch.quantity),
        new Prisma.Decimal(0)
      );

      const difference = batchSum.sub(stock.quantity);
      const issues: Issue[] = [];

      // Check for quantity mismatch
      const tolerance = new Prisma.Decimal(0.01); // Allow small floating point differences
      if (difference.abs().gt(tolerance)) {
        issues.push({
          type: 'QUANTITY_MISMATCH',
          severity: 'error',
          message: `Batch sum (${batchSum.toString()}) does not match stock quantity (${stock.quantity.toString()})`,
          details: {
            stockQuantity: stock.quantity.toString(),
            batchSum: batchSum.toString(),
            difference: difference.toString(),
          },
        });
      }

      // Check for negative batches
      const negativeBatches = stock.batches.filter(b => b.quantity.lt(0));
      if (negativeBatches.length > 0) {
        issues.push({
          type: 'NEGATIVE_BATCH',
          severity: 'error',
          message: `Found ${negativeBatches.length} batch(es) with negative quantity`,
          details: {
            batches: negativeBatches.map(b => ({
              id: b.id,
              quantity: b.quantity.toString(),
              receivedAt: b.receivedAt.toISOString(),
            })),
          },
        });
      }

      // Check for batches with zero quantity but still have delivery batches
      const zeroBatchesWithDeliveries = stock.batches.filter(
        b => b.quantity.eq(0) && b.deliveryBatches.length > 0
      );
      if (zeroBatchesWithDeliveries.length > 0) {
        const deliverySum = zeroBatchesWithDeliveries.reduce((sum, batch) => {
          const batchDeliverySum = batch.deliveryBatches.reduce(
            (s, db) => s.add(db.quantity),
            new Prisma.Decimal(0)
          );
          return sum.add(batchDeliverySum);
        }, new Prisma.Decimal(0));

        if (deliverySum.gt(0)) {
          issues.push({
            type: 'ZERO_BATCH_WITH_DELIVERIES',
            severity: 'warning',
            message: `Found ${zeroBatchesWithDeliveries.length} batch(es) with zero quantity but have deliveries`,
            details: {
              batches: zeroBatchesWithDeliveries.map(b => ({
                id: b.id,
                deliverySum: b.deliveryBatches.reduce(
                  (s, db) => s.add(db.quantity),
                  new Prisma.Decimal(0)
                ).toString(),
              })),
            },
          });
        }
      }

      // Check for expired batches
      const now = new Date();
      const expiredBatches = stock.batches.filter(
        b => b.expiryDate && b.expiryDate < now && b.quantity.gt(0)
      );

      if (expiredBatches.length > 0) {
        issues.push({
          type: 'EXPIRED_BATCHES',
          severity: 'warning',
          message: `Found ${expiredBatches.length} expired batch(es) with remaining quantity`,
          details: {
            batches: expiredBatches.map(b => ({
              id: b.id,
              quantity: b.quantity.toString(),
              expiryDate: b.expiryDate?.toISOString(),
            })),
          },
        });
      }

      if (issues.length > 0 || stock.batches.length > 0) {
        this.batchResults.push({
          inventoryId: stock.inventoryId,
          inventoryName: stock.inventory.name,
          itemId: stock.itemId,
          itemName: stock.item.name,
          issues,
          stockQuantity: stock.quantity,
          batchSum,
          difference,
          batchCount: stock.batches.length,
          expiredBatches: expiredBatches.length,
          negativeBatches: negativeBatches.length,
        });
      }
    }

    console.log(`   Checked ${stocks.length} stock items\n`);
  }

  /**
   * Check delivery batch tracking
   */
  async checkDeliveryBatches(startDate?: Date, endDate?: Date): Promise<void> {
    console.log('🚚 Checking delivery batch tracking...');

    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.deliveredAt = {};
      if (startDate) dateFilter.deliveredAt.gte = startDate;
      if (endDate) dateFilter.deliveredAt.lte = endDate;
    }

    const deliveries = await prisma.inventoryDelivery.findMany({
      where: dateFilter,
      include: {
        items: {
          include: {
            batches: {
              include: {
                batch: true,
              },
            },
            item: true,
          },
        },
        invoice: {
          select: {
            invoiceNumber: true,
          },
        },
      },
    });

    for (const delivery of deliveries) {
      for (const item of delivery.items) {
        const batchSum = item.batches.reduce(
          (sum, db) => sum.add(db.quantity),
          new Prisma.Decimal(0)
        );

        const difference = batchSum.sub(item.quantity);
        const issues: Issue[] = [];

        // Check if delivery quantity matches batch sum
        const tolerance = new Prisma.Decimal(0.01);
        if (difference.abs().gt(tolerance)) {
          issues.push({
            type: 'DELIVERY_BATCH_MISMATCH',
            severity: 'error',
            message: `Delivery batch sum (${batchSum.toString()}) does not match item quantity (${item.quantity.toString()})`,
            details: {
              deliveryQuantity: item.quantity.toString(),
              batchSum: batchSum.toString(),
              difference: difference.toString(),
            },
          });
        }

        // Check if batches still have sufficient quantity
        for (const deliveryBatch of item.batches) {
          if (deliveryBatch.batch.quantity.lt(0)) {
            issues.push({
              type: 'BATCH_OVER_CONSUMED',
              severity: 'error',
              message: `Batch ${deliveryBatch.batchId} has negative quantity after delivery`,
              details: {
                batchId: deliveryBatch.batchId,
                currentQuantity: deliveryBatch.batch.quantity.toString(),
                deliveredQuantity: deliveryBatch.quantity.toString(),
              },
            });
          }
        }

        if (issues.length > 0) {
          this.deliveryResults.push({
            deliveryId: delivery.id,
            invoiceNumber: delivery.invoice?.invoiceNumber || 'N/A',
            itemId: item.itemId,
            itemName: item.item.name,
            issues,
            deliveryQuantity: item.quantity,
            batchSum,
            difference,
          });
        }
      }
    }

    console.log(`   Checked ${deliveries.length} deliveries\n`);
  }

  /**
   * Check for orphaned batches
   */
  async checkOrphanedBatches(): Promise<void> {
    console.log('🔗 Checking for orphaned batches...');

    // Check batches without valid receipts
    const batchesWithoutReceipts = await prisma.stockBatch.findMany({
      where: {
        receiptId: {
          not: null,
        },
        receipt: null,
      },
      include: {
        item: true,
        inventory: true,
      },
    });

    if (batchesWithoutReceipts.length > 0) {
      this.issues.push({
        type: 'ORPHANED_BATCH_RECEIPT',
        severity: 'warning',
        message: `Found ${batchesWithoutReceipts.length} batch(es) with invalid receipt references`,
        details: {
          batches: batchesWithoutReceipts.map(b => ({
            id: b.id,
            receiptId: b.receiptId,
            itemId: b.itemId,
            itemName: b.item.name,
            inventoryId: b.inventoryId,
            inventoryName: b.inventory.name,
          })),
        },
      });
    }

    // Check batches without stock reference
    const batchesWithoutStock = await prisma.stockBatch.findMany({
      where: {
        inventoryStock: null,
      },
      include: {
        item: true,
        inventory: true,
      },
    });

    if (batchesWithoutStock.length > 0) {
      this.issues.push({
        type: 'ORPHANED_BATCH_STOCK',
        severity: 'error',
        message: `Found ${batchesWithoutStock.length} batch(es) without stock reference`,
        details: {
          batches: batchesWithoutStock.map(b => ({
            id: b.id,
            itemId: b.itemId,
            itemName: b.item.name,
            inventoryId: b.inventoryId,
            inventoryName: b.inventory.name,
          })),
        },
      });
    }

    console.log(`   Found ${batchesWithoutReceipts.length} orphaned receipt references`);
    console.log(`   Found ${batchesWithoutStock.length} orphaned stock references\n`);
  }

  /**
   * Check for expired batches
   */
  async checkExpiredBatches(): Promise<void> {
    console.log('⏰ Checking expired batches...');

    const now = new Date();
    const expiredBatches = await prisma.stockBatch.findMany({
      where: {
        expiryDate: {
          lt: now,
        },
        quantity: {
          gt: 0,
        },
      },
      include: {
        item: true,
        inventory: true,
      },
      orderBy: {
        expiryDate: 'asc',
      },
    });

    if (expiredBatches.length > 0) {
      const totalExpiredQuantity = expiredBatches.reduce(
        (sum, b) => sum.add(b.quantity),
        new Prisma.Decimal(0)
      );

      this.issues.push({
        type: 'EXPIRED_BATCHES_SUMMARY',
        severity: 'warning',
        message: `Found ${expiredBatches.length} expired batch(es) with ${totalExpiredQuantity.toString()} total quantity`,
        details: {
          totalBatches: expiredBatches.length,
          totalQuantity: totalExpiredQuantity.toString(),
          batches: expiredBatches.slice(0, 10).map(b => ({
            id: b.id,
            itemId: b.itemId,
            itemName: b.item.name,
            quantity: b.quantity.toString(),
            expiryDate: b.expiryDate?.toISOString(),
            daysExpired: b.expiryDate
              ? Math.floor((now.getTime() - b.expiryDate.getTime()) / (1000 * 60 * 60 * 24))
              : 0,
          })),
        },
      });
    }

    console.log(`   Found ${expiredBatches.length} expired batches with remaining quantity\n`);
  }

  /**
   * Check financial aggregates consistency
   */
  async checkFinancialAggregates(startDate?: Date, endDate?: Date): Promise<void> {
    console.log('💰 Checking financial aggregates...');

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
      orderBy: {
        date: 'desc',
      },
    });

    for (const aggregate of aggregates) {
      const dateOnly = new Date(aggregate.date);
      dateOnly.setHours(0, 0, 0, 0);
      const dateEnd = new Date(dateOnly);
      dateEnd.setHours(23, 59, 59, 999);

      const issues: Issue[] = [];

      // Recalculate from source transactions
      const where: any = {
        createdAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      };
      if (aggregate.inventoryId) where.inventoryId = aggregate.inventoryId;
      if (aggregate.section) where.section = aggregate.section;

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

      if (calculated.salesTotal.sub(stored.salesTotal).abs().gt(tolerance)) {
        issues.push({
          type: 'SALES_TOTAL_MISMATCH',
          severity: 'error',
          message: `Sales total mismatch: calculated ${calculated.salesTotal.toString()}, stored ${stored.salesTotal.toString()}`,
        });
      }

      if (calculated.salesReceived.sub(stored.salesReceived).abs().gt(tolerance)) {
        issues.push({
          type: 'SALES_RECEIVED_MISMATCH',
          severity: 'error',
          message: `Sales received mismatch: calculated ${calculated.salesReceived.toString()}, stored ${stored.salesReceived.toString()}`,
        });
      }

      if (calculated.salesCount !== stored.salesCount) {
        issues.push({
          type: 'SALES_COUNT_MISMATCH',
          severity: 'warning',
          message: `Sales count mismatch: calculated ${calculated.salesCount}, stored ${stored.salesCount}`,
        });
      }

      if (calculated.procurementTotal.sub(stored.procurementTotal).abs().gt(tolerance)) {
        issues.push({
          type: 'PROCUREMENT_TOTAL_MISMATCH',
          severity: 'error',
          message: `Procurement total mismatch: calculated ${calculated.procurementTotal.toString()}, stored ${stored.procurementTotal.toString()}`,
        });
      }

      if (issues.length > 0) {
        this.financialResults.push({
          date: aggregate.date,
          inventoryId: aggregate.inventoryId || undefined,
          section: aggregate.section || undefined,
          issues,
          calculated,
          stored,
        });
      }
    }

    console.log(`   Checked ${aggregates.length} daily aggregates\n`);
  }

  /**
   * Generate comprehensive report
   */
  generateReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 BATCH TRANSACTION CHECK REPORT');
    console.log('='.repeat(80) + '\n');

    // Summary
    const totalBatchIssues = this.batchResults.reduce((sum, r) => sum + r.issues.length, 0);
    const totalDeliveryIssues = this.deliveryResults.reduce((sum, r) => sum + r.issues.length, 0);
    const totalFinancialIssues = this.financialResults.reduce((sum, r) => sum + r.issues.length, 0);
    const totalGlobalIssues = this.issues.length;

    console.log('📈 SUMMARY');
    console.log('-'.repeat(80));
    console.log(`Batch Quantity Issues: ${totalBatchIssues}`);
    console.log(`Delivery Batch Issues: ${totalDeliveryIssues}`);
    console.log(`Financial Aggregate Issues: ${totalFinancialIssues}`);
    console.log(`Global Issues: ${totalGlobalIssues}`);
    console.log(`Total Issues: ${totalBatchIssues + totalDeliveryIssues + totalFinancialIssues + totalGlobalIssues}\n`);

    // Batch quantity issues
    if (this.batchResults.length > 0) {
      console.log('📦 BATCH QUANTITY ISSUES');
      console.log('-'.repeat(80));
      const issuesWithProblems = this.batchResults.filter(r => r.issues.length > 0);
      console.log(`Items with issues: ${issuesWithProblems.length} / ${this.batchResults.length}\n`);

      issuesWithProblems.slice(0, 20).forEach(result => {
        console.log(`\n${result.itemName} (${result.inventoryName})`);
        console.log(`  Stock Qty: ${result.stockQuantity.toString()}`);
        console.log(`  Batch Sum: ${result.batchSum.toString()}`);
        console.log(`  Difference: ${result.difference.toString()}`);
        console.log(`  Batches: ${result.batchCount}`);
        result.issues.forEach(issue => {
          console.log(`  [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
        });
      });

      if (issuesWithProblems.length > 20) {
        console.log(`\n... and ${issuesWithProblems.length - 20} more items with issues\n`);
      }
    }

    // Delivery batch issues
    if (this.deliveryResults.length > 0) {
      console.log('\n🚚 DELIVERY BATCH ISSUES');
      console.log('-'.repeat(80));
      this.deliveryResults.slice(0, 20).forEach(result => {
        console.log(`\nInvoice: ${result.invoiceNumber} - ${result.itemName}`);
        console.log(`  Delivery Qty: ${result.deliveryQuantity.toString()}`);
        console.log(`  Batch Sum: ${result.batchSum.toString()}`);
        console.log(`  Difference: ${result.difference.toString()}`);
        result.issues.forEach(issue => {
          console.log(`  [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
        });
      });

      if (this.deliveryResults.length > 20) {
        console.log(`\n... and ${this.deliveryResults.length - 20} more deliveries with issues\n`);
      }
    }

    // Financial aggregate issues
    if (this.financialResults.length > 0) {
      console.log('\n💰 FINANCIAL AGGREGATE ISSUES');
      console.log('-'.repeat(80));
      this.financialResults.slice(0, 10).forEach(result => {
        const dateStr = result.date.toISOString().split('T')[0];
        console.log(`\nDate: ${dateStr}`);
        if (result.inventoryId) console.log(`  Inventory: ${result.inventoryId}`);
        if (result.section) console.log(`  Section: ${result.section}`);
        result.issues.forEach(issue => {
          console.log(`  [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
        });
      });

      if (this.financialResults.length > 10) {
        console.log(`\n... and ${this.financialResults.length - 10} more dates with issues\n`);
      }
    }

    // Global issues
    if (this.issues.length > 0) {
      console.log('\n🌐 GLOBAL ISSUES');
      console.log('-'.repeat(80));
      this.issues.forEach(issue => {
        console.log(`\n[${issue.severity.toUpperCase()}] ${issue.type}`);
        console.log(`  ${issue.message}`);
        if (issue.details) {
          console.log(`  Details: ${JSON.stringify(issue.details, null, 2)}`);
        }
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Check completed');
    console.log('='.repeat(80) + '\n');
  }
}

// Main execution
async function main() {
  const checker = new BatchTransactionChecker();

  // Parse command line arguments for date range
  const args = process.argv.slice(2);
  let startDate: Date | undefined;
  let endDate: Date | undefined;

  if (args.length > 0) {
    startDate = new Date(args[0]);
    if (isNaN(startDate.getTime())) {
      console.error('Invalid start date format. Use YYYY-MM-DD');
      process.exit(1);
    }
  }

  if (args.length > 1) {
    endDate = new Date(args[1]);
    if (isNaN(endDate.getTime())) {
      console.error('Invalid end date format. Use YYYY-MM-DD');
      process.exit(1);
    }
  }

  try {
    await checker.checkAll(startDate, endDate);
  } catch (error) {
    console.error('Error during check:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

