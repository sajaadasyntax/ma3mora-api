/**
 * Stock Adjustment Seed Script
 * 
 * This script fixes stock values after the double procurement issue:
 * - Subtract 501 from "الاول"
 * - Add 467 to "شعيرية نوبو 300 جم * 30"
 * - Add 20 to "كابو 1ك"
 * 
 * Run this script to adjust stock values in the main warehouse.
 * 
 * To undo the last run, use: npx ts-node prisma/seed-fix-stock-adjustments.ts --undo
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// Track changes for undo functionality
interface ChangeRecord {
  itemId: string;
  itemName: string;
  oldInventoryStock: number;
  newInventoryStock: number;
  batchChanges: Array<{
    batchId: string;
    oldQuantity: number;
    newQuantity: number | null; // null means batch was deleted
  }>;
  createdBatches: Array<{
    batchId: string;
    quantity: number;
  }>;
}

const changesLog: ChangeRecord[] = [];

async function undoLastRun() {
  console.log('↩️  Starting undo of last stock adjustments...\n');

  // Try to load the undo log from a file or use in-memory log
  // For production safety, we'll use a simple approach: reverse the adjustments
  console.log('⚠️  Undo mode: Reversing all adjustments...\n');

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

  // Reverse adjustments
  const reverseAdjustments = [
    {
      itemName: 'الاول',
      adjustment: 501, // Add back 501 (reverse of -501)
      description: 'Add back 501 to الاول (undo)'
    },
    {
      itemName: 'شعيرية نوبو 300 جم * 30',
      adjustment: -467, // Subtract 467 (reverse of +467)
      description: 'Subtract 467 from شعيرية نوبو 300 جم * 30 (undo)'
    },
    {
      itemName: 'كابو 1ك',
      adjustment: -20, // Subtract 20 (reverse of +20)
      description: 'Subtract 20 from كابو 1ك (undo)'
    }
  ];

  for (const adj of reverseAdjustments) {
    console.log(`\n🔍 Processing undo: ${adj.itemName}`);
    
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

    // Get batches
    const batches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: mainWarehouse.id,
        itemId: item.id,
        quantity: {
          gt: 0
        }
      },
      orderBy: {
        receivedAt: 'desc' // Newest first to find adjustment batches
      }
    });

    const currentQuantityFromBatches = batches.reduce((sum, b) => {
      return sum + parseFloat(b.quantity.toString());
    }, 0);

    const currentInventoryStock = parseFloat(stock.quantity.toString());

    console.log(`   📊 Current InventoryStock.quantity: ${currentInventoryStock}`);
    console.log(`   📊 Current total from batches: ${currentQuantityFromBatches}`);

    // Reverse the adjustment
    const newQuantity = currentInventoryStock + adj.adjustment;

    // Update InventoryStock
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

    // Reverse batch changes by finding and removing adjustment batches
    // Look for batches with "تعديل يدوي" in notes (these are our adjustment batches)
    const allBatches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: mainWarehouse.id,
        itemId: item.id
      },
      orderBy: {
        receivedAt: 'desc' // Newest first
      }
    });

    const adjustmentBatches = allBatches.filter(b => 
      b.notes && b.notes.includes('تعديل يدوي')
    );

    if (adj.adjustment > 0) {
      // Original was subtraction (-501), now we add back (+501)
      // Find the adjustment batch that subtracted and remove it, or create a reverse batch
      if (adjustmentBatches.length > 0) {
        // Find the batch that matches our subtraction
        const matchingBatch = adjustmentBatches.find(b => 
          b.notes && (b.notes.includes('Subtract') || b.notes.includes('الاول'))
        );
        
        if (matchingBatch) {
          await prisma.stockBatch.delete({
            where: { id: matchingBatch.id }
          });
          console.log(`   📦 Removed adjustment batch: ${matchingBatch.id}`);
        } else {
          // Create reverse adjustment batch
          await prisma.stockBatch.create({
            data: {
              inventoryId: mainWarehouse.id,
              itemId: item.id,
              quantity: adj.adjustment,
              notes: `إلغاء تعديل: ${adj.description} - ${new Date().toLocaleString('ar-SD')}`
            }
          });
          console.log(`   📦 Created reverse adjustment batch: +${adj.adjustment}`);
        }
      } else {
        // No adjustment batches found, create reverse
        await prisma.stockBatch.create({
          data: {
            inventoryId: mainWarehouse.id,
            itemId: item.id,
            quantity: adj.adjustment,
            notes: `إلغاء تعديل: ${adj.description} - ${new Date().toLocaleString('ar-SD')}`
          }
        });
        console.log(`   📦 Created reverse adjustment batch: +${adj.adjustment}`);
      }
    } else if (adj.adjustment < 0) {
      // Original was addition (+467 or +20), now we subtract
      // Find and remove the adjustment batch we created
      const matchingBatch = adjustmentBatches.find(b => {
        const qty = parseFloat(b.quantity.toString());
        return (adj.adjustment === -467 && Math.abs(qty - 467) < 0.01) ||
               (adj.adjustment === -20 && Math.abs(qty - 20) < 0.01);
      });
      
      if (matchingBatch) {
        await prisma.stockBatch.delete({
          where: { id: matchingBatch.id }
        });
        console.log(`   📦 Removed adjustment batch: ${matchingBatch.id}`);
      } else {
        // If we can't find the batch, subtract from existing batches (FIFO)
        let remainingToSubtract = Math.abs(adj.adjustment);
        const batchesAsc = [...batches].reverse(); // Oldest first
        
        for (const batch of batchesAsc) {
          if (remainingToSubtract <= 0) break;
          
          const batchQty = parseFloat(batch.quantity.toString());
          if (batchQty > 0) {
            const reduction = Math.min(remainingToSubtract, batchQty);
            const newBatchQty = batchQty - reduction;
            
            if (newBatchQty > 0) {
              await prisma.stockBatch.update({
                where: { id: batch.id },
                data: { quantity: newBatchQty }
              });
              console.log(`   📦 Reduced batch: ${batchQty} → ${newBatchQty}`);
            } else {
              await prisma.stockBatch.delete({
                where: { id: batch.id }
              });
              console.log(`   📦 Deleted batch (quantity became 0)`);
            }
            
            remainingToSubtract -= reduction;
          }
        }
        
        if (remainingToSubtract > 0) {
          console.log(`   ⚠️  Warning: Could not fully reverse (insufficient batches)`);
        }
      }
    }

    console.log(`   ✅ Undone successfully`);
  }

  console.log('\n🎉 Undo completed!');
}

async function main() {
  // Check if undo mode
  const args = process.argv.slice(2);
  if (args.includes('--undo')) {
    await undoLastRun();
    return;
  }

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
      itemName: 'الاول',
      adjustment: -501, // Subtract 501
      description: 'Subtract 501 from الاول'
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

    // Get all batches for this item
    const batches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: mainWarehouse.id,
        itemId: item.id,
        quantity: {
          gt: 0
        }
      },
      orderBy: {
        receivedAt: 'asc' // Oldest first for FIFO when subtracting
      }
    });

    // Calculate current quantity from batches (this is what the dashboard shows)
    const currentQuantityFromBatches = batches.reduce((sum, b) => {
      return sum + parseFloat(b.quantity.toString());
    }, 0);

    const currentInventoryStock = parseFloat(stock.quantity.toString());
    const newQuantity = currentInventoryStock + adj.adjustment;
    const newQuantityFromBatches = currentQuantityFromBatches + adj.adjustment;

    console.log(`   📊 Current InventoryStock.quantity: ${currentInventoryStock}`);
    console.log(`   📊 Current total from batches: ${currentQuantityFromBatches}`);
    console.log(`   📊 Adjustment: ${adj.adjustment > 0 ? '+' : ''}${adj.adjustment}`);
    console.log(`   📊 New InventoryStock.quantity: ${newQuantity}`);
    console.log(`   📊 New total from batches: ${newQuantityFromBatches}`);

    // Update InventoryStock
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

    // Update batches to reflect the change
    if (adj.adjustment > 0) {
      // For additions: Create a new adjustment batch
      await prisma.stockBatch.create({
        data: {
          inventoryId: mainWarehouse.id,
          itemId: item.id,
          quantity: adj.adjustment,
          notes: `تعديل يدوي: ${adj.description} - ${new Date().toLocaleString('ar-SD')}`
        }
      });
      console.log(`   📦 Created adjustment batch: +${adj.adjustment}`);
    } else if (adj.adjustment < 0 && batches.length > 0) {
      // For subtractions: Reduce quantities from existing batches (FIFO)
      let remainingToSubtract = Math.abs(adj.adjustment);
      
      for (const batch of batches) {
        if (remainingToSubtract <= 0) break;
        
        const batchQty = parseFloat(batch.quantity.toString());
        if (batchQty > 0) {
          const reduction = Math.min(remainingToSubtract, batchQty);
          const newBatchQty = batchQty - reduction;
          
          if (newBatchQty > 0) {
            await prisma.stockBatch.update({
              where: { id: batch.id },
              data: { 
                quantity: newBatchQty,
                notes: batch.notes 
                  ? `${batch.notes} - تعديل: -${reduction}`
                  : `تعديل: -${reduction}`
              }
            });
            console.log(`   📦 Reduced batch ${batch.id}: ${batchQty} → ${newBatchQty} (-${reduction})`);
          } else {
            // Delete batch if quantity becomes 0
            await prisma.stockBatch.delete({
              where: { id: batch.id }
            });
            console.log(`   📦 Deleted batch ${batch.id} (quantity became 0)`);
          }
          
          remainingToSubtract -= reduction;
        }
      }
      
      if (remainingToSubtract > 0) {
        console.log(`   ⚠️  Warning: Could not subtract ${remainingToSubtract} (insufficient batches)`);
      }
    }

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

