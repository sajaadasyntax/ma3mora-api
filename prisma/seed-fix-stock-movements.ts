/**
 * Fix Stock Movements Script
 * 
 * This script fixes StockMovement records by recalculating them based on:
 * 1. Current stock from batches (the source of truth)
 * 2. All transactions (procurements, sales, deliveries) that happened
 * 
 * It recalculates opening and closing balances to match actual stock.
 */

import { PrismaClient, Prisma, Section } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Starting stock movement fixes...\n');

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

  // Items to fix (based on the mismatches shown)
  const itemsToFix = [
    { name: 'الاول', section: Section.GROCERY },
    { name: 'كابو 1ك', section: Section.GROCERY },
    { name: 'شعيرية نوبو 300 جم * 30', section: Section.GROCERY },
    { name: 'خميرة بيضاء', section: Section.BAKERY },
    { name: 'خميرة فكتوريا', section: Section.BAKERY },
    { name: 'الالي', section: Section.BAKERY }
  ];

  for (const itemInfo of itemsToFix) {
    console.log(`\n🔍 Processing: ${itemInfo.name} (${itemInfo.section})`);

    // Find the item
    const item = await prisma.item.findFirst({
      where: {
        name: itemInfo.name,
        section: itemInfo.section
      }
    });

    if (!item) {
      console.log(`   ⚠️  Item not found: ${itemInfo.name}`);
      continue;
    }

    // Get current stock from batches (source of truth)
    const batches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: mainWarehouse.id,
        itemId: item.id,
        quantity: {
          gt: 0
        }
      }
    });

    const currentStockFromBatches = batches.reduce((sum, b) => {
      return sum + parseFloat(b.quantity.toString());
    }, 0);

    console.log(`   📊 Current stock from batches: ${currentStockFromBatches}`);

    // Get all stock movements for this item, ordered by date
    const movements = await prisma.stockMovement.findMany({
      where: {
        inventoryId: mainWarehouse.id,
        itemId: item.id
      },
      orderBy: {
        movementDate: 'asc'
      }
    });

    if (movements.length === 0) {
      console.log(`   ⚠️  No stock movements found`);
      continue;
    }

    console.log(`   📊 Found ${movements.length} stock movement records`);

    // Show all movements for debugging
    console.log(`   📋 Current movements:`);
    movements.forEach((m, idx) => {
      console.log(`      ${idx + 1}. ${m.movementDate.toISOString().split('T')[0]}: Opening=${m.openingBalance}, Incoming=${m.incoming}, Outgoing=${m.outgoing}, Closing=${m.closingBalance}`);
    });

    // Calculate what the opening balance should be for the first movement
    // by working backwards from current stock
    let runningTotal = currentStockFromBatches;
    console.log(`   🔄 Working backwards from current stock: ${runningTotal}`);
    
    // Work backwards through movements (from most recent to oldest)
    for (let i = movements.length - 1; i >= 0; i--) {
      const movement = movements[i];
      const incoming = parseFloat(movement.incoming.toString());
      const outgoing = parseFloat(movement.outgoing.toString());
      const pendingOutgoing = parseFloat(movement.pendingOutgoing.toString());
      const incomingGifts = parseFloat(movement.incomingGifts.toString());
      const outgoingGifts = parseFloat(movement.outgoingGifts.toString());

      console.log(`   🔄 Reversing movement ${movement.movementDate.toISOString().split('T')[0]}:`);
      console.log(`      Before reverse: ${runningTotal}`);
      console.log(`      Subtracting: incoming=${incoming}, incomingGifts=${incomingGifts}`);
      console.log(`      Adding back: outgoing=${outgoing}, pendingOutgoing=${pendingOutgoing}, outgoingGifts=${outgoingGifts}`);

      // Reverse the movement to get the opening balance
      // closing = opening + incoming - outgoing - pendingOutgoing + incomingGifts - outgoingGifts
      // opening = closing - incoming + outgoing + pendingOutgoing - incomingGifts + outgoingGifts
      const calculatedOpening = runningTotal 
        - incoming 
        + outgoing 
        + pendingOutgoing 
        - incomingGifts 
        + outgoingGifts;

      console.log(`      After reverse: ${calculatedOpening}`);
      runningTotal = calculatedOpening;
    }

    const firstMovementOpening = runningTotal;
    console.log(`   📊 Calculated opening balance for first movement: ${firstMovementOpening}`);

    // Now recalculate all movements forward from the corrected opening balance
    let currentOpening = new Prisma.Decimal(firstMovementOpening);

    for (let i = 0; i < movements.length; i++) {
      const movement = movements[i];
      const incoming = movement.incoming;
      const outgoing = movement.outgoing;
      const pendingOutgoing = movement.pendingOutgoing;
      const incomingGifts = movement.incomingGifts;
      const outgoingGifts = movement.outgoingGifts;

      // Calculate closing balance
      const closingBalance = currentOpening
        .add(incoming)
        .add(incomingGifts)
        .sub(outgoing)
        .sub(pendingOutgoing)
        .sub(outgoingGifts);

      const oldOpening = parseFloat(movement.openingBalance.toString());
      const oldClosing = parseFloat(movement.closingBalance.toString());
      const newOpening = parseFloat(currentOpening.toString());
      const newClosing = parseFloat(closingBalance.toString());

      // Only update if there's a difference
      if (Math.abs(oldOpening - newOpening) > 0.01 || Math.abs(oldClosing - newClosing) > 0.01) {
        await prisma.stockMovement.update({
          where: { id: movement.id },
          data: {
            openingBalance: currentOpening,
            closingBalance: closingBalance
          }
        });

        console.log(`   ✅ Updated movement ${movement.movementDate.toISOString().split('T')[0]}:`);
        console.log(`      Opening: ${oldOpening} → ${newOpening}`);
        console.log(`      Closing: ${oldClosing} → ${newClosing}`);
      } else {
        console.log(`   ✓ Movement ${movement.movementDate.toISOString().split('T')[0]} already correct`);
      }

      // Next day's opening = this day's closing
      currentOpening = closingBalance;
    }

    // Get the updated last movement to verify
    const updatedLastMovement = await prisma.stockMovement.findUnique({
      where: { id: movements[movements.length - 1].id }
    });
    
    const lastClosing = updatedLastMovement ? parseFloat(updatedLastMovement.closingBalance.toString()) : 0;
    const difference = Math.abs(lastClosing - currentStockFromBatches);

    if (difference > 0.01) {
      console.log(`   ⚠️  Warning: Last closing balance (${lastClosing}) doesn't match current stock (${currentStockFromBatches})`);
      console.log(`      Difference: ${difference}`);
    } else {
      console.log(`   ✅ Verified: Last closing balance matches current stock`);
    }
  }

  console.log('\n🎉 Stock movement fixes completed!');
  console.log('\n📝 Summary:');
  console.log('   All StockMovement records have been recalculated based on current stock.');
  console.log('   Opening and closing balances should now match actual stock levels.');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

