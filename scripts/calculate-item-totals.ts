import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface InvoiceTotals {
  totalQuantity: Prisma.Decimal;
  totalGiftQty: Prisma.Decimal; // Old system: same item as gift
  totalGiftQuantity: Prisma.Decimal; // New system: separate gift item
  totalLineTotal: Prisma.Decimal;
  invoiceCount: number;
}

interface InventoryReceipts {
  totalIncoming: Prisma.Decimal; // From stock movements
  totalIncomingGifts: Prisma.Decimal; // Gifts received from procurement
  totalBatches: Prisma.Decimal; // From stock batches
  batchCount: number;
}

class ItemTotalCalculator {
  private itemName: string;
  private itemId?: string;

  constructor(itemName: string) {
    this.itemName = itemName;
  }

  /**
   * Find the item by name
   */
  async findItem(): Promise<void> {
    const item = await prisma.item.findFirst({
      where: {
        name: {
          contains: this.itemName,
          mode: 'insensitive',
        },
      },
    });

    if (!item) {
      console.error(`❌ Item not found: ${this.itemName}`);
      console.log('\nAvailable items with similar names:');
      const similarItems = await prisma.item.findMany({
        where: {
          name: {
            contains: this.itemName.substring(0, Math.min(3, this.itemName.length)),
            mode: 'insensitive',
          },
        },
        take: 10,
      });
      similarItems.forEach(i => console.log(`  - ${i.name} (${i.id})`));
      throw new Error(`Item "${this.itemName}" not found`);
    }

    this.itemId = item.id;
    console.log(`✅ Found item: ${item.name} (${item.id})`);
    console.log(`   Section: ${item.section}\n`);
  }

  /**
   * Calculate totals from invoices
   */
  async calculateInvoiceTotals(): Promise<InvoiceTotals> {
    if (!this.itemId) {
      throw new Error('Item ID not found. Call findItem() first.');
    }

    console.log('📊 Calculating totals from invoices...\n');

    // Get all invoice items for this item
    const invoiceItems = await prisma.salesInvoiceItem.findMany({
      where: {
        itemId: this.itemId,
      },
      include: {
        invoice: {
          include: {
            inventory: true,
          },
        },
      },
    });

    let totalQuantity = new Prisma.Decimal(0);
    let totalGiftQty = new Prisma.Decimal(0); // Old system
    let totalGiftQuantity = new Prisma.Decimal(0); // New system - when this item is given as gift
    let totalLineTotal = new Prisma.Decimal(0);
    const invoiceIds = new Set<string>();

    for (const item of invoiceItems) {
      invoiceIds.add(item.invoiceId);
      totalQuantity = totalQuantity.add(item.quantity);
      totalGiftQty = totalGiftQty.add(item.giftQty || 0);
      totalLineTotal = totalLineTotal.add(item.lineTotal);
    }

    // Also check if this item is given as a gift in other invoices (new gift system)
    const giftItems = await prisma.salesInvoiceItem.findMany({
      where: {
        giftItemId: this.itemId,
      },
      include: {
        invoice: {
          include: {
            inventory: true,
          },
        },
      },
    });

    for (const giftItem of giftItems) {
      if (giftItem.giftQuantity) {
        totalGiftQuantity = totalGiftQuantity.add(giftItem.giftQuantity);
        invoiceIds.add(giftItem.invoiceId);
      }
    }

    console.log(`   Total invoices: ${invoiceIds.size}`);
    console.log(`   Total quantity sold: ${totalQuantity.toString()}`);
    console.log(`   Total gift quantity (old system - same item): ${totalGiftQty.toString()}`);
    console.log(`   Total gift quantity (new system - as gift): ${totalGiftQuantity.toString()}`);
    console.log(`   Total line total: ${totalLineTotal.toString()}`);
    console.log(`   Total quantity including all gifts: ${totalQuantity.add(totalGiftQty).add(totalGiftQuantity).toString()}\n`);

    return {
      totalQuantity,
      totalGiftQty,
      totalGiftQuantity,
      totalLineTotal,
      invoiceCount: invoiceIds.size,
    };
  }

