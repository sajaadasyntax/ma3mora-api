/**
 * Initialize StockMovement records for all existing inventory stock
 * This script creates opening balance records for all items in all inventories
 * Run this once after implementing the StockMovement system
 */

import { PrismaClient } from '@prisma/client';
import { stockMovementService } from '../src/services/stockMovementService';

const prisma = new PrismaClient();

async function initializeStockMovements() {
  try {
    console.log('🚀 Starting StockMovement initialization...\n');

    // Get all inventories
    const inventories = await prisma.inventory.findMany();
    console.log(`Found ${inventories.length} inventories\n`);

    for (const inventory of inventories) {
      console.log(`📦 Processing inventory: ${inventory.name}`);
      
      // Get all items in this inventory
      const stocks = await prisma.inventoryStock.findMany({
        where: { inventoryId: inventory.id },
        include: { item: true },
      });

      console.log(`  Found ${stocks.length} items in stock`);

      for (const stock of stocks) {
        const currentQty = parseFloat(stock.quantity.toString());
        
        // Check if StockMovement already exists for this item
        const existingMovement = await prisma.stockMovement.findFirst({
          where: {
            inventoryId: inventory.id,
            itemId: stock.itemId,
          },
          orderBy: {
            movementDate: 'desc',
          },
        });

        if (existingMovement) {
          console.log(`  ✓ ${stock.item.name}: Already has stock movements`);
          continue;
        }

        // Initialize with current stock quantity
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        await stockMovementService.initializeStockMovement(
          inventory.id,
          stock.itemId,
          currentQty,
          today
        );

        console.log(`  ✅ ${stock.item.name}: Initialized with ${currentQty} units`);
      }

      console.log('');
    }

    console.log('🎉 StockMovement initialization completed successfully!');
    console.log('\n📝 Summary:');
    
    const totalMovements = await prisma.stockMovement.count();
    console.log(`  Total StockMovement records created: ${totalMovements}`);
    
  } catch (error) {
    console.error('❌ Error initializing stock movements:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the initialization
initializeStockMovements()
  .then(() => {
    console.log('\n✅ Process completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Process failed:', error);
    process.exit(1);
  });

