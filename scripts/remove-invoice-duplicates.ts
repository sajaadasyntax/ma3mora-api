import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface DuplicateIssue {
  type: 'DUPLICATE_DELIVERY_ITEM' | 'DUPLICATE_BATCH_TRACKING' | 'DUPLICATE_QUANTITY';
  description: string;
  itemId: string;
  itemName: string;
  deliveryId?: string;
  deliveryItemId?: string;
  batchTrackingId?: string;
  quantity: Prisma.Decimal;
  action: 'DELETE' | 'UPDATE';
}

class InvoiceDuplicateRemover {
  private invoiceId?: string;
  private invoiceNumber?: string;
  private issues: DuplicateIssue[] = [];
  private dryRun: boolean;

  constructor(invoiceIdOrNumber: string, dryRun: boolean = true) {
    // Check if it looks like an invoice number (INV-XXXXXX) or ID (cuid)
    if (invoiceIdOrNumber.startsWith('INV-')) {
      this.invoiceNumber = invoiceIdOrNumber;
    } else {
      this.invoiceId = invoiceIdOrNumber;
    }
    this.dryRun = dryRun;
  }

  /**
   * Find and remove duplicates for the specified invoice
   */
  async removeDuplicates(): Promise<void> {
    console.log('🔍 Finding duplicates for invoice...\n');

    // Find invoice
    const invoice = await prisma.salesInvoice.findFirst({
      where: this.invoiceId
        ? { id: this.invoiceId }
        : { invoiceNumber: this.invoiceNumber },
      include: {
        items: {
          include: {
            item: true,
          },
        },
        deliveries: {
          include: {
            items: {
              include: {
                item: true,
                batches: {
                  include: {
                    batch: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      console.error(`❌ Invoice not found: ${this.invoiceId || this.invoiceNumber}`);
      process.exit(1);
    }

    console.log(`Found invoice: ${invoice.invoiceNumber} (${invoice.id})\n`);

    // Check for duplicate delivery items (same itemId in same delivery)
    for (const delivery of invoice.deliveries) {
      const itemCounts = new Map<string, number>();
      const deliveryItemsByItem = new Map<string, typeof delivery.items>();

      for (const item of delivery.items) {
        const count = itemCounts.get(item.itemId) || 0;
        itemCounts.set(item.itemId, count + 1);

        if (!deliveryItemsByItem.has(item.itemId)) {
          deliveryItemsByItem.set(item.itemId, []);
        }
        deliveryItemsByItem.get(item.itemId)!.push(item);
      }

      // Find duplicates
      for (const [itemId, items] of deliveryItemsByItem.entries()) {
        if (items.length > 1) {
          // Multiple delivery items for same itemId - keep first, remove others
          const itemName = items[0].item.name;
          const totalQuantity = items.reduce(
            (sum, item) => sum.add(item.quantity),
            new Prisma.Decimal(0)
          );

          console.log(`⚠️  Found ${items.length} duplicate delivery items for ${itemName}`);
          console.log(`   Total quantity: ${totalQuantity.toString()}`);

          // Keep the first one, mark others for deletion
          for (let i = 1; i < items.length; i++) {
            this.issues.push({
              type: 'DUPLICATE_DELIVERY_ITEM',
              description: `Duplicate delivery item #${i + 1} for ${itemName}`,
              itemId: itemId,
              itemName: itemName,
              deliveryId: delivery.id,
              deliveryItemId: items[i].id,
              quantity: items[i].quantity,
              action: 'DELETE',
            });
          }

          // Update first item with total quantity
          this.issues.push({
            type: 'DUPLICATE_DELIVERY_ITEM',
            description: `Update first delivery item with total quantity`,
            itemId: itemId,
            itemName: itemName,
            deliveryId: delivery.id,
            deliveryItemId: items[0].id,
            quantity: totalQuantity,
            action: 'UPDATE',
          });
        }
      }

      // Check for duplicate batch tracking (same batchId in same delivery item)
      for (const deliveryItem of delivery.items) {
        const batchCounts = new Map<string, number>();
        const batchesByBatchId = new Map<string, typeof deliveryItem.batches>();

        for (const batchTracking of deliveryItem.batches) {
          const count = batchCounts.get(batchTracking.batchId) || 0;
          batchCounts.set(batchTracking.batchId, count + 1);

          if (!batchesByBatchId.has(batchTracking.batchId)) {
            batchesByBatchId.set(batchTracking.batchId, []);
          }
          batchesByBatchId.get(batchTracking.batchId)!.push(batchTracking);
        }

        // Find duplicate batch tracking
        for (const [batchId, batchTrackings] of batchesByBatchId.entries()) {
          if (batchTrackings.length > 1) {
            const itemName = deliveryItem.item.name;
            const totalQuantity = batchTrackings.reduce(
              (sum, bt) => sum.add(bt.quantity),
              new Prisma.Decimal(0)
            );

            console.log(`⚠️  Found ${batchTrackings.length} duplicate batch tracking records for ${itemName}`);
            console.log(`   Batch ID: ${batchId}`);
            console.log(`   Total quantity: ${totalQuantity.toString()}`);

            // Keep the first one, mark others for deletion
            for (let i = 1; i < batchTrackings.length; i++) {
              this.issues.push({
                type: 'DUPLICATE_BATCH_TRACKING',
                description: `Duplicate batch tracking #${i + 1} for ${itemName}`,
                itemId: deliveryItem.itemId,
                itemName: itemName,
                deliveryItemId: deliveryItem.id,
                batchTrackingId: batchTrackings[i].id,
                quantity: batchTrackings[i].quantity,
                action: 'DELETE',
              });
            }

            // Update first batch tracking with total quantity
            this.issues.push({
              type: 'DUPLICATE_BATCH_TRACKING',
              description: `Update first batch tracking with total quantity`,
              itemId: deliveryItem.itemId,
              itemName: itemName,
              deliveryItemId: deliveryItem.id,
              batchTrackingId: batchTrackings[0].id,
              quantity: totalQuantity,
              action: 'UPDATE',
            });
          }
        }
      }
    }

    if (this.issues.length === 0) {
      console.log('✅ No duplicates found!\n');
      return;
    }

    console.log(`\nFound ${this.issues.length} duplicate issues to fix\n`);
    this.applyFixes();
  }

  /**
   * Apply fixes for duplicates
   */
  async applyFixes(): Promise<void> {
    console.log('🔧 Applying fixes...\n');
    console.log(`Mode: ${this.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be applied)'}\n`);

    // Group by type and process
    const deleteActions = this.issues.filter(i => i.action === 'DELETE');
    const updateActions = this.issues.filter(i => i.action === 'UPDATE');

    console.log(`Actions to perform:`);
    console.log(`  - Delete: ${deleteActions.length}`);
    console.log(`  - Update: ${updateActions.length}\n`);

    if (this.dryRun) {
      // Show what would be done
      console.log('📋 DELETE ACTIONS:');
      deleteActions.forEach((action, idx) => {
        console.log(`\n${idx + 1}. ${action.description}`);
        console.log(`   Type: ${action.type}`);
        console.log(`   Item: ${action.itemName}`);
        console.log(`   Quantity: ${action.quantity.toString()}`);
        if (action.deliveryItemId) console.log(`   Delivery Item ID: ${action.deliveryItemId}`);
        if (action.batchTrackingId) console.log(`   Batch Tracking ID: ${action.batchTrackingId}`);
      });

      console.log('\n📋 UPDATE ACTIONS:');
      updateActions.forEach((action, idx) => {
        console.log(`\n${idx + 1}. ${action.description}`);
        console.log(`   Type: ${action.type}`);
        console.log(`   Item: ${action.itemName}`);
        console.log(`   New Quantity: ${action.quantity.toString()}`);
        if (action.deliveryItemId) console.log(`   Delivery Item ID: ${action.deliveryItemId}`);
        if (action.batchTrackingId) console.log(`   Batch Tracking ID: ${action.batchTrackingId}`);
      });

      console.log('\n⚠️  DRY RUN MODE - No changes were made');
      console.log('Run with --apply flag to apply changes\n');
      return;
    }

    // Apply changes in transaction
    try {
      await prisma.$transaction(async (tx) => {
        // Process deletions
        for (const action of deleteActions) {
          if (action.type === 'DUPLICATE_DELIVERY_ITEM' && action.deliveryItemId) {
            console.log(`Deleting delivery item: ${action.deliveryItemId}`);
            await tx.inventoryDeliveryItem.delete({
              where: { id: action.deliveryItemId },
            });
          } else if (action.type === 'DUPLICATE_BATCH_TRACKING' && action.batchTrackingId) {
            console.log(`Deleting batch tracking: ${action.batchTrackingId}`);
            await tx.inventoryDeliveryBatch.delete({
              where: { id: action.batchTrackingId },
            });
          }
        }

        // Process updates
        for (const action of updateActions) {
          if (action.type === 'DUPLICATE_DELIVERY_ITEM' && action.deliveryItemId) {
            console.log(`Updating delivery item: ${action.deliveryItemId} to quantity ${action.quantity.toString()}`);
            await tx.inventoryDeliveryItem.update({
              where: { id: action.deliveryItemId },
              data: { quantity: action.quantity },
            });
          } else if (action.type === 'DUPLICATE_BATCH_TRACKING' && action.batchTrackingId) {
            console.log(`Updating batch tracking: ${action.batchTrackingId} to quantity ${action.quantity.toString()}`);
            await tx.inventoryDeliveryBatch.update({
              where: { id: action.batchTrackingId },
              data: { quantity: action.quantity },
            });
          }
        }
      });

      console.log('\n✅ Fixes applied successfully!\n');
    } catch (error) {
      console.error('\n❌ Error applying fixes:', error);
      throw error;
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: tsx scripts/remove-invoice-duplicates.ts <invoice-id-or-number> [--apply]');
    console.error('Example: tsx scripts/remove-invoice-duplicates.ts INV-000174');
    console.error('Example: tsx scripts/remove-invoice-duplicates.ts INV-000174 --apply');
    process.exit(1);
  }

  const invoiceIdOrNumber = args[0];
  const dryRun = !args.includes('--apply');

  const remover = new InvoiceDuplicateRemover(invoiceIdOrNumber, dryRun);

  try {
    await remover.removeDuplicates();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

