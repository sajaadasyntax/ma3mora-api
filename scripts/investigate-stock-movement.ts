/// <reference types="node" />
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Investigating Stock Movement Issues for الاول\n');
  console.log('Focus: January 13, 2026 (incoming: 10,705) and January 15, 2026 (incoming: 1,500)\n');
  
  // Find the item "الاول"
  const item = await prisma.item.findFirst({
    where: {
      name: { contains: 'الاول' },
    },
  });

  if (!item) {
    console.error('❌ Item "الاول" not found');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found item: ${item.name} (${item.id})\n`);

  // Get the main inventory
  const inventory = await prisma.inventory.findFirst({
    where: { name: { contains: 'الرئيسي' } },
  });

  if (!inventory) {
    console.error('❌ Main inventory not found');
    await prisma.$disconnect();
    return;
  }

  console.log(`Inventory: ${inventory.name} (${inventory.id})\n`);

  // Dates to investigate
  const dates = [
    new Date('2026-01-13'),
    new Date('2026-01-15'),
  ];

  for (const date of dates) {
    const dateStr = date.toISOString().split('T')[0];
    console.log('='.repeat(70));
    console.log(`📅 Investigating ${dateStr}`);
    console.log('='.repeat(70));

    // 1. Get the stock movement for this date
    const movement = await prisma.stockMovement.findFirst({
      where: {
        inventoryId: inventory.id,
        itemId: item.id,
        movementDate: date,
      },
    });

    if (movement) {
      console.log('\n📊 Stock Movement Record:');
      console.log(`   ID: ${movement.id}`);
      console.log(`   Opening: ${movement.openingBalance.toString()}`);
      console.log(`   Incoming: ${movement.incoming.toString()}`);
      console.log(`   Outgoing: ${movement.outgoing.toString()}`);
      console.log(`   Pending Outgoing: ${movement.pendingOutgoing.toString()}`);
      console.log(`   Incoming Gifts: ${movement.incomingGifts.toString()}`);
      console.log(`   Outgoing Gifts: ${movement.outgoingGifts.toString()}`);
      console.log(`   Closing: ${movement.closingBalance.toString()}`);
    } else {
      console.log('\n❌ No stock movement record found for this date');
    }

    // 2. Check for procurement receipts on this date
    console.log('\n📦 Procurement Receipts on this date:');
    const receipts = await prisma.inventoryReceipt.findMany({
      where: {
        receivedAt: {
          gte: date,
          lt: new Date(date.getTime() + 24 * 60 * 60 * 1000),
        },
      },
      include: {
        order: {
          include: {
            items: {
              where: { itemId: item.id },
              include: { item: true },
            },
          },
        },
        batches: {
          where: { itemId: item.id },
          include: { item: true },
        },
      },
    });

    if (receipts.length === 0) {
      console.log('   ❌ No receipts found');
    } else {
      for (const receipt of receipts) {
        console.log(`\n   Receipt: ${receipt.id}`);
        console.log(`   Order: ${receipt.order?.orderNumber || 'N/A'}`);
        console.log(`   Order Status: ${receipt.order?.status || 'N/A'}`);
        
        if (receipt.order?.items && receipt.order.items.length > 0) {
          console.log(`   Order items for الاول:`);
          for (const orderItem of receipt.order.items) {
            console.log(`      - Quantity: ${orderItem.quantity.toString()}, Gift: ${orderItem.giftQty?.toString() || '0'}`);
          }
        }
        
        if (receipt.batches.length > 0) {
          console.log(`   Batches for الاول:`);
          for (const batch of receipt.batches) {
            console.log(`      - ${batch.quantity.toString()} (Batch ID: ${batch.id})`);
          }
        } else {
          console.log('   No batches linked to this receipt for الاول');
        }
      }
    }

    // 3. Check for stock batches received on this date
    console.log('\n📦 Stock Batches received on this date:');
    const batches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: inventory.id,
        itemId: item.id,
        receivedAt: {
          gte: date,
          lt: new Date(date.getTime() + 24 * 60 * 60 * 1000),
        },
      },
      include: {
        receipt: {
          include: {
            order: true,
          },
        },
      },
    });

    if (batches.length === 0) {
      console.log('   ❌ No batches received on this date');
    } else {
      let totalBatchQty = 0;
      for (const batch of batches) {
        console.log(`   Batch: ${batch.id}`);
        console.log(`      Quantity: ${batch.quantity.toString()}`);
        console.log(`      Receipt: ${batch.receiptId || 'NONE'}`);
        console.log(`      Order: ${batch.receipt?.order?.orderNumber || 'N/A'}`);
        totalBatchQty += parseFloat(batch.quantity.toString());
      }
      console.log(`   Total batch quantity: ${totalBatchQty}`);
    }

    // 4. Check for procurement orders created or received on this date
    console.log('\n📋 Procurement Orders related to this date:');
    const orders = await prisma.procOrder.findMany({
      where: {
        OR: [
          {
            createdAt: {
              gte: date,
              lt: new Date(date.getTime() + 24 * 60 * 60 * 1000),
            },
          },
          {
            receipts: {
              some: {
                receivedAt: {
                  gte: date,
                  lt: new Date(date.getTime() + 24 * 60 * 60 * 1000),
                },
              },
            },
          },
        ],
        items: {
          some: { itemId: item.id },
        },
      },
      include: {
        items: {
          where: { itemId: item.id },
          include: { item: true },
        },
        receipts: {
          orderBy: { receivedAt: 'asc' },
        },
      },
    });

    if (orders.length === 0) {
      console.log('   ❌ No orders found for الاول on this date');
    } else {
      for (const order of orders) {
        console.log(`\n   Order: ${order.orderNumber} (${order.id})`);
        console.log(`   Status: ${order.status}`);
        console.log(`   Created: ${order.createdAt.toISOString().split('T')[0]}`);
        console.log(`   Items for الاول:`);
        for (const orderItem of order.items) {
          console.log(`      - Quantity: ${orderItem.quantity.toString()}, Gift: ${orderItem.giftQty?.toString() || '0'}`);
        }
        console.log(`   Receipts:`);
        for (const receipt of order.receipts) {
          console.log(`      - ${receipt.id} on ${receipt.receivedAt.toISOString().split('T')[0]}`);
        }
      }
    }

    // 5. Search for ANY procurement order with this item that might explain the incoming
    if (movement && movement.incoming.gt(0)) {
      console.log(`\n🔎 Searching for orders with quantity ~${movement.incoming.toString()} for الاول:`);
      
      const matchingOrders = await prisma.procOrder.findMany({
        where: {
          items: {
            some: {
              itemId: item.id,
            },
          },
        },
        include: {
          items: {
            where: { itemId: item.id },
          },
          receipts: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      const incomingValue = parseFloat(movement.incoming.toString());
      for (const order of matchingOrders) {
        for (const orderItem of order.items) {
          const qty = parseFloat(orderItem.quantity.toString());
          const giftQty = parseFloat(orderItem.giftQty?.toString() || '0');
          const total = qty + giftQty;
          
          // Check if this matches or is close to the incoming value
          if (Math.abs(total - incomingValue) < 10 || Math.abs(qty - incomingValue) < 10) {
            console.log(`   ⚠️ POTENTIAL MATCH: ${order.orderNumber}`);
            console.log(`      Order Qty: ${qty}, Gift: ${giftQty}, Total: ${total}`);
            console.log(`      Status: ${order.status}`);
            console.log(`      Created: ${order.createdAt.toISOString().split('T')[0]}`);
            for (const receipt of order.receipts) {
              console.log(`      Receipt: ${receipt.receivedAt.toISOString().split('T')[0]}`);
            }
          }
        }
      }
    }

    console.log('\n');
  }

  // 6. Summary - Show all incoming movements for this item in January
  console.log('='.repeat(70));
  console.log('📊 All Incoming Stock Movements for الاول in January 2026');
  console.log('='.repeat(70));

  const allMovements = await prisma.stockMovement.findMany({
    where: {
      inventoryId: inventory.id,
      itemId: item.id,
      movementDate: {
        gte: new Date('2026-01-01'),
        lte: new Date('2026-01-31'),
      },
      incoming: { gt: 0 },
    },
    orderBy: { movementDate: 'asc' },
  });

  console.log(`\nFound ${allMovements.length} movements with incoming > 0:\n`);
  
  for (const m of allMovements) {
    console.log(`${m.movementDate.toISOString().split('T')[0]}: Incoming ${m.incoming.toString()} | Movement ID: ${m.id}`);
  }

  // 7. List ALL procurement orders for this item
  console.log('\n');
  console.log('='.repeat(70));
  console.log('📋 All Recent Procurement Orders containing الاول');
  console.log('='.repeat(70));

  const allOrders = await prisma.procOrder.findMany({
    where: {
      items: {
        some: { itemId: item.id },
      },
      createdAt: {
        gte: new Date('2026-01-01'),
      },
    },
    include: {
      items: {
        where: { itemId: item.id },
      },
      receipts: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\nFound ${allOrders.length} orders:\n`);

  for (const order of allOrders) {
    const qty = order.items.reduce((sum, i) => sum + parseFloat(i.quantity.toString()), 0);
    const giftQty = order.items.reduce((sum, i) => sum + parseFloat(i.giftQty?.toString() || '0'), 0);
    
    console.log(`${order.orderNumber} | Status: ${order.status} | Created: ${order.createdAt.toISOString().split('T')[0]}`);
    console.log(`   Qty: ${qty}, Gift: ${giftQty}, Total: ${qty + giftQty}`);
    if (order.receipts.length > 0) {
      console.log(`   Receipts: ${order.receipts.map(r => r.receivedAt.toISOString().split('T')[0]).join(', ')}`);
    } else {
      console.log('   No receipts yet');
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

