/**
 * Fix Procurement Order PO-000038
 * 
 * This script fixes the order status for PO-000038. The order shows as "RECEIVED"
 * but actually has items that are only partially received. This script recalculates
 * the status based on actual received quantities vs ordered quantities.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Starting fix for PO-000038...\n');

  // Find the order
  const order = await prisma.procOrder.findUnique({
    where: {
      orderNumber: 'PO-000038'
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
    console.error('❌ Order PO-000038 not found!');
    process.exit(1);
  }

  console.log(`📦 Found order: ${order.orderNumber}`);
  console.log(`   Current Status: ${order.status}`);
  console.log(`   Inventory: ${order.inventory.name}`);
  console.log(`   Receipts: ${order.receipts.length}\n`);

  // Calculate received quantities from all receipts
  const receivedByItem: Record<string, Prisma.Decimal> = {};
  for (const r of order.receipts) {
    for (const b of r.batches) {
      const key = b.itemId;
      const qty = new Prisma.Decimal(b.quantity);
      receivedByItem[key] = (receivedByItem[key] || new Prisma.Decimal(0)).add(qty);
    }
  }

  console.log('📊 Received quantities by item:');
  for (const [itemId, qty] of Object.entries(receivedByItem)) {
    const item = order.items.find(i => i.itemId === itemId);
    if (item) {
      console.log(`   ${item.item.name}: ${qty.toString()}`);
    }
  }
  console.log('');

  // Check if all items are fully received
  let allFullyReceived = true;
  const errors: string[] = [];

  console.log('📋 Checking item status:');
  for (const it of order.items) {
    // For old system: giftQty is a separate quantity that needs to be received
    // The total ordered is quantity + giftQty (both need to be received)
    const orderedMain = new Prisma.Decimal(it.quantity).add(it.giftQty || 0);
    const receivedMain = receivedByItem[it.itemId] || new Prisma.Decimal(0);
    const pendingMain = orderedMain.sub(receivedMain);
    
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
  const correctStatus = allFullyReceived ? 'RECEIVED' : 'PARTIAL';
  
  console.log(`\n📊 Status Analysis:`);
  console.log(`   Current Status: ${order.status}`);
  console.log(`   Correct Status: ${correctStatus}`);
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

