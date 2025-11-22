/**
 * Fix Procurement Order PO-000044
 * 
 * This script fixes the receipt for PO-000044 by adding the missing gift quantity (173)
 * to the "الالي" item batch. The order shows partial delivery even though all items
 * should be received because the gift quantity wasn't included in the batch.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Starting fix for PO-000044...\n');

  // Find the order
  const order = await prisma.procOrder.findUnique({
    where: {
      orderNumber: 'PO-000044'
    },
    include: {
      items: {
        include: {
          item: true,
          giftItem: true
        }
      },
      receipts: {
        include: {
          batches: {
            include: {
              item: true
            }
          }
        }
      },
      inventory: true
    }
  });

  if (!order) {
    console.error('❌ Order PO-000044 not found!');
    process.exit(1);
  }

  console.log(`📦 Found order: ${order.orderNumber}`);
  console.log(`   Status: ${order.status}`);
  console.log(`   Inventory: ${order.inventory.name}`);
  console.log(`   Receipts: ${order.receipts.length}\n`);

  // Find the "الالي" item
  const alaliItem = order.items.find(item => item.item.name === 'الالي');

  if (!alaliItem) {
    console.error('❌ Item "الالي" not found in order!');
    process.exit(1);
  }

  console.log(`📦 Found item: ${alaliItem.item.name}`);
  console.log(`   Ordered quantity: ${alaliItem.quantity.toString()}`);
  console.log(`   Gift quantity (old system): ${alaliItem.giftQty?.toString() || '0'}`);
  console.log(`   Total should be: ${alaliItem.quantity.add(alaliItem.giftQty || 0).toString()}\n`);

  // Find the receipt
  if (order.receipts.length === 0) {
    console.error('❌ No receipts found for this order!');
    process.exit(1);
  }

  const receipt = order.receipts[0];
  console.log(`📋 Found receipt: ${receipt.id}`);
  console.log(`   Received at: ${receipt.receivedAt.toISOString()}`);
  console.log(`   Notes: ${receipt.notes || 'N/A'}\n`);

  // Find the batch for "الالي" item
  const alaliBatch = receipt.batches.find(batch => batch.itemId === alaliItem.itemId);

  if (!alaliBatch) {
    console.error('❌ Batch for "الالي" item not found in receipt!');
    process.exit(1);
  }

  console.log(`📦 Found batch for "الالي":`);
  console.log(`   Current quantity: ${alaliBatch.quantity.toString()}`);
  console.log(`   Expected quantity: ${alaliItem.quantity.add(alaliItem.giftQty || 0).toString()}\n`);

  const currentQty = new Prisma.Decimal(alaliBatch.quantity);
  const expectedQty = alaliItem.quantity.add(alaliItem.giftQty || 0);
  const difference = expectedQty.sub(currentQty);

  if (difference.lessThanOrEqualTo(0)) {
    console.log('✅ Batch quantity is already correct or exceeds expected amount!');
    console.log(`   Current: ${currentQty.toString()}, Expected: ${expectedQty.toString()}`);
    return;
  }

  console.log(`🔧 Need to add ${difference.toString()} to the batch\n`);

  // Update the batch quantity
  await prisma.stockBatch.update({
    where: { id: alaliBatch.id },
    data: {
      quantity: expectedQty,
      notes: alaliItem.giftQty && alaliItem.giftQty.gt(0) 
        ? `يشمل ${alaliItem.giftQty.toString()} هدية` 
        : alaliBatch.notes
    }
  });

  console.log('✅ Updated batch quantity');

  // Update inventory stock
  const stock = await prisma.inventoryStock.findUnique({
    where: {
      inventoryId_itemId: {
        inventoryId: order.inventoryId,
        itemId: alaliItem.itemId
      }
    }
  });

  if (stock) {
    await prisma.inventoryStock.update({
      where: {
        inventoryId_itemId: {
          inventoryId: order.inventoryId,
          itemId: alaliItem.itemId
        }
      },
      data: {
        quantity: {
          increment: difference
        }
      }
    });

    console.log(`✅ Updated inventory stock (added ${difference.toString()})`);
  } else {
    console.log('⚠️  Inventory stock not found, skipping stock update');
  }

  // Check if all items are now fully received
  const receivedByItem: Record<string, Prisma.Decimal> = {};
  for (const r of order.receipts) {
    for (const b of r.batches) {
      const key = b.itemId;
      const qty = new Prisma.Decimal(b.quantity);
      receivedByItem[key] = (receivedByItem[key] || new Prisma.Decimal(0)).add(qty);
    }
  }

  // Update the receivedByItem with the new batch quantity
  receivedByItem[alaliItem.itemId] = expectedQty;

  let allFullyReceived = true;
  const errors: string[] = [];

  for (const it of order.items) {
    const orderedMain = new Prisma.Decimal(it.quantity).add(it.giftQty || 0);
    const receivedMain = receivedByItem[it.itemId] || new Prisma.Decimal(0);
    
    if (receivedMain.lessThan(orderedMain)) {
      const pending = orderedMain.sub(receivedMain);
      errors.push(`${it.item.name}: متبقي ${pending.toString()}`);
      allFullyReceived = false;
    }

    // Check new system gift items
    if (it.giftItemId && it.giftQuantity) {
      const orderedGift = new Prisma.Decimal(it.giftQuantity);
      const receivedGift = receivedByItem[it.giftItemId] || new Prisma.Decimal(0);
      if (receivedGift.lessThan(orderedGift)) {
        const pendingGift = orderedGift.sub(receivedGift);
        errors.push(`${it.giftItem?.name || it.giftItemId} (هدية): متبقي ${pendingGift.toString()}`);
        allFullyReceived = false;
      }
    }
  }

  // Update order status if all items are fully received
  if (allFullyReceived && order.status !== 'RECEIVED') {
    await prisma.procOrder.update({
      where: { id: order.id },
      data: { status: 'RECEIVED' }
    });
    console.log('\n✅ Updated order status to RECEIVED');
  } else if (!allFullyReceived) {
    console.log('\n⚠️  Order still has pending items:');
    errors.forEach(error => console.log(`   - ${error}`));
    console.log('\n   Order status remains: ' + order.status);
  } else {
    console.log('\n✅ Order status is already RECEIVED');
  }

  console.log('\n🎉 Fix completed!');
  console.log('\n📝 Summary:');
  console.log(`   - Updated batch quantity for "الالي": ${currentQty.toString()} → ${expectedQty.toString()}`);
  console.log(`   - Added ${difference.toString()} to inventory stock`);
  if (allFullyReceived) {
    console.log(`   - Order status updated to RECEIVED`);
  }
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

