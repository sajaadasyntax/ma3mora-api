/**
 * Data Migration Script: BANK -> BANKAK rename & other Phase 0 data updates
 * 
 * Run with: npx ts-node prisma/data-migration-bank-to-bankak.ts
 * 
 * This script handles:
 * 1. All BANK -> BANKAK enum value updates are handled by the SQL migration (ALTER TYPE RENAME VALUE)
 * 2. Set warehouseType = MAIN for all existing inventories (handled by column default in migration)
 * 3. Calculate Advance.remainingBalance for all existing advances
 * 4. Set Salary.netAmount = amount for all existing salaries (no deductions existed)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting data migration...');

  // Step 1: Calculate remainingBalance for existing advances
  // For existing advances: remainingBalance = amount (since no deductions have been tracked)
  console.log('Step 1: Updating advance remaining balances...');
  const advances = await prisma.advance.findMany();
  let advanceCount = 0;
  for (const advance of advances) {
    await prisma.advance.update({
      where: { id: advance.id },
      data: {
        remainingBalance: advance.amount,
        isFullyPaid: false,
      },
    });
    advanceCount++;
  }
  console.log(`  Updated ${advanceCount} advances with remainingBalance`);

  // Step 2: Set netAmount = amount for existing salaries (no deductions existed before)
  console.log('Step 2: Updating salary net amounts...');
  const salaries = await prisma.salary.findMany();
  let salaryCount = 0;
  for (const salary of salaries) {
    await prisma.salary.update({
      where: { id: salary.id },
      data: {
        netAmount: salary.amount,
        deductions: 0,
        openingLoanBalance: 0,
        closingLoanBalance: 0,
      },
    });
    salaryCount++;
  }
  console.log(`  Updated ${salaryCount} salaries with netAmount`);

  // Step 3: Seed the Road and Side virtual warehouses if they don't exist
  console.log('Step 3: Seeding virtual warehouses...');
  const roadWarehouse = await prisma.inventory.findFirst({
    where: { warehouseType: 'ROAD' },
  });
  if (!roadWarehouse) {
    await prisma.inventory.create({
      data: {
        name: 'مخزن الطريق',  // Road Warehouse
        isMain: false,
        warehouseType: 'ROAD',
      },
    });
    console.log('  Created Road Warehouse (مخزن الطريق)');
  } else {
    console.log('  Road Warehouse already exists');
  }

  const sideWarehouse = await prisma.inventory.findFirst({
    where: { warehouseType: 'SIDE' },
  });
  if (!sideWarehouse) {
    await prisma.inventory.create({
      data: {
        name: 'مخزن الهدايا',  // Side Warehouse (Gifts)
        isMain: false,
        warehouseType: 'SIDE',
      },
    });
    console.log('  Created Side Warehouse (مخزن الهدايا)');
  } else {
    console.log('  Side Warehouse already exists');
  }

  console.log('Data migration completed successfully!');
}

main()
  .catch((e) => {
    console.error('Data migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