  /**
   * Calculate amounts received to inventory
   */
  async calculateInventoryReceipts(): Promise<InventoryReceipts> {
    if (!this.itemId) {
      throw new Error('Item ID not found. Call findItem() first.');
    }

    console.log('📦 Calculating amounts received to inventory...\n');

    // Get all inventories
    const inventories = await prisma.inventory.findMany();
    
    let totalIncoming = new Prisma.Decimal(0);
    let totalIncomingGifts = new Prisma.Decimal(0);
    let totalBatches = new Prisma.Decimal(0);
    let batchCount = 0;

    for (const inventory of inventories) {
      // Calculate from stock movements
      const stockMovements = await prisma.stockMovement.findMany({
        where: {
          inventoryId: inventory.id,
          itemId: this.itemId,
        },
      });

      const inventoryIncoming = stockMovements.reduce(
        (sum, m) => sum.add(m.incoming),
        new Prisma.Decimal(0)
      );
      const inventoryGifts = stockMovements.reduce(
        (sum, m) => sum.add(m.incomingGifts),
        new Prisma.Decimal(0)
      );

      totalIncoming = totalIncoming.add(inventoryIncoming);
      totalIncomingGifts = totalIncomingGifts.add(inventoryGifts);

      // Calculate from stock batches
      const batches = await prisma.stockBatch.findMany({
        where: {
          inventoryId: inventory.id,
          itemId: this.itemId,
        },
      });

      const inventoryBatches = batches.reduce(
        (sum, b) => sum.add(b.quantity),
        new Prisma.Decimal(0)
      );

      totalBatches = totalBatches.add(inventoryBatches);
      batchCount += batches.length;

      if (inventoryIncoming.gt(0) || inventoryGifts.gt(0) || inventoryBatches.gt(0)) {
        console.log(`   ${inventory.name}:`);
        console.log(`     Stock Movements - Incoming: ${inventoryIncoming.toString()}, Gifts: ${inventoryGifts.toString()}`);
        console.log(`     Stock Batches: ${inventoryBatches.toString()} (${batches.length} batches)`);
      }
    }

    console.log(`\n   Total incoming (from stock movements): ${totalIncoming.toString()}`);
    console.log(`   Total incoming gifts (from stock movements): ${totalIncomingGifts.toString()}`);
    console.log(`   Total batches: ${totalBatches.toString()} (${batchCount} batches)`);
    console.log(`   Total received (incoming + gifts): ${totalIncoming.add(totalIncomingGifts).toString()}\n`);

    return {
      totalIncoming,
      totalIncomingGifts,
      totalBatches,
      batchCount,
    };
  }

  /**
   * Generate summary report
   */
  async generateReport(): Promise<void> {
    await this.findItem();

    const invoiceTotals = await this.calculateInvoiceTotals();
    const inventoryReceipts = await this.calculateInventoryReceipts();

    console.log('═══════════════════════════════════════════════════════════');
    console.log('📋 SUMMARY REPORT');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('INVOICE TOTALS:');
    console.log(`  Total quantity sold: ${invoiceTotals.totalQuantity.toString()}`);
    console.log(`  Total gift quantity (old system): ${invoiceTotals.totalGiftQty.toString()}`);
    console.log(`  Total gift quantity (new system): ${invoiceTotals.totalGiftQuantity.toString()}`);
    console.log(`  Total quantity including all gifts: ${invoiceTotals.totalQuantity.add(invoiceTotals.totalGiftQty).add(invoiceTotals.totalGiftQuantity).toString()}`);
    console.log(`  Total line total (value): ${invoiceTotals.totalLineTotal.toString()}`);
    console.log(`  Number of invoices: ${invoiceTotals.invoiceCount}\n`);

    console.log('INVENTORY RECEIPTS:');
    console.log(`  Total incoming (from stock movements): ${inventoryReceipts.totalIncoming.toString()}`);
    console.log(`  Total incoming gifts (from stock movements): ${inventoryReceipts.totalIncomingGifts.toString()}`);
    console.log(`  Total batches: ${inventoryReceipts.totalBatches.toString()}`);
    console.log(`  Total received (incoming + gifts): ${inventoryReceipts.totalIncoming.add(inventoryReceipts.totalIncomingGifts).toString()}`);
    console.log(`  Number of batches: ${inventoryReceipts.batchCount}\n`);

    // Calculate difference
    const totalSold = invoiceTotals.totalQuantity
      .add(invoiceTotals.totalGiftQty)
      .add(invoiceTotals.totalGiftQuantity);
    const totalReceived = inventoryReceipts.totalIncoming
      .add(inventoryReceipts.totalIncomingGifts);

    const difference = totalReceived.sub(totalSold);

    console.log('DIFFERENCE:');
    console.log(`  Total sold (including gifts): ${totalSold.toString()}`);
    console.log(`  Total received: ${totalReceived.toString()}`);
    console.log(`  Difference (received - sold): ${difference.toString()}`);
    
    if (difference.gt(0)) {
      console.log(`  ⚠️  More received than sold (remaining stock: ${difference.toString()})`);
    } else if (difference.lt(0)) {
      console.log(`  ⚠️  More sold than received (shortage: ${difference.abs().toString()})`);
    } else {
      console.log(`  ✅ Perfect match!`);
    }
    console.log('');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: tsx scripts/calculate-item-totals.ts <item-name>');
    console.error('Example: tsx scripts/calculate-item-totals.ts "الأول"');
    console.error('Example: tsx scripts/calculate-item-totals.ts "معكرونة"');
    await prisma.$disconnect();
    return;
  }

  const itemName = args[0];

  const calculator = new ItemTotalCalculator(itemName);

  try {
    await calculator.generateReport();
  } catch (error) {
    console.error('Error:', error);
    await prisma.$disconnect();
    return;
  } finally {
    await prisma.$disconnect();
  }
}

main();
