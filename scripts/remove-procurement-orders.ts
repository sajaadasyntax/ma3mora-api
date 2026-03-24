/**
 * remove-procurement-orders.ts
 *
 * Safely removes specific procurement orders (numbers 6 and 7) along with
 * all related data, and corrects affected inventory stock levels.
 *
 * Deletion cascade (in order):
 *   1. InventoryDeliveryBatch records that reference the orders' stock batches
 *      (warns if stock was already consumed in sales deliveries)
 *   2. StockBatch records from those orders' receipts
 *      → InventoryStock.quantity is decremented for each batch removed
 *   3. ProcOrder (Cascade handles: ProcOrderItem, ProcOrderPayment,
 *      ProcOrderReturn, InventoryReceipt)
 *
 * Usage (dry-run, default):
 *   npx tsx scripts/remove-procurement-orders.ts
 *
 * Usage (apply):
 *   npx tsx scripts/remove-procurement-orders.ts --apply
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

// The order numbers to remove (as stored in the DB — adjust if prefixed)
const TARGET_NUMBERS = ['6', '7'];

async function main() {
  console.log(DRY_RUN
    ? '🔍  DRY-RUN mode — no changes will be written.\n'
    : '⚠️   APPLY mode — changes WILL be written.\n');

  // ── 1. Find orders ────────────────────────────────────────────────────────
  const orders = await prisma.procOrder.findMany({
    where: { orderNumber: { in: TARGET_NUMBERS } },
    include: {
      supplier: { select: { name: true } },
      items: { include: { item: { select: { name: true } } } },
      payments: true,
      receipts: {
        include: {
          batches: {
            include: {
              item: { select: { name: true } },
              deliveryBatches: {
                include: {
                  deliveryItem: {
                    include: {
                      delivery: { select: { id: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (orders.length === 0) {
    // Try common prefixed formats
    const prefixedOrders = await prisma.procOrder.findMany({
      where: {
        OR: TARGET_NUMBERS.flatMap(n => [
          { orderNumber: `PO-00${n}` },
          { orderNumber: `PO-0${n}` },
          { orderNumber: `PO-${n}` },
        ]),
      },
      select: { orderNumber: true },
    });
    if (prefixedOrders.length > 0) {
      console.error(
        `❌ Orders with numbers ${TARGET_NUMBERS.join(', ')} not found.\n` +
        `   Found similar orders: ${prefixedOrders.map(o => o.orderNumber).join(', ')}\n` +
        `   Update TARGET_NUMBERS in the script to match the exact order numbers.`
      );
    } else {
      console.error(`❌ No procurement orders found matching: ${TARGET_NUMBERS.join(', ')}`);
    }
    return;
  }

  // Warn if we didn't find all targets
  const foundNumbers = orders.map(o => o.orderNumber);
  const missing = TARGET_NUMBERS.filter(n => !foundNumbers.includes(n));
  if (missing.length > 0) {
    console.warn(`⚠️  Could not find orders: ${missing.join(', ')} — they may have already been deleted.\n`);
  }

  // ── 2. Print summary ──────────────────────────────────────────────────────
  for (const order of orders) {
    console.log(`\n═══ Order #${order.orderNumber} ═══`);
    console.log(`  Supplier : ${order.supplier.name}`);
    console.log(`  Status   : ${order.status}`);
    console.log(`  Total    : ${order.total}`);
    console.log(`  Paid     : ${order.paidAmount}`);
    console.log(`  Created  : ${order.createdAt.toISOString().slice(0, 10)}`);

    console.log(`  Items (${order.items.length}):`);
    for (const item of order.items) {
      console.log(`    - ${item.item.name}: qty ${item.quantity} @ ${item.unitCost} = ${item.lineTotal}`);
    }

    console.log(`  Payments (${order.payments.length}):`);
    for (const pmt of order.payments) {
      console.log(`    - ${pmt.amount} via ${pmt.method} on ${pmt.paidAt.toISOString().slice(0, 10)}`);
    }

    let totalBatches = 0;
    let usedBatches = 0;

    for (const receipt of order.receipts) {
      for (const batch of receipt.batches) {
        totalBatches++;
        const usedInDeliveries = batch.deliveryBatches.length;
        if (usedInDeliveries > 0) {
          usedBatches++;
          console.log(
            `  ⚠️  Stock batch for "${batch.item.name}" (qty: ${batch.quantity}) ` +
            `has been consumed in ${usedInDeliveries} delivery batch record(s) — ` +
            `those delivery records will also be removed.`
          );
        }
      }
    }

    console.log(`  Stock batches: ${totalBatches} (${usedBatches} already used in deliveries)`);
  }

  if (DRY_RUN) {
    console.log('\n✅  Dry-run complete. Re-run with --apply to execute.');
    return;
  }

  // ── 3. Apply in a transaction ─────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    for (const order of orders) {
      console.log(`\nRemoving order #${order.orderNumber}...`);

      for (const receipt of order.receipts) {
        for (const batch of receipt.batches) {

          // 3a. Delete InventoryDeliveryBatch records linked to this batch
          if (batch.deliveryBatches.length > 0) {
            const deliveryBatchIds = batch.deliveryBatches.map(db => db.id);
            await tx.inventoryDeliveryBatch.deleteMany({
              where: { id: { in: deliveryBatchIds } },
            });
            console.log(`  Deleted ${deliveryBatchIds.length} delivery batch record(s) for "${batch.item.name}".`);
          }

          // 3b. Subtract batch quantity from InventoryStock
          // Only subtract the current (remaining) quantity, not the initial quantity,
          // because consumed stock was already reflected in sales deliveries.
          const currentQty = new Prisma.Decimal(batch.quantity);
          if (currentQty.gt(0)) {
            await tx.inventoryStock.updateMany({
              where: {
                inventoryId: batch.inventoryId,
                itemId: batch.itemId,
              },
              data: {
                quantity: { decrement: currentQty },
              },
            });
            console.log(`  Decremented InventoryStock for "${batch.item.name}" by ${currentQty}.`);
          }

          // 3c. Delete the stock batch itself
          await tx.stockBatch.delete({ where: { id: batch.id } });
          console.log(`  Deleted stock batch: ${batch.id}`);
        }
      }

      // 3d. Delete the order — Cascade handles items, payments, returns, receipts
      await tx.procOrder.delete({ where: { id: order.id } });
      console.log(`✅  Deleted order #${order.orderNumber}.`);
    }
  });

  console.log('\n🏁  Done.');
  console.log(
    '\nNote: Daily financial aggregates (procurement totals) may be stale.\n' +
    'To recalculate them run:\n' +
    '  npx tsx scripts/recalculate-financial-aggregates.ts --apply'
  );
}

main()
  .catch(err => {
    console.error('\nError:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
