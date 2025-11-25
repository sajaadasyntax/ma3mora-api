/**
 * Fix Procurement Order PO-000030
 * 
 * This script fixes the order status for PO-000030. The order shows as "RECEIVED"
 * but actually has 0 items received (required 2,000, received 0). This script 
 * recalculates the status based on actual received quantities vs ordered quantities.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Starting fix for PO-000030...\n');

  // Find the order
  const order = await prisma.procOrder.findUnique({
    where: {
      orderNumber: 'PO-000030'
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
    console.error('❌ Order PO-000030 not found!');
    process.exit(1);
  }

  console.log(`📦 Found order: ${order.orderNumber}`);
  console.log(`   Current Status: ${order.status}`);
  console.log(`   Inventory: ${order.inventory.name}`);
  console.log(`   Receipts: ${order.receipts.length}\n`);

  // Calculate received quantities from all receipts
  const receivedByItem: Record<string, Prisma.Decimal> = {};
  for (const r of order.receipts) {
    console.log(`📋 Receipt ${r.id} (${r.receivedAt.toISOString()}):`);
    for (const b of r.batches) {
      const key = b.itemId;
      const qty = new Prisma.Decimal(b.quantity);
      receivedByItem[key] = (receivedByItem[key] || new Prisma.Decimal(0)).add(qty);
      const item = order.items.find(i => i.itemId === b.itemId);
      console.log(`   - ${item?.item.name || b.itemId}: ${qty.toString()}`);
    }
  }
  console.log('');

  console.log('📊 Total received quantities by item:');
  for (const [itemId, qty] of Object.entries(receivedByItem)) {
    const item = order.items.find(i => i.itemId === itemId);
    if (item) {
      console.log(`   ${item.item.name}: ${qty.toString()}`);
    }
  }
  console.log('');

  // Check if all items are fully received
  let allFullyReceived = true;
  let hasAnyReceived = false;
  const errors: string[] = [];

  console.log('📋 Checking item status:');
  for (const it of order.items) {
    // For old system: giftQty is a separate quantity that needs to be received
    // The total ordered is quantity + giftQty (both need to be received)
    const orderedMain = new Prisma.Decimal(it.quantity).add(it.giftQty || 0);
    const receivedMain = receivedByItem[it.itemId] || new Prisma.Decimal(0);
    const pendingMain = orderedMain.sub(receivedMain);
    
    if (receivedMain.gt(0)) {
      hasAnyReceived = true;
    }
    
    console.log(`   ${it.item.name}:`);
    console.log(`     Ordered: ${orderedMain.toString()}`);
    console.log(`     Received: ${receivedMain.toString()}`);
    console.log(`     Pending: ${pendingMain.toString()}`);
    
    if (receivedMain.lessThan(orderedMain)) {
      errors.push(`${it.item.name}: متبقي ${pendingMain.toString()}`);
      allFullyReceived = false;
    }

    // Check new system gift items
    if (it.giftItemId && it.giftQuantity) {
      const orderedGift = new Prisma.Decimal(it.giftQuantity);
      const receivedGift = receivedByItem[it.giftItemId] || new Prisma.Decimal(0);
      const pendingGift = orderedGift.sub(receivedGift);
      
      if (receivedGift.gt(0)) {
        hasAnyReceived = true;
      }
      
      console.log(`     Gift Item: ${it.giftItem?.name || it.giftItemId}`);
      console.log(`       Ordered: ${orderedGift.toString()}`);
      console.log(`       Received: ${receivedGift.toString()}`);
      console.log(`       Pending: ${pendingGift.toString()}`);
      
      if (receivedGift.lessThan(orderedGift)) {
        errors.push(`${it.giftItem?.name || it.giftItemId} (هدية): متبقي ${pendingGift.toString()}`);
        allFullyReceived = false;
      }
    }
    console.log('');
  }

  // Determine correct status
  // - If nothing received: CREATED
  // - If some but not all received: PARTIAL
  // - If all received: RECEIVED
  let correctStatus: 'CREATED' | 'PARTIAL' | 'RECEIVED';
  if (!hasAnyReceived) {
    correctStatus = 'CREATED';
  } else if (allFullyReceived) {
    correctStatus = 'RECEIVED';
  } else {
    correctStatus = 'PARTIAL';
  }
  
  console.log(`\n📊 Status Analysis:`);
  console.log(`   Current Status: ${order.status}`);
  console.log(`   Correct Status: ${correctStatus}`);
  console.log(`   Has Any Received: ${hasAnyReceived ? 'Yes' : 'No'}`);
  console.log(`   All Fully Received: ${allFullyReceived ? 'Yes' : 'No'}`);

  if (errors.length > 0) {
    console.log(`\n⚠️  Pending items:`);
    errors.forEach(error => console.log(`   - ${error}`));
  }

  // Update order status if incorrect
  if (order.status !== correctStatus) {
    console.log(`\n🔧 Updating order status from ${order.status} to ${correctStatus}...`);
    
    await prisma.procOrder.update({
      where: { id: order.id },
      data: { status: correctStatus }
    });
    
    console.log(`✅ Order status updated to ${correctStatus}`);
  } else {
    console.log(`\n✅ Order status is already correct (${correctStatus})`);
  }

  console.log('\n🎉 Fix completed!');
  console.log('\n📝 Summary:');
  console.log(`   - Order: ${order.orderNumber}`);
  console.log(`   - Status: ${order.status} → ${correctStatus}`);
  if (errors.length > 0) {
    console.log(`   - Pending items: ${errors.length}`);
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

