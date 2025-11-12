/**
 * Stock Sync Script
 * 
 * This script syncs InventoryStock.quantity with the actual batch totals
 * for the three items that were adjusted:
 * - الاول
 * - شعيرية نوبو 300 جم * 30
 * - كابو 1ك
 * 
 * Run this script to ensure InventoryStock.quantity matches batch totals.
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Starting stock sync with batches...\n');

  // Find the main warehouse
  const mainWarehouse = await prisma.inventory.findFirst({
    where: {
      OR: [
        { name: { contains: 'رئيسي' } },
        { name: 'المخزن الرئيسي' }
      ]
    }
  });

  if (!mainWarehouse) {
    console.error('❌ Main warehouse not found!');
    process.exit(1);
  }

  console.log(`📦 Found warehouse: ${mainWarehouse.name}\n`);

  // Items to sync
  const itemsToSync = [
    'الاول',
    'شعيرية نوبو 300 جم * 30',
    'كابو 1ك'
  ];

  for (const itemName of itemsToSync) {
    console.log(`\n🔍 Processing: ${itemName}`);

    // Find the item
    const item = await prisma.item.findFirst({
      where: {
        name: itemName,
        section: 'GROCERY'
      }
    });

    if (!item) {
      console.log(`   ⚠️  Item not found: ${itemName}`);
      continue;
    }

    // Get current stock
    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: mainWarehouse.id,
          itemId: item.id
        }
      }
    });

    if (!stock) {
      console.log(`   ⚠️  Stock record not found for: ${itemName}`);
      continue;
    }

    // Get all batches for this item
    const batches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: mainWarehouse.id,
        itemId: item.id,
        quantity: {
          gt: 0
        }
      }
    });

    // Calculate total from batches
    const totalFromBatches = batches.reduce((sum, b) => {
      return sum + parseFloat(b.quantity.toString());
    }, 0);

    const currentInventoryStock = parseFloat(stock.quantity.toString());
    const difference = totalFromBatches - currentInventoryStock;

    console.log(`   📊 Current InventoryStock.quantity: ${currentInventoryStock}`);
    console.log(`   📊 Total from batches: ${totalFromBatches}`);
    console.log(`   📊 Difference: ${difference > 0 ? '+' : ''}${difference}`);

    if (Math.abs(difference) < 0.01) {
      console.log(`   ✅ Already in sync - no update needed`);
      continue;
    }

    // Update InventoryStock.quantity to match batch total
    await prisma.inventoryStock.update({
      where: {
        inventoryId_itemId: {
          inventoryId: mainWarehouse.id,
          itemId: item.id
        }
      },
      data: {
        quantity: totalFromBatches
      }
    });

    console.log(`   ✅ Synced: InventoryStock.quantity updated to ${totalFromBatches}`);
  }

  console.log('\n🎉 Stock sync completed!');
  console.log('\n📝 Summary:');
  console.log('   All InventoryStock.quantity values now match their batch totals.');
  console.log('   Stock availability checks will now be accurate.');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

