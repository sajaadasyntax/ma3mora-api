/**
 * Backfill initialQuantity for existing procurement receipt stock batches.
 *
 * Problem: StockBatch.quantity is mutable (decremented by sales, transfers,
 * adjustments). The procurement detail page was reading quantity to compute
 * delivery status, making fully-received orders look "partial" after sales.
 *
 * This script reconstructs the original received quantity per batch:
 *   initialQuantity = current quantity + consumed via InventoryDeliveryBatch
 *
 * It then cross-validates against the procurement order's ordered quantities:
 * - For RECEIVED orders, the per-item total should match ordered qty.
 * - Discrepancies (from transfers/adjustments) are flagged as warnings.
 *
 * Run modes:
 *   tsx scripts/backfill-initial-quantity.ts               # Dry run
 *   tsx scripts/backfill-initial-quantity.ts --apply        # Apply changes
 *   tsx scripts/backfill-initial-quantity.ts --order PO-123 # Check specific order
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface BatchUpdate {
  batchId: string;
  itemName: string;
  orderNumber: string;
  currentQty: Prisma.Decimal;
  deliveryConsumed: Prisma.Decimal;
  computedInitial: Prisma.Decimal;
}

interface OrderWarning {
  orderNumber: string;
  itemName: string;
  orderedQty: string;
  reconstructedQty: string;
  difference: string;
}

class InitialQuantityBackfiller {
  private updates: BatchUpdate[] = [];
  private warnings: OrderWarning[] = [];
  private skipped = 0;
  private dryRun: boolean;

  constructor(dryRun: boolean) {
    this.dryRun = dryRun;
  }

  async run(specificOrder?: string): Promise<void> {
    console.log('='.repeat(80));
    console.log('  BACKFILL initialQuantity FOR PROCUREMENT RECEIPT BATCHES');
    console.log('='.repeat(80));
    console.log(`Mode: ${this.dryRun ? 'DRY RUN (no changes)' : 'APPLY (will update DB)'}\n`);

    const where: any = {
      receipts: { some: {} },
    };
    if (specificOrder) {
      where.orderNumber = specificOrder;
    }

    const orders = await prisma.procOrder.findMany({
      where,
      include: {
        items: { include: { item: true, giftItem: true } },
        receipts: {
          include: {
            batches: {
              include: {
                item: true,
                deliveryBatches: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log(`Found ${orders.length} procurement orders with receipts\n`);

    for (const order of orders) {
      await this.processOrder(order);
    }

    this.generateReport();

    if (!this.dryRun && this.updates.length > 0) {
      await this.applyUpdates();
    }
  }

  private async processOrder(order: any): Promise<void> {
    const reconstructedByItem: Record<string, Prisma.Decimal> = {};

    for (const receipt of order.receipts) {
      for (const batch of receipt.batches) {
        if (batch.initialQuantity !== null) {
          this.skipped++;
          const iq = new Prisma.Decimal(batch.initialQuantity);
          reconstructedByItem[batch.itemId] = (reconstructedByItem[batch.itemId] || new Prisma.Decimal(0)).add(iq);
          continue;
        }

        const currentQty = new Prisma.Decimal(batch.quantity);

        const deliveryConsumed = batch.deliveryBatches.reduce(
          (sum: Prisma.Decimal, db: any) => sum.add(new Prisma.Decimal(db.quantity)),
          new Prisma.Decimal(0),
        );

        const computedInitial = currentQty.add(deliveryConsumed);

        reconstructedByItem[batch.itemId] = (reconstructedByItem[batch.itemId] || new Prisma.Decimal(0)).add(computedInitial);

        this.updates.push({
          batchId: batch.id,
          itemName: batch.item.name,
          orderNumber: order.orderNumber,
          currentQty,
          deliveryConsumed,
          computedInitial,
        });
      }
    }

    if (order.status === 'RECEIVED') {
      for (const item of order.items) {
        const orderedMain = new Prisma.Decimal(item.quantity).add(item.giftQty || 0);
        const reconstructed = reconstructedByItem[item.itemId] || new Prisma.Decimal(0);
        const diff = orderedMain.sub(reconstructed);

        if (diff.abs().gt(new Prisma.Decimal('0.01'))) {
          this.warnings.push({
            orderNumber: order.orderNumber,
            itemName: item.item.name,
            orderedQty: orderedMain.toString(),
            reconstructedQty: reconstructed.toString(),
            difference: diff.toString(),
          });
        }

        if (item.giftItemId && item.giftQuantity) {
          const orderedGift = new Prisma.Decimal(item.giftQuantity);
          const reconstructedGift = reconstructedByItem[item.giftItemId] || new Prisma.Decimal(0);
          const giftDiff = orderedGift.sub(reconstructedGift);

          if (giftDiff.abs().gt(new Prisma.Decimal('0.01'))) {
            this.warnings.push({
              orderNumber: order.orderNumber,
              itemName: `${item.giftItem?.name || item.giftItemId} (هدية)`,
              orderedQty: orderedGift.toString(),
              reconstructedQty: reconstructedGift.toString(),
              difference: giftDiff.toString(),
            });
          }
        }
      }
    }
  }

  private async applyUpdates(): Promise<void> {
    console.log('\nApplying updates...');

    let applied = 0;
    for (const upd of this.updates) {
      await prisma.stockBatch.update({
        where: { id: upd.batchId },
        data: { initialQuantity: upd.computedInitial },
      });
      applied++;

      if (applied % 100 === 0) {
        console.log(`  ...updated ${applied}/${this.updates.length} batches`);
      }
    }

    console.log(`  Done: updated ${applied} batches\n`);
  }

  private generateReport(): void {
    console.log('\n' + '='.repeat(80));
    console.log('  BACKFILL REPORT');
    console.log('='.repeat(80) + '\n');

    console.log('SUMMARY');
    console.log('-'.repeat(60));
    console.log(`  Batches to update : ${this.updates.length}`);
    console.log(`  Batches skipped   : ${this.skipped} (already have initialQuantity)`);
    console.log(`  Warnings          : ${this.warnings.length}`);

    const withConsumption = this.updates.filter(u => u.deliveryConsumed.gt(0));
    console.log(`  Had sales consumption : ${withConsumption.length}`);
    console.log('');

    if (this.updates.length > 0) {
      console.log('BATCH UPDATES (first 30)');
      console.log('-'.repeat(60));

      this.updates.slice(0, 30).forEach((u, i) => {
        console.log(
          `  ${i + 1}. [${u.orderNumber}] ${u.itemName}` +
          `  current=${u.currentQty} + consumed=${u.deliveryConsumed}` +
          `  => initialQuantity=${u.computedInitial}`,
        );
      });

      if (this.updates.length > 30) {
        console.log(`  ... and ${this.updates.length - 30} more\n`);
      }
    }

    if (this.warnings.length > 0) {
      console.log('\nWARNINGS (reconstructed total != ordered qty)');
      console.log('-'.repeat(60));
      console.log('These orders may have had transfers or manual adjustments.');
      console.log('Review them manually and correct initialQuantity if needed.\n');

      this.warnings.forEach((w, i) => {
        console.log(
          `  ${i + 1}. [${w.orderNumber}] ${w.itemName}` +
          `  ordered=${w.orderedQty}  reconstructed=${w.reconstructedQty}` +
          `  diff=${w.difference}`,
        );
      });
    }

    console.log('');

    if (this.dryRun) {
      console.log('DRY RUN - No changes were made');
      console.log('Run with --apply flag to apply changes\n');
    } else if (this.updates.length > 0) {
      console.log('Changes applied successfully!\n');
    }

    if (this.warnings.length > 0) {
      console.log(
        'NOTE: For warned orders, the script set initialQuantity based on\n' +
        'delivery batch records. If stock was also consumed by transfers or\n' +
        'manual adjustments, the value may be lower than the actual received\n' +
        'quantity. For RECEIVED orders, you can manually set initialQuantity\n' +
        'so the per-item total matches the ordered quantity.\n',
      );
    }

    console.log('='.repeat(80) + '\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  const orderFlag = args.indexOf('--order');
  const specificOrder = orderFlag !== -1 ? args[orderFlag + 1] : undefined;

  const backfiller = new InitialQuantityBackfiller(dryRun);

  try {
    await backfiller.run(specificOrder);
  } catch (error) {
    console.error('Error during backfill:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
