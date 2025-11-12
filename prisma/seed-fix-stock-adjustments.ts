/**
 * Stock Adjustment Seed Script
 * 
 * This script fixes stock values after the double procurement issue:
 * - Subtract 501 from "الأول"
 * - Add 467 to "شعيرية نوبو 300 جم * 30"
 * - Add 20 to "كابو 1ك"
 * 
 * Run this script to adjust stock values in the main warehouse.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Starting stock adjustments...\n');

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

  // Item names to adjust
  const adjustments = [
    {
      itemName: 'الأول',
      adjustment: -501, // Subtract 501
      description: 'Subtract 501 from الأول'
    },
    {
      itemName: 'شعيرية نوبو 300 جم * 30',
      adjustment: 467, // Add 467
      description: 'Add 467 to شعيرية نوبو 300 جم * 30'
    },
    {
      itemName: 'كابو 1ك',
      adjustment: 20, // Add 20
      description: 'Add 20 to كابو 1ك'
    }
  ];

  for (const adj of adjustments) {
    console.log(`\n🔍 Processing: ${adj.itemName}`);
    console.log(`   ${adj.description}`);

    // Find the item
    const item = await prisma.item.findFirst({
      where: {
        name: adj.itemName,
        section: 'GROCERY'
      }
    });

    if (!item) {
      console.log(`   ⚠️  Item not found: ${adj.itemName}`);
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
      console.log(`   ⚠️  Stock record not found for: ${adj.itemName}`);
      continue;
    }

    const currentQuantity = parseFloat(stock.quantity.toString());
    const newQuantity = currentQuantity + adj.adjustment; // Allow negative values for corrections

    console.log(`   📊 Current stock: ${currentQuantity}`);
    console.log(`   📊 Adjustment: ${adj.adjustment > 0 ? '+' : ''}${adj.adjustment}`);
    console.log(`   📊 New stock: ${newQuantity}`);

    // Update stock
    await prisma.inventoryStock.update({
      where: {
        inventoryId_itemId: {
          inventoryId: mainWarehouse.id,
          itemId: item.id
        }
      },
      data: {
        quantity: newQuantity
      }
    });

    console.log(`   ✅ Updated successfully`);
  }

  console.log('\n🎉 Stock adjustments completed!');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

