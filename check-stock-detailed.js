// Detailed stock movement check
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function detailedStockCheck() {
  try {
    console.log('=== Detailed Stock Analysis ===\n');
    
    const itemId = 'cmhgjqygz000f8pi8ve9zab4k'; // رز
    const inventoryId = await getMainInventoryId();
    
    console.log('Item: رز');
    console.log('Inventory: المخزن الرئيسي\n');
    
    // Get all deliveries with dates
    const allDeliveries = await prisma.inventoryDelivery.findMany({
      where: {
        invoice: {
          inventoryId: inventoryId,
          deliveryStatus: 'DELIVERED'
        },
        items: {
          some: { itemId: itemId }
        }
      },
      include: {
        items: {
          where: { itemId: itemId }
        },
        invoice: {
          select: {
            invoiceNumber: true,
            createdAt: true
          }
        }
      },
      orderBy: { deliveredAt: 'asc' }
    });
    
    console.log('=== All Deliveries (chronological) ===');
    let runningBalance = 0;
    allDeliveries.forEach((del, idx) => {
      const qty = parseFloat(del.items[0].quantity.toString());
      runningBalance -= qty;
      console.log(`${idx + 1}. Invoice: ${del.invoice.invoiceNumber}`);
      console.log(`   Created: ${del.invoice.createdAt.toISOString().split('T')[0]}`);
      console.log(`   Delivered: ${del.deliveredAt.toISOString().split('T')[0]}`);
      console.log(`   Quantity: ${qty} units`);
      console.log(`   Running balance: ${runningBalance}`);
      console.log('');
    });
    
    // Get all procurement receipts
    const receipts = await prisma.inventoryReceipt.findMany({
      where: {
        order: {
          inventoryId: inventoryId,
          items: {
            some: { itemId: itemId }
          }
        }
      },
      include: {
        order: {
          include: {
            items: {
              where: { itemId: itemId }
            }
          }
        }
      },
      orderBy: { receivedAt: 'asc' }
    });
    
    console.log('=== All Procurement Receipts (chronological) ===');
    if (receipts.length === 0) {
      console.log('❌ No procurement receipts found\n');
    } else {
      receipts.forEach((rec, idx) => {
        const orderItem = rec.order.items[0];
        const qty = parseFloat(orderItem.quantity.toString());
        console.log(`${idx + 1}. Order: ${rec.order.orderNumber}`);
        console.log(`   Received: ${rec.receivedAt.toISOString().split('T')[0]}`);
        console.log(`   Quantity: ${qty} units`);
        console.log('');
      });
    }
    
    // Simulate calculation for Nov 2-3 period
    console.log('=== Simulation for Nov 2-3, 2025 ===');
    const startDate = new Date('2025-11-02T00:00:00Z');
    const endDate = new Date('2025-11-03T23:59:59Z');
    
    const deliveriesInPeriod = allDeliveries.filter(d => 
      d.deliveredAt >= startDate && d.deliveredAt <= endDate
    );
    
    const receiptsInPeriod = receipts.filter(r =>
      r.receivedAt >= startDate && r.receivedAt <= endDate
    );
    
    const totalOutgoing = deliveriesInPeriod.reduce((sum, d) => 
      sum + parseFloat(d.items[0].quantity.toString()), 0
    );
    
    const totalIncoming = receiptsInPeriod.reduce((sum, r) =>
      sum + parseFloat(r.order.items[0].quantity.toString()), 0
    );
    
    const currentStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: inventoryId,
          itemId: itemId
        }
      }
    });
    
    const currentQty = parseFloat(currentStock.quantity.toString());
    const calculatedOpening = currentQty + totalOutgoing - totalIncoming;
    
    console.log(`Current Stock: ${currentQty}`);
    console.log(`Outgoing in period: ${totalOutgoing}`);
    console.log(`Incoming in period: ${totalIncoming}`);
    console.log(`Calculated Opening Balance: ${calculatedOpening}`);
    console.log(`Expected Closing Balance: ${calculatedOpening - totalOutgoing + totalIncoming} = ${currentQty}`);
    
    console.log('\n=== Report would show ===');
    console.log(`Opening Balance: ${calculatedOpening}`);
    console.log(`Outgoing: ${totalOutgoing}`);
    console.log(`Incoming: ${totalIncoming}`);
    console.log(`Closing Balance: ${calculatedOpening - totalOutgoing + totalIncoming}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

async function getMainInventoryId() {
  const inv = await prisma.inventory.findFirst({
    where: { name: 'المخزن الرئيسي' }
  });
  return inv.id;
}

detailedStockCheck();

