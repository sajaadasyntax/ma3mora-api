/// <reference types="node" />
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  
  // Default to checking recent data
  const startDate = args[0] ? new Date(args[0]) : new Date('2026-01-05');
  const endDate = args[1] ? new Date(args[1]) : new Date('2026-01-16');
  
  console.log('🔍 Diagnosing Stock Movement Issues\n');
  console.log(`Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}\n`);

  // 1. Find all stock movements with incoming > 0 in the date range
  console.log('='.repeat(60));
  console.log('1️⃣ Stock Movements with Incoming Quantities');
  console.log('='.repeat(60));
  
  const incomingMovements = await prisma.stockMovement.findMany({
    where: {
      movementDate: {
        gte: startDate,
        lte: endDate,
      },
      incoming: { gt: 0 },
    },
    include: {
      item: true,
      inventory: true,
    },
    orderBy: [
      { movementDate: 'asc' },
      { itemId: 'asc' },
    ],
  });

  console.log(`Found ${incomingMovements.length} movements with incoming quantities\n`);
  
  for (const movement of incomingMovements) {
    console.log(`📅 ${movement.movementDate.toISOString().split('T')[0]} | ${movement.item.name}`);
    console.log(`   Inventory: ${movement.inventory.name}`);
    console.log(`   Incoming: ${movement.incoming.toString()}`);
    console.log(`   Movement ID: ${movement.id}`);
    console.log('');
  }

  // 2. Find all procurement receipts in the date range
  console.log('='.repeat(60));
  console.log('2️⃣ Procurement Receipts in Date Range');
  console.log('='.repeat(60));
  
  const receipts = await prisma.inventoryReceipt.findMany({
    where: {
      receivedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      order: true,
      batches: {
        include: {
          item: true,
        },
      },
    },
    orderBy: { receivedAt: 'asc' },
  });

  console.log(`Found ${receipts.length} receipts\n`);
  
  for (const receipt of receipts) {
    console.log(`📦 Receipt: ${receipt.id}`);
    console.log(`   Date: ${receipt.receivedAt.toISOString().split('T')[0]}`);
    console.log(`   Order: ${receipt.order?.orderNumber || 'N/A'} (${receipt.orderId})`);
    console.log(`   Batches: ${receipt.batches.length}`);
    for (const batch of receipt.batches) {
      console.log(`      - ${batch.item.name}: ${batch.quantity.toString()}`);
    }
    console.log('');
  }

  // 3. Find all procurement orders in the date range
  console.log('='.repeat(60));
  console.log('3️⃣ Procurement Orders in Date Range');
  console.log('='.repeat(60));
  
  const orders = await prisma.procOrder.findMany({
    where: {
      OR: [
        {
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        {
          receipts: {
            some: {
              receivedAt: {
                gte: startDate,
                lte: endDate,
              },
            },
          },
        },
      ],
    },
    include: {
      items: {
        include: {
          item: true,
        },
      },
      receipts: {
        orderBy: { receivedAt: 'asc' },
      },
      inventory: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Found ${orders.length} orders\n`);
  
  for (const order of orders) {
    console.log(`📋 Order: ${order.orderNumber} (${order.id})`);
    console.log(`   Status: ${order.status}`);
    console.log(`   Created: ${order.createdAt.toISOString().split('T')[0]}`);
    console.log(`   Inventory: ${order.inventory.name}`);
    console.log(`   Items:`);
    for (const item of order.items) {
      console.log(`      - ${item.item.name}: ${item.quantity.toString()}`);
    }
    console.log(`   Receipts: ${order.receipts.length}`);
    for (const receipt of order.receipts) {
      console.log(`      - ${receipt.id} on ${receipt.receivedAt.toISOString().split('T')[0]}`);
    }
    console.log('');
  }

  // 4. Check for orphan stock movements (incoming without matching receipt)
  console.log('='.repeat(60));
  console.log('4️⃣ Checking for Orphan Stock Movements');
  console.log('='.repeat(60));
  
  for (const movement of incomingMovements) {
    const movementDate = movement.movementDate.toISOString().split('T')[0];
    
    // Find receipts on the same date for the same inventory
    const matchingReceipts = receipts.filter(r => {
      const receiptDate = r.receivedAt.toISOString().split('T')[0];
      return receiptDate === movementDate;
    });
    
    // Check if any receipt has this item
    let foundMatch = false;
    for (const receipt of matchingReceipts) {
      const matchingBatch = receipt.batches.find(
        b => b.itemId === movement.itemId && b.quantity.equals(movement.incoming)
      );
      if (matchingBatch) {
        foundMatch = true;
        break;
      }
    }
    
    // Also check order items
    if (!foundMatch) {
      for (const receipt of matchingReceipts) {
        const order = orders.find(o => o.id === receipt.orderId);
        if (order) {
          const matchingItem = order.items.find(
            i => i.itemId === movement.itemId && i.quantity.equals(movement.incoming)
          );
          if (matchingItem) {
            foundMatch = true;
            console.log(`✅ Movement ${movement.id} matches order item in ${order.orderNumber}`);
            break;
          }
        }
      }
    }
    
    if (!foundMatch && matchingReceipts.length === 0) {
      console.log(`⚠️  ORPHAN: Movement on ${movementDate} for ${movement.item.name}`);
      console.log(`   Incoming: ${movement.incoming.toString()}`);
      console.log(`   Movement ID: ${movement.id}`);
      console.log(`   No matching receipt found on this date!`);
      console.log('');
    }
  }

  // 5. Check stock batches created in the date range
  console.log('='.repeat(60));
  console.log('5️⃣ Stock Batches Created in Date Range');
  console.log('='.repeat(60));
  
  const batches = await prisma.stockBatch.findMany({
    where: {
      receivedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      item: true,
      inventory: true,
      receipt: {
        include: {
          order: true,
        },
      },
    },
    orderBy: { receivedAt: 'asc' },
  });

  console.log(`Found ${batches.length} batches\n`);
  
  for (const batch of batches) {
    console.log(`📦 Batch: ${batch.id}`);
    console.log(`   Item: ${batch.item.name}`);
    console.log(`   Quantity: ${batch.quantity.toString()}`);
    console.log(`   Received: ${batch.receivedAt.toISOString().split('T')[0]}`);
    console.log(`   Receipt: ${batch.receiptId || 'NONE'}`);
    if (batch.receipt) {
      console.log(`   Order: ${batch.receipt.order?.orderNumber || 'N/A'}`);
    }
    console.log('');
  }

  // 6. Summary of issues
  console.log('='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  
  const orphanBatches = batches.filter(b => !b.receiptId);
  console.log(`Total incoming movements: ${incomingMovements.length}`);
  console.log(`Total receipts: ${receipts.length}`);
  console.log(`Total orders: ${orders.length}`);
  console.log(`Total batches: ${batches.length}`);
  console.log(`Orphan batches (no receipt): ${orphanBatches.length}`);
  
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

