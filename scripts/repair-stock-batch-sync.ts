import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface RepairAction {
  type: 'CREATE_MISSING_BATCHES' | 'UPDATE_STOCK_FROM_BATCHES' | 'UPDATE_BATCHES_FROM_STOCK';
  inventoryId: string;
  inventoryName: string;
  itemId: string;
  itemName: string;
  description: string;
  oldValue: string;
  newValue: string;
}

class StockBatchRepairer {
  private actions: RepairAction[] = [];
  private dryRun: boolean;

  constructor(dryRun: boolean = true) {
    this.dryRun = dryRun;
  }

  /**
   * Repair stock and batch quantity mismatches
   */
  async repairAll(): Promise<void> {
    console.log('🔧 Starting Stock-Batch Sync Repair...\n');
    console.log(`Mode: ${this.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be applied)'}\n`);

    // Get all stocks with batches
    const stocks = await prisma.inventoryStock.findMany({
      include: {
        batches: true,
        inventory: true,
        item: true,
      },
    });

    console.log(`Found ${stocks.length} stock items to check\n`);

    for (const stock of stocks) {
      const batchSum = stock.batches.reduce(
        (sum, batch) => sum.add(batch.quantity),
        new Prisma.Decimal(0)
      );

      const difference = batchSum.sub(stock.quantity);
      const tolerance = new Prisma.Decimal(0.01);

      // Skip if quantities match (within tolerance)
      if (difference.abs().lte(tolerance)) {
        continue;
      }

      // Case 1: Stock has quantity but no batches
      if (stock.batches.length === 0 && stock.quantity.gt(0)) {
        this.actions.push({
          type: 'CREATE_MISSING_BATCHES',
          inventoryId: stock.inventoryId,
          inventoryName: stock.inventory.name,
          itemId: stock.itemId,
          itemName: stock.item.name,
          description: 'Create batch for stock without batches',
          oldValue: `Stock: ${stock.quantity.toString()}, Batches: 0`,
          newValue: `Stock: ${stock.quantity.toString()}, Batches: 1 (${stock.quantity.toString()})`,
        });

        if (!this.dryRun) {
          await prisma.stockBatch.create({
            data: {
              inventoryId: stock.inventoryId,
              itemId: stock.itemId,
              quantity: stock.quantity,
              notes: 'Repaired: Created batch for existing stock',
            },
          });
        }
      }
      // Case 2: Batch sum is higher than stock (batches not fully consumed)
      else if (batchSum.gt(stock.quantity)) {
        // Option: Update stock to match batch sum (more accurate)
        this.actions.push({
          type: 'UPDATE_STOCK_FROM_BATCHES',
          inventoryId: stock.inventoryId,
          inventoryName: stock.inventory.name,
          itemId: stock.itemId,
          itemName: stock.item.name,
          description: 'Update stock quantity to match batch sum',
          oldValue: stock.quantity.toString(),
          newValue: batchSum.toString(),
        });

        if (!this.dryRun) {
          await prisma.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: stock.inventoryId,
                itemId: stock.itemId,
              },
            },
            data: {
              quantity: batchSum,
            },
          });
        }
      }
      // Case 3: Stock is higher than batch sum (batches missing or consumed incorrectly)
      else if (stock.quantity.gt(batchSum)) {
        // Option: Create a batch for the difference
        const missingQty = stock.quantity.sub(batchSum);
        this.actions.push({
          type: 'CREATE_MISSING_BATCHES',
          inventoryId: stock.inventoryId,
          inventoryName: stock.inventory.name,
          itemId: stock.itemId,
          itemName: stock.item.name,
          description: `Create batch for missing quantity (${missingQty.toString()})`,
          oldValue: `Stock: ${stock.quantity.toString()}, Batches: ${batchSum.toString()}`,
          newValue: `Stock: ${stock.quantity.toString()}, Batches: ${stock.quantity.toString()}`,
        });

        if (!this.dryRun) {
          await prisma.stockBatch.create({
            data: {
              inventoryId: stock.inventoryId,
              itemId: stock.itemId,
              quantity: missingQty,
              notes: 'Repaired: Created batch for missing quantity',
            },
          });
        }
      }
    }

    this.generateReport();
  }

  /**
   * Generate repair report
   */
  generateReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('📊 STOCK-BATCH SYNC REPAIR REPORT');
    console.log('='.repeat(80) + '\n');

    const byType = {
      CREATE_MISSING_BATCHES: this.actions.filter(a => a.type === 'CREATE_MISSING_BATCHES'),
      UPDATE_STOCK_FROM_BATCHES: this.actions.filter(a => a.type === 'UPDATE_STOCK_FROM_BATCHES'),
      UPDATE_BATCHES_FROM_STOCK: this.actions.filter(a => a.type === 'UPDATE_BATCHES_FROM_STOCK'),
    };

    console.log('📈 SUMMARY');
    console.log('-'.repeat(80));
    console.log(`Total items to repair: ${this.actions.length}`);
    console.log(`  - Create missing batches: ${byType.CREATE_MISSING_BATCHES.length}`);
    console.log(`  - Update stock from batches: ${byType.UPDATE_STOCK_FROM_BATCHES.length}`);
    console.log(`  - Update batches from stock: ${byType.UPDATE_BATCHES_FROM_STOCK.length}\n`);

    if (this.actions.length === 0) {
      console.log('✅ No repairs needed!\n');
      return;
    }

    console.log('🔧 REPAIR ACTIONS');
    console.log('-'.repeat(80));

    // Show first 20 items
    this.actions.slice(0, 20).forEach((action, idx) => {
      console.log(`\n${idx + 1}. ${action.itemName} (${action.inventoryName})`);
      console.log(`   Type: ${action.type}`);
      console.log(`   ${action.description}`);
      console.log(`   Old: ${action.oldValue}`);
      console.log(`   New: ${action.newValue}`);
    });

    if (this.actions.length > 20) {
      console.log(`\n... and ${this.actions.length - 20} more items\n`);
    }

    if (this.dryRun) {
      console.log('\n⚠️  DRY RUN MODE - No changes were made');
      console.log('Run with --apply flag to apply changes\n');
    } else {
      console.log('\n✅ Repairs applied successfully!\n');
    }

    console.log('='.repeat(80) + '\n');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  const repairer = new StockBatchRepairer(dryRun);

  try {
    await repairer.repairAll();
  } catch (error) {
    console.error('Error during repair:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

