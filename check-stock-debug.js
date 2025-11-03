// Script to debug stock and sales report issues
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkStockAndReportData() {
  try {
    console.log('=== Stock and Sales Report Debug ===\n');
    
    // 1. Find items with name containing 'رز'
    console.log('1. Searching for items with "رز"...');
    const items = await prisma.item.findMany({
      where: {
        name: {
          contains: 'رز'
        }
      },
      select: {
        id: true,
        name: true,
        section: true
      }
    });
    
    if (items.length === 0) {
      console.log('❌ No items found with "رز" in the name');
      return;
    }
    
    console.log(`✅ Found ${items.length} item(s):`);
    items.forEach(item => console.log(`   - ${item.name} (ID: ${item.id})`));
    
    // 2. Check inventory stock for each item
    console.log('\n2. Current Inventory Stock:');
    for (const item of items) {
      const stocks = await prisma.inventoryStock.findMany({
        where: { itemId: item.id },
        include: { inventory: { select: { name: true } } }
      });
      
      stocks.forEach(stock => {
        console.log(`   - ${item.name} in ${stock.inventory.name}: ${stock.quantity}`);
      });
    }
    
    // 3. Check recent sales invoices
    console.log('\n3. Recent Sales Invoices (last 30 days):');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    for (const item of items) {
      const invoices = await prisma.salesInvoice.findMany({
        where: {
          createdAt: { gte: thirtyDaysAgo },
          items: {
            some: { itemId: item.id }
          }
        },
        include: {
          items: {
            where: { itemId: item.id }
          },
          inventory: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      if (invoices.length > 0) {
        console.log(`\n   Item: ${item.name}`);
        invoices.forEach(inv => {
          const itemData = inv.items[0];
          console.log(`   - Invoice ${inv.invoiceNumber}: ${itemData.quantity} units, Status: ${inv.deliveryStatus}, Created: ${inv.createdAt.toISOString().split('T')[0]}`);
        });
      }
    }
    
    // 4. Check deliveries
    console.log('\n4. Recent Deliveries (last 30 days):');
    for (const item of items) {
      const deliveries = await prisma.inventoryDelivery.findMany({
        where: {
          deliveredAt: { gte: thirtyDaysAgo },
          items: {
            some: { itemId: item.id }
          }
        },
        include: {
          items: {
            where: { itemId: item.id }
          },
          invoice: {
            include: {
              inventory: { select: { name: true } }
            }
          }
        },
        orderBy: { deliveredAt: 'desc' }
      });
      
      if (deliveries.length > 0) {
        console.log(`\n   Item: ${item.name}`);
        deliveries.forEach(del => {
          const itemData = del.items[0];
          console.log(`   - Delivered ${itemData.quantity} units on ${del.deliveredAt.toISOString().split('T')[0]} for invoice ${del.invoice.invoiceNumber}`);
        });
      }
    }
    
    // 5. Check StockMovements
    console.log('\n5. Stock Movements (last 30 days):');
    for (const item of items) {
      const movements = await prisma.stockMovement.findMany({
        where: {
          itemId: item.id,
          movementDate: { gte: thirtyDaysAgo }
        },
        include: {
          inventory: { select: { name: true } }
        },
        orderBy: { movementDate: 'desc' }
      });
      
      if (movements.length > 0) {
        console.log(`\n   Item: ${item.name}`);
        movements.forEach(mov => {
          console.log(`   - Date: ${mov.movementDate.toISOString().split('T')[0]}`);
          console.log(`     Opening: ${mov.openingBalance}, Incoming: ${mov.incoming}, Outgoing: ${mov.outgoing}, Closing: ${mov.closingBalance}`);
        });
      } else {
        console.log(`\n   ❌ No StockMovement records found for ${item.name}`);
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkStockAndReportData();

