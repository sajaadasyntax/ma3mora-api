/// <reference types="node" />
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  console.log('🔧 Fixing January 13, 2026 Stock Movement Issues\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE (applying changes)'}\n`);

  const itemId = 'cmhui03br000o362uam2v9bjb'; // الاول
  const inventoryId = 'cmhui03b50009362u98yps6to'; // المخزن الرئيسي
  const targetDate = new Date('2026-01-13');

  // Issue 1: Batches with 0 quantity that should have the order quantity
  console.log('='.repeat(60));
  console.log('1️⃣ Fixing batches with 0 quantity');
  console.log('='.repeat(60));

  const zeroBatches = [
    { batchId: 'cmkcjv9hh0ffp129n64vf8lho', orderId: 'cmj47gr200hk4zym6bvlepqxt', expectedQty: 1500 }, // PO-1765624878070
    { batchId: 'cmkcjw4q10ffw129n058s95m8', orderId: 'cmiu8eek508ftzym6xf6gom70', expectedQty: 1500 }, // PO-1765021786419
  ];

  for (const fix of zeroBatches) {
    const batch = await prisma.stockBatch.findUnique({
      where: { id: fix.batchId },
      include: { 
        item: true,
        receipt: { include: { order: true } },
      },
    });

    if (!batch) {
      console.log(`❌ Batch ${fix.batchId} not found`);
      continue;
    }

    console.log(`\nBatch: ${batch.id}`);
    console.log(`  Item: ${batch.item.name}`);
    console.log(`  Current Quantity: ${batch.quantity.toString()}`);
    console.log(`  Expected Quantity: ${fix.expectedQty}`);
    console.log(`  Order: ${batch.receipt?.order?.orderNumber || 'N/A'}`);

    if (batch.quantity.equals(0)) {
      console.log(`  ✅ Will fix: Set quantity to ${fix.expectedQty}`);
      
      if (!dryRun) {
        await prisma.stockBatch.update({
          where: { id: fix.batchId },
          data: { quantity: fix.expectedQty },
        });
        console.log(`  ✅ Fixed!`);
      }
    } else {
      console.log(`  ℹ️ Batch already has quantity ${batch.quantity.toString()}, skipping`);
    }
  }

  // Issue 2: The stock movement for Jan 13 shows 10,705 but should match actual receipts
  // Actually, if the batches were 0, then the stock movement shouldn't have counted them
  // Let's check what the correct incoming should be
  
  console.log('\n');
  console.log('='.repeat(60));
  console.log('2️⃣ Checking Stock Movement for January 13, 2026');
  console.log('='.repeat(60));

  const movement = await prisma.stockMovement.findFirst({
    where: {
      inventoryId,
      itemId,
      movementDate: targetDate,
    },
  });

  if (!movement) {
    console.log('❌ Stock movement not found for January 13');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nCurrent Stock Movement:`);
  console.log(`  Opening: ${movement.openingBalance.toString()}`);
  console.log(`  Incoming: ${movement.incoming.toString()}`);
  console.log(`  Outgoing: ${movement.outgoing.toString()}`);
  console.log(`  Closing: ${movement.closingBalance.toString()}`);

  // Calculate what the incoming SHOULD be from actual batch quantities on that day
  const batchesOnDate = await prisma.stockBatch.findMany({
    where: {
      inventoryId,
      itemId,
      receivedAt: {
        gte: targetDate,
        lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000),
      },
    },
  });

  let actualBatchTotal = new Prisma.Decimal(0);
  console.log(`\nBatches received on January 13:`);
  for (const batch of batchesOnDate) {
    console.log(`  - ${batch.id}: ${batch.quantity.toString()}`);
    actualBatchTotal = actualBatchTotal.add(batch.quantity);
  }
  console.log(`  Total from batches: ${actualBatchTotal.toString()}`);

  // After fixing the 0-qty batches, the total should be 10,705 (7705 + 1500 + 1500)
  // So the stock movement is actually CORRECT if we fix the batches
  // The issue is the batches have 0 but stock movement counted the order qty

  // Actually, let's recalculate based on receipts on that day
  const receiptsOnDate = await prisma.inventoryReceipt.findMany({
    where: {
      receivedAt: {
        gte: targetDate,
        lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000),
      },
    },
    include: {
      order: {
        include: {
          items: {
            where: { itemId },
          },
        },
      },
    },
  });

  let totalFromOrders = new Prisma.Decimal(0);
  console.log(`\nReceipts and their order quantities:`);
  for (const receipt of receiptsOnDate) {
    if (receipt.order?.items) {
      for (const item of receipt.order.items) {
        const qty = item.quantity.add(item.giftQty || 0);
        console.log(`  - ${receipt.order.orderNumber}: ${qty.toString()}`);
        totalFromOrders = totalFromOrders.add(qty);
      }
    }
  }
  console.log(`  Total from orders: ${totalFromOrders.toString()}`);

  // Decision: The stock movement should match what was ACTUALLY received
  // If batches have correct quantities (after fix), and orders say 10,705, 
  // then 10,705 is correct

  // The real question is: were these items actually received or not?
  // Given that the orders are marked RECEIVED and have receipts, they should have been received
  
  // Option A: Stock movement is correct (10,705), but batches need fixing (add 3000)
  // Option B: Stock movement is wrong (should be 7,705), batches are correct (0 means not received)
  
  // Based on the order status being RECEIVED, Option A seems more likely
  // The batches were created with 0 due to a bug but the items were received
  
  console.log(`\n📊 Analysis:`);
  console.log(`  Stock Movement Incoming: ${movement.incoming.toString()}`);
  console.log(`  Sum from Orders: ${totalFromOrders.toString()}`);
  console.log(`  Sum from Batches (current): ${actualBatchTotal.toString()}`);
  
  if (movement.incoming.equals(totalFromOrders)) {
    console.log(`\n✅ Stock movement matches order totals`);
    console.log(`   The batches with 0 quantity should be fixed to match the orders`);
    console.log(`   After fixing batches, data will be consistent`);
  } else {
    console.log(`\n⚠️ Stock movement does NOT match order totals`);
    console.log(`   Stock movement might need adjustment`);
  }

  // Issue 3: Recalculate closing balances for Jan 13 onwards
  console.log('\n');
  console.log('='.repeat(60));
  console.log('3️⃣ Recalculating closing balances (Jan 13 onwards)');
  console.log('='.repeat(60));

  // Get all movements from Jan 12 (day before) onwards
  const movements = await prisma.stockMovement.findMany({
    where: {
      inventoryId,
      itemId,
      movementDate: { gte: new Date('2026-01-12') },
    },
    orderBy: { movementDate: 'asc' },
  });

  console.log(`\nMovements to check:`);
  let previousClosing: Prisma.Decimal | null = null;
  let hasIssues = false;

  for (const m of movements) {
    const dateStr = m.movementDate.toISOString().split('T')[0];
    const calculatedClosing = m.openingBalance
      .add(m.incoming)
      .add(m.incomingGifts)
      .sub(m.outgoing)
      .sub(m.pendingOutgoing)
      .sub(m.outgoingGifts);

    const closingMatch = calculatedClosing.equals(m.closingBalance);
    const openingMatch = previousClosing === null || m.openingBalance.equals(previousClosing);

    console.log(`\n${dateStr}:`);
    console.log(`  Opening: ${m.openingBalance.toString()} ${openingMatch ? '✅' : `❌ (expected ${previousClosing?.toString()})`}`);
    console.log(`  Incoming: ${m.incoming.toString()}`);
    console.log(`  Outgoing: ${m.outgoing.toString()}`);
    console.log(`  Closing: ${m.closingBalance.toString()} ${closingMatch ? '✅' : `❌ (calculated ${calculatedClosing.toString()})`}`);

    if (!closingMatch || !openingMatch) {
      hasIssues = true;
    }

    previousClosing = m.closingBalance;
  }

  if (hasIssues && !dryRun) {
    console.log('\n🔄 Fixing opening/closing balance chain...');
    
    // Get the last correct movement before our date range
    const baseMovement = await prisma.stockMovement.findFirst({
      where: {
        inventoryId,
        itemId,
        movementDate: { lt: new Date('2026-01-12') },
      },
      orderBy: { movementDate: 'desc' },
    });

    let currentOpening = baseMovement?.closingBalance || new Prisma.Decimal(0);

    for (const m of movements) {
      const newClosing = currentOpening
        .add(m.incoming)
        .add(m.incomingGifts)
        .sub(m.outgoing)
        .sub(m.pendingOutgoing)
        .sub(m.outgoingGifts);

      if (!m.openingBalance.equals(currentOpening) || !m.closingBalance.equals(newClosing)) {
        console.log(`Fixing ${m.movementDate.toISOString().split('T')[0]}: Opening ${currentOpening.toString()}, Closing ${newClosing.toString()}`);
        
        await prisma.stockMovement.update({
          where: { id: m.id },
          data: {
            openingBalance: currentOpening,
            closingBalance: newClosing,
          },
        });
      }

      currentOpening = newClosing;
    }

    console.log('✅ Balance chain fixed!');
  }

  // Summary
  console.log('\n');
  console.log('='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  if (dryRun) {
    console.log('\n⚠️ DRY RUN - No changes were made');
    console.log('Run with --apply to apply changes:\n');
    console.log('  npm run script:fix-january-stock -- --apply');
    console.log('\nOr directly:');
    console.log('  tsx scripts/fix-january-stock-movement.ts --apply');
  } else {
    console.log('\n✅ Changes applied successfully!');
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

