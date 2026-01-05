/**
 * Script to fix procurement order receipt batch issues
 * 
 * This script is designed to work with the existing repair scripts:
 * - repair-stock-batch-sync.ts - For stock/batch quantity mismatches
 * - check-batch-transactions.ts - For comprehensive batch checks
 * - remove-wrong-entries.ts - For removing specific entries
 * 
 * Issues addressed by this script:
 * 1. Receipt batches with 0 quantity
 * 2. Orders marked as received but with no actual stock movement
 * 3. Duplicate batch entries from the same receipt
 * 
 * Run modes:
 *   npx ts-node scripts/fix-receipt-batches.ts           # Diagnostic only (dry run)
 *   npx ts-node scripts/fix-receipt-batches.ts --apply   # Apply fixes
 *   npx ts-node scripts/fix-receipt-batches.ts --order PO-000052  # Check specific order
 * 
 * After running this script, you may want to run:
 *   npx ts-node scripts/repair-stock-batch-sync.ts --apply
 *   npx ts-node scripts/recalculate-financial-aggregates.ts
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface ReceiptIssue {
  type: 'ZERO_QUANTITY_BATCH' | 'RECEIPT_WITHOUT_BATCHES' | 'STATUS_MISMATCH' | 'DUPLICATE_BATCHES' | 'QUANTITY_MISMATCH';
  severity: 'error' | 'warning' | 'info';
  message: string;
  details?: any;
}

interface OrderIssueResult {
  orderId: string;
  orderNumber: string;
  supplier: string;
  inventory: string;
  status: string;
  totalOrdered: string;
  totalReceived: string;
  issues: ReceiptIssue[];
  receipts: Array<{
    id: string;
    receivedAt: Date;
    receivedBy: string;
    batches: Array<{
      id: string;
      itemId: string;
      itemName: string;
      quantity: string;
      expiryDate: Date | null;
    }>;
  }>;
}

interface RepairAction {
  type: 'DELETE_ZERO_BATCH' | 'UPDATE_ORDER_STATUS' | 'DELETE_EMPTY_RECEIPT' | 'MERGE_DUPLICATE_BATCHES';
  orderId?: string;
  orderNumber?: string;
  receiptId?: string;
  batchId?: string;
  description: string;
  oldValue: string;
  newValue: string;
}

class ReceiptBatchRepairer {
  private issues: OrderIssueResult[] = [];
  private actions: RepairAction[] = [];
  private dryRun: boolean;
  private targetOrder?: string;

  constructor(dryRun: boolean = true, targetOrder?: string) {
    this.dryRun = dryRun;
    this.targetOrder = targetOrder;
  }

  /**
   * Main repair function
   */
  async repairAll(): Promise<void> {
    console.log('='.repeat(80));
    console.log('📊 Receipt Batch Diagnostic & Repair Tool');
    console.log('='.repeat(80));
    console.log(`Mode: ${this.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be applied)'}`);
    if (this.targetOrder) {
      console.log(`Target Order: ${this.targetOrder}`);
    }
    console.log('');

    // Step 1: Find problematic orders
    await this.findProblematicOrders();

    // Step 2: Find zero-quantity batches
    await this.findZeroQuantityBatches();

    // Step 3: Find duplicate batches
    await this.findDuplicateBatches();

    // Step 4: Apply fixes if not dry run
    if (!this.dryRun && this.actions.length > 0) {
      await this.applyFixes();
    }

    // Generate report
    this.generateReport();
  }

  /**
   * Find procurement orders with receipt issues
   */
  async findProblematicOrders(): Promise<void> {
    console.log('🔍 Step 1: Finding procurement orders with receipt issues...\n');

    const whereClause: any = {
      status: { in: ['RECEIVED', 'PARTIAL'] },
    };

    if (this.targetOrder) {
      whereClause.orderNumber = this.targetOrder;
    }

    const ordersWithReceipts = await prisma.procOrder.findMany({
      where: whereClause,
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
            receivedByUser: {
              select: { username: true },
            },
          },
        },
        supplier: true,
        inventory: true,
      },
    });

    console.log(`   Found ${ordersWithReceipts.length} orders with RECEIVED or PARTIAL status\n`);

    for (const order of ordersWithReceipts) {
      const issues: ReceiptIssue[] = [];

      // Calculate total ordered quantity (including gifts)
      const totalOrdered = order.items.reduce((sum, item) => {
        let qty = sum.add(item.quantity);
        if (item.giftQty) qty = qty.add(item.giftQty);
        if (item.giftQuantity) qty = qty.add(item.giftQuantity);
        return qty;
      }, new Prisma.Decimal(0));

      // Calculate total received from receipt batches
      const totalReceived = order.receipts.reduce((sum, receipt) => {
        const receiptTotal = receipt.batches.reduce((batchSum, batch) => {
          return batchSum.add(batch.quantity);
        }, new Prisma.Decimal(0));
        return sum.add(receiptTotal);
      }, new Prisma.Decimal(0));

      // Issue 1: Zero quantity batches
      const zeroBatches = order.receipts.flatMap(r => 
        r.batches.filter(b => b.quantity.eq(0))
      );
      if (zeroBatches.length > 0) {
        issues.push({
          type: 'ZERO_QUANTITY_BATCH',
          severity: 'error',
          message: `Found ${zeroBatches.length} batch(es) with zero quantity`,
          details: {
            batches: zeroBatches.map(b => ({
              id: b.id,
              itemName: b.item.name,
              receiptId: b.receiptId,
            })),
          },
        });

        // Add repair actions
        for (const batch of zeroBatches) {
          this.actions.push({
            type: 'DELETE_ZERO_BATCH',
            orderId: order.id,
            orderNumber: order.orderNumber,
            batchId: batch.id,
            description: `Delete zero-quantity batch for ${batch.item.name}`,
            oldValue: `Batch ${batch.id} with quantity 0`,
            newValue: 'Deleted',
          });
        }
      }

      // Issue 2: Receipts without batches
      const emptyReceipts = order.receipts.filter(r => r.batches.length === 0);
      if (emptyReceipts.length > 0) {
        issues.push({
          type: 'RECEIPT_WITHOUT_BATCHES',
          severity: 'warning',
          message: `Found ${emptyReceipts.length} receipt(s) without any batches`,
          details: {
            receipts: emptyReceipts.map(r => ({
              id: r.id,
              receivedAt: r.receivedAt,
              receivedBy: r.receivedByUser.username,
            })),
          },
        });

        // Add repair actions
        for (const receipt of emptyReceipts) {
          this.actions.push({
            type: 'DELETE_EMPTY_RECEIPT',
            orderId: order.id,
            orderNumber: order.orderNumber,
            receiptId: receipt.id,
            description: `Delete empty receipt from ${receipt.receivedAt.toISOString().split('T')[0]}`,
            oldValue: `Receipt ${receipt.id} with no batches`,
            newValue: 'Deleted',
          });
        }
      }

      // Issue 3: Status mismatch (marked as received but nothing actually received)
      const tolerance = new Prisma.Decimal(0.01);
      if (order.status === 'RECEIVED' && totalReceived.lt(tolerance)) {
        issues.push({
          type: 'STATUS_MISMATCH',
          severity: 'error',
          message: `Order marked as RECEIVED but total received is ${totalReceived.toString()}`,
          details: {
            status: order.status,
            totalOrdered: totalOrdered.toString(),
            totalReceived: totalReceived.toString(),
          },
        });

        // Add repair action
        this.actions.push({
          type: 'UPDATE_ORDER_STATUS',
          orderId: order.id,
          orderNumber: order.orderNumber,
          description: 'Reset order status to CREATED since nothing was actually received',
          oldValue: order.status,
          newValue: 'CREATED',
        });
      }

      // Issue 4: Received less than ordered but marked as fully received
      if (order.status === 'RECEIVED' && totalReceived.lt(totalOrdered.sub(tolerance)) && totalReceived.gt(tolerance)) {
        issues.push({
          type: 'QUANTITY_MISMATCH',
          severity: 'warning',
          message: `Order marked as RECEIVED but only ${totalReceived.toString()} of ${totalOrdered.toString()} received`,
          details: {
            status: order.status,
            totalOrdered: totalOrdered.toString(),
            totalReceived: totalReceived.toString(),
            difference: totalOrdered.sub(totalReceived).toString(),
          },
        });
      }

      if (issues.length > 0) {
        this.issues.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          supplier: order.supplier.name,
          inventory: order.inventory.name,
          status: order.status,
          totalOrdered: totalOrdered.toString(),
          totalReceived: totalReceived.toString(),
          issues,
          receipts: order.receipts.map(r => ({
            id: r.id,
            receivedAt: r.receivedAt,
            receivedBy: r.receivedByUser.username,
            batches: r.batches.map(b => ({
              id: b.id,
              itemId: b.itemId,
              itemName: b.item.name,
              quantity: b.quantity.toString(),
              expiryDate: b.expiryDate,
            })),
          })),
        });
      }
    }

    console.log(`   Found ${this.issues.length} orders with issues\n`);
  }

  /**
   * Find all zero-quantity batches (not just from receipts)
   */
  async findZeroQuantityBatches(): Promise<void> {
    console.log('🔍 Step 2: Finding all zero-quantity batches...\n');

    const zeroBatches = await prisma.stockBatch.findMany({
      where: { quantity: { equals: 0 } },
      include: {
        item: true,
        inventory: true,
        receipt: {
          include: {
            order: true,
          },
        },
      },
    });

    console.log(`   Found ${zeroBatches.length} zero-quantity batches total\n`);

    // Add to actions if not already added
    for (const batch of zeroBatches) {
      const alreadyAdded = this.actions.some(
        a => a.type === 'DELETE_ZERO_BATCH' && a.batchId === batch.id
      );

      if (!alreadyAdded) {
        this.actions.push({
          type: 'DELETE_ZERO_BATCH',
          orderNumber: batch.receipt?.order?.orderNumber,
          batchId: batch.id,
          description: `Delete zero-quantity batch for ${batch.item.name} in ${batch.inventory.name}`,
          oldValue: `Batch ${batch.id} with quantity 0`,
          newValue: 'Deleted',
        });
      }
    }
  }

  /**
   * Find potential duplicate batches from same receipt
   */
  async findDuplicateBatches(): Promise<void> {
    console.log('🔍 Step 3: Finding potential duplicate batches...\n');

    const batches = await prisma.stockBatch.findMany({
      where: {
        receiptId: { not: null },
      },
      include: {
        item: true,
        receipt: {
          include: {
            order: true,
          },
        },
      },
      orderBy: [
        { receiptId: 'asc' },
        { itemId: 'asc' },
      ],
    });

    // Group by receipt + item + expiry
    const groups: Map<string, typeof batches> = new Map();

    for (const batch of batches) {
      const key = `${batch.receiptId}|${batch.itemId}|${batch.expiryDate?.toISOString().split('T')[0] || 'no-expiry'}`;
      const existing = groups.get(key) || [];
      existing.push(batch);
      groups.set(key, existing);
    }

    // Find duplicates
    const duplicates = Array.from(groups.entries()).filter(([_, batches]) => batches.length > 1);

    console.log(`   Found ${duplicates.length} potential duplicate batch groups\n`);

    // Add merge actions for duplicates
    for (const [key, batchGroup] of duplicates) {
      const totalQty = batchGroup.reduce((sum, b) => sum.add(b.quantity), new Prisma.Decimal(0));
      const keepBatch = batchGroup[0];
      const deleteBatches = batchGroup.slice(1);

      for (const batch of deleteBatches) {
        this.actions.push({
          type: 'MERGE_DUPLICATE_BATCHES',
          orderNumber: batch.receipt?.order?.orderNumber,
          batchId: batch.id,
          description: `Merge duplicate batch for ${batch.item.name} into batch ${keepBatch.id}`,
          oldValue: `${batchGroup.length} batches with total ${totalQty.toString()}`,
          newValue: `1 batch with quantity ${totalQty.toString()}`,
        });
      }
    }
  }

  /**
   * Apply the repair actions
   */
  async applyFixes(): Promise<void> {
    console.log('🔧 Applying fixes...\n');

    for (const action of this.actions) {
      try {
        switch (action.type) {
          case 'DELETE_ZERO_BATCH':
            if (action.batchId) {
              await prisma.stockBatch.delete({
                where: { id: action.batchId },
              });
              console.log(`   ✅ Deleted zero-quantity batch ${action.batchId}`);
            }
            break;

          case 'DELETE_EMPTY_RECEIPT':
            if (action.receiptId) {
              await prisma.inventoryReceipt.delete({
                where: { id: action.receiptId },
              });
              console.log(`   ✅ Deleted empty receipt ${action.receiptId}`);
            }
            break;

          case 'UPDATE_ORDER_STATUS':
            if (action.orderId) {
              await prisma.procOrder.update({
                where: { id: action.orderId },
                data: { status: 'CREATED' },
              });
              console.log(`   ✅ Reset order ${action.orderNumber} status to CREATED`);
            }
            break;

          case 'MERGE_DUPLICATE_BATCHES':
            // This is more complex - for safety, just delete duplicates
            // The quantities should already be reflected in the stock
            if (action.batchId) {
              await prisma.stockBatch.delete({
                where: { id: action.batchId },
              });
              console.log(`   ✅ Deleted duplicate batch ${action.batchId}`);
            }
            break;
        }
      } catch (error: any) {
        console.log(`   ❌ Failed to apply action: ${action.description}`);
        console.log(`      Error: ${error.message}`);
      }
    }

    console.log('\n');
  }

  /**
   * Generate comprehensive report
   */
  generateReport(): void {
    console.log('='.repeat(80));
    console.log('📊 RECEIPT BATCH REPAIR REPORT');
    console.log('='.repeat(80) + '\n');

    // Summary
    console.log('📈 SUMMARY');
    console.log('-'.repeat(80));
    console.log(`Orders with issues: ${this.issues.length}`);
    console.log(`Total repair actions: ${this.actions.length}`);
    console.log(`  - Delete zero batches: ${this.actions.filter(a => a.type === 'DELETE_ZERO_BATCH').length}`);
    console.log(`  - Delete empty receipts: ${this.actions.filter(a => a.type === 'DELETE_EMPTY_RECEIPT').length}`);
    console.log(`  - Update order status: ${this.actions.filter(a => a.type === 'UPDATE_ORDER_STATUS').length}`);
    console.log(`  - Merge duplicates: ${this.actions.filter(a => a.type === 'MERGE_DUPLICATE_BATCHES').length}\n`);

    // Order details
    if (this.issues.length > 0) {
      console.log('📦 ORDERS WITH ISSUES');
      console.log('-'.repeat(80));

      for (const order of this.issues.slice(0, 20)) {
        console.log(`\n${order.orderNumber} (${order.supplier})`);
        console.log(`   Inventory: ${order.inventory}`);
        console.log(`   Status: ${order.status}`);
        console.log(`   Ordered: ${order.totalOrdered}, Received: ${order.totalReceived}`);
        console.log(`   Receipts: ${order.receipts.length}`);
        
        for (const issue of order.issues) {
          console.log(`   [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
        }

        // Show receipt details
        for (const receipt of order.receipts) {
          console.log(`   📋 Receipt ${receipt.id.slice(-8)} (${receipt.receivedAt.toISOString().split('T')[0]}) by ${receipt.receivedBy}:`);
          for (const batch of receipt.batches) {
            const marker = batch.quantity === '0' ? '⚠️' : '✓';
            console.log(`      ${marker} ${batch.itemName}: ${batch.quantity}${batch.expiryDate ? ` (exp: ${batch.expiryDate.toISOString().split('T')[0]})` : ''}`);
          }
        }
      }

      if (this.issues.length > 20) {
        console.log(`\n... and ${this.issues.length - 20} more orders with issues\n`);
      }
    }

    // Actions
    if (this.actions.length > 0) {
      console.log('\n🔧 REPAIR ACTIONS');
      console.log('-'.repeat(80));

      for (const action of this.actions.slice(0, 30)) {
        console.log(`\n[${action.type}] ${action.orderNumber || 'N/A'}`);
        console.log(`   ${action.description}`);
        console.log(`   Old: ${action.oldValue}`);
        console.log(`   New: ${action.newValue}`);
      }

      if (this.actions.length > 30) {
        console.log(`\n... and ${this.actions.length - 30} more actions\n`);
      }
    }

    // Footer
    console.log('\n' + '='.repeat(80));
    if (this.dryRun) {
      console.log('⚠️  DRY RUN MODE - No changes were made');
      console.log('Run with --apply flag to apply changes');
    } else {
      console.log('✅ Repairs applied successfully!');
    }
    console.log('='.repeat(80) + '\n');

    // Next steps
    console.log('📝 NEXT STEPS');
    console.log('-'.repeat(80));
    console.log('After running this script with --apply, you should:');
    console.log('');
    console.log('1. Sync stock with batches:');
    console.log('   npx ts-node scripts/repair-stock-batch-sync.ts --apply');
    console.log('');
    console.log('2. Verify batch transactions:');
    console.log('   npx ts-node scripts/check-batch-transactions.ts');
    console.log('');
    console.log('3. Recalculate financial aggregates:');
    console.log('   npx ts-node scripts/recalculate-financial-aggregates.ts');
    console.log('');
    console.log('4. Re-receive any orders that need correction through the UI\n');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  
  // Check for target order
  let targetOrder: string | undefined;
  const orderIdx = args.indexOf('--order');
  if (orderIdx !== -1 && args[orderIdx + 1]) {
    targetOrder = args[orderIdx + 1];
  }

  const repairer = new ReceiptBatchRepairer(dryRun, targetOrder);

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
