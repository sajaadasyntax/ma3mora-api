import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface DuplicateIssue {
  type: 'DUPLICATE_BATCH' | 'DUPLICATE_RECEIPT';
  description: string;
  itemId: string;
  itemName: string;
  receiptId?: string;
  batchId?: string;
  quantity: Prisma.Decimal;
  action: 'DELETE' | 'UPDATE';
}

class ProcurementOrderDuplicateRemover {
  private orderId?: string;
  private orderNumber?: string;
  private issues: DuplicateIssue[] = [];
  private dryRun: boolean;

  constructor(orderIdOrNumber: string, dryRun: boolean = true) {
    // Check if it looks like an order number (PO-XXXXXX) or ID (cuid)
    if (orderIdOrNumber.toUpperCase().startsWith('PO-')) {
      this.orderNumber = orderIdOrNumber.toUpperCase();
    } else {
      this.orderId = orderIdOrNumber;
    }
    this.dryRun = dryRun;
  }

  /**
   * Find and remove duplicates for the specified procurement order
   */
  async removeDuplicates(): Promise<void> {
    console.log('🔍 Finding duplicates for procurement order...\n');

    // Find order
    const order = await prisma.procOrder.findFirst({
      where: this.orderId
        ? { id: this.orderId }
        : { orderNumber: this.orderNumber },
      include: {
        items: {
          include: {
            item: true,
            giftItem: true,
          },
        },
        receipts: {
          include: {
            batches: {
              include: {
                item: true,
              },
            },
          },
          orderBy: {
            receivedAt: 'asc',
          },
        },
      },
    });

    if (!order) {
      console.error(`❌ Procurement order not found: ${this.orderId || this.orderNumber}`);
      process.exit(1);
    }

    console.log(`Found order: ${order.orderNumber} (${order.id})\n`);

    // Check for duplicate batches in receipts
    // Duplicates: same itemId + same expiryDate in same receipt
    for (const receipt of order.receipts) {
      // Group batches by itemId + expiryDate
      const batchGroups = new Map<string, typeof receipt.batches>();

      for (const batch of receipt.batches) {
        // Create key: itemId|expiryDate (null expiry becomes 'no-expiry')
        const expiryKey = batch.expiryDate 
          ? batch.expiryDate.toISOString().split('T')[0] 
          : 'no-expiry';
        const key = `${batch.itemId}|${expiryKey}`;

        if (!batchGroups.has(key)) {
          batchGroups.set(key, []);
        }
        batchGroups.get(key)!.push(batch);
      }

      // Find duplicates (more than one batch with same itemId + expiryDate)
      for (const [key, batches] of batchGroups.entries()) {
        if (batches.length > 1) {
          const [itemId, expiryKey] = key.split('|');
          const itemName = batches[0].item.name;
          const totalQuantity = batches.reduce(
            (sum, batch) => sum.add(batch.quantity),
            new Prisma.Decimal(0)
          );

          console.log(`⚠️  Found ${batches.length} duplicate batches for ${itemName}`);
          console.log(`   Receipt: ${receipt.id}`);
          console.log(`   Expiry: ${expiryKey === 'no-expiry' ? 'None' : expiryKey}`);
          console.log(`   Total quantity: ${totalQuantity.toString()}`);

          // Keep the first batch, mark others for deletion
          for (let i = 1; i < batches.length; i++) {
            this.issues.push({
              type: 'DUPLICATE_BATCH',
              description: `Duplicate batch #${i + 1} for ${itemName} (expiry: ${expiryKey === 'no-expiry' ? 'None' : expiryKey})`,
              itemId: itemId,
              itemName: itemName,
              receiptId: receipt.id,
              batchId: batches[i].id,
              quantity: batches[i].quantity,
              action: 'DELETE',
            });
          }

          // Update first batch with total quantity
          this.issues.push({
            type: 'DUPLICATE_BATCH',
            description: `Update first batch with total quantity for ${itemName}`,
            itemId: itemId,
            itemName: itemName,
            receiptId: receipt.id,
            batchId: batches[0].id,
            quantity: totalQuantity,
            action: 'UPDATE',
          });
        }
      }
    }

    // Also check for duplicate receipts (same order received multiple times)
    // This is less common but can happen
    if (order.receipts.length > 1) {
      // Group receipts by date (same day receipts might be duplicates)
      const receiptsByDate = new Map<string, typeof order.receipts>();
      
      for (const receipt of order.receipts) {
        const dateKey = receipt.receivedAt.toISOString().split('T')[0];
        if (!receiptsByDate.has(dateKey)) {
          receiptsByDate.set(dateKey, []);
        }
        receiptsByDate.get(dateKey)!.push(receipt);
      }

      // Check if multiple receipts on same day have same batches
      for (const [dateKey, receipts] of receiptsByDate.entries()) {
        if (receipts.length > 1) {
          console.log(`⚠️  Found ${receipts.length} receipts on ${dateKey}`);
          // This is informational - we'll handle batch-level duplicates above
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
        if (action.receiptId) console.log(`   Receipt ID: ${action.receiptId}`);
        if (action.batchId) console.log(`   Batch ID: ${action.batchId}`);
      });

      console.log('\n📋 UPDATE ACTIONS:');
      updateActions.forEach((action, idx) => {
        console.log(`\n${idx + 1}. ${action.description}`);
        console.log(`   Type: ${action.type}`);
        console.log(`   Item: ${action.itemName}`);
        console.log(`   New Quantity: ${action.quantity.toString()}`);
        if (action.receiptId) console.log(`   Receipt ID: ${action.receiptId}`);
        if (action.batchId) console.log(`   Batch ID: ${action.batchId}`);
      });

      console.log('\n⚠️  DRY RUN MODE - No changes were made');
      console.log('Run with --apply flag to apply changes\n');
      return;
    }

    // Apply changes in transaction
    try {
      await prisma.$transaction(async (tx) => {
        // Process deletions first
        for (const action of deleteActions) {
          if (action.type === 'DUPLICATE_BATCH' && action.batchId) {
            console.log(`Deleting batch: ${action.batchId} (${action.itemName})`);
            
            // Get batch to check current stock
            const batch = await tx.stockBatch.findUnique({
              where: { id: action.batchId },
            });

            if (batch) {
              // Decrement stock quantity before deleting batch
              await tx.inventoryStock.update({
                where: {
                  inventoryId_itemId: {
                    inventoryId: batch.inventoryId,
                    itemId: batch.itemId,
                  },
                },
                data: {
                  quantity: {
                    decrement: batch.quantity,
                  },
                },
              });
            }

            await tx.stockBatch.delete({
              where: { id: action.batchId },
            });
          }
        }

        // Process updates
        for (const action of updateActions) {
          if (action.type === 'DUPLICATE_BATCH' && action.batchId) {
            console.log(`Updating batch: ${action.batchId} to quantity ${action.quantity.toString()}`);
            
            // Get batch to calculate stock adjustment
            const batch = await tx.stockBatch.findUnique({
              where: { id: action.batchId },
            });

            if (batch) {
              const oldQty = batch.quantity;
              const newQty = action.quantity;
              const difference = newQty.sub(oldQty);

              // Update batch quantity
              await tx.stockBatch.update({
                where: { id: action.batchId },
                data: { quantity: newQty },
              });

              // Adjust stock quantity
              if (difference.gt(0)) {
                await tx.inventoryStock.update({
                  where: {
                    inventoryId_itemId: {
                      inventoryId: batch.inventoryId,
                      itemId: batch.itemId,
                    },
                  },
                  data: {
                    quantity: {
                      increment: difference,
                    },
                  },
                });
              } else if (difference.lt(0)) {
                await tx.inventoryStock.update({
                  where: {
                    inventoryId_itemId: {
                      inventoryId: batch.inventoryId,
                      itemId: batch.itemId,
                    },
                  },
                  data: {
                    quantity: {
                      decrement: difference.abs(),
                    },
                  },
                });
              }
            }
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
    console.error('Usage: tsx scripts/remove-po-duplicates.ts <order-number-or-id> [--apply]');
    console.error('Example: tsx scripts/remove-po-duplicates.ts PO-000052');
    console.error('Example: tsx scripts/remove-po-duplicates.ts PO-000052 --apply');
    process.exit(1);
  }

  const orderIdOrNumber = args[0];
  const dryRun = !args.includes('--apply');

  const remover = new ProcurementOrderDuplicateRemover(orderIdOrNumber, dryRun);

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

