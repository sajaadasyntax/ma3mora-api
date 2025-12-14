import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Script to remove wrongly entered entries:
 * 1. Expense: "الديون الصادرة (علينا)" with amount 3,944,000
 * 2. Supplier: "فواتير قديمة" and all its procurement orders
 */

async function removeWrongEntries() {
  console.log('🔍 Starting removal of wrongly entered entries...\n');

  try {
    // ========== 1. Remove Expense: "الديون الصادرة (علينا)" ==========
    console.log('📋 Step 1: Searching for expense "الديون الصادرة (علينا)"...');
    
    const targetAmount = new Prisma.Decimal('3944000');
    const expenses = await prisma.expense.findMany({
      where: {
        isDebt: true,
        description: {
          contains: 'الديون الصادرة',
        },
      },
    });

    console.log(`   Found ${expenses.length} expense(s) with "الديون الصادرة" in description`);

    // Find the exact match
    const targetExpense = expenses.find(
      (e) => e.description.includes('علينا') && e.amount.equals(targetAmount)
    );

    if (targetExpense) {
      console.log(`   ✅ Found expense to delete:`);
      console.log(`      ID: ${targetExpense.id}`);
      console.log(`      Description: ${targetExpense.description}`);
      console.log(`      Amount: ${targetExpense.amount.toString()} SDG`);
      console.log(`      Created at: ${targetExpense.createdAt}`);

      await prisma.expense.delete({
        where: { id: targetExpense.id },
      });

      console.log(`   ✅ Successfully deleted expense "${targetExpense.description}"\n`);
    } else {
      console.log(`   ⚠️  Expense not found with exact criteria. Checking all matches...`);
      expenses.forEach((e) => {
        console.log(`      - ${e.description} (${e.amount.toString()} SDG)`);
      });
      console.log(`   ⚠️  No exact match found. Skipping expense deletion.\n`);
    }

    // ========== 2. Remove Supplier "فواتير قديمة" and its orders ==========
    console.log('📋 Step 2: Searching for supplier "فواتير قديمة"...');

    const supplier = await prisma.supplier.findFirst({
      where: {
        name: 'فواتير قديمة',
      },
      include: {
        procOrders: {
          include: {
            items: true,
            payments: true,
            returns: true,
            receipts: true,
          },
        },
      },
    });

    if (!supplier) {
      console.log('   ⚠️  Supplier "فواتير قديمة" not found. Skipping supplier deletion.\n');
    } else {
      console.log(`   ✅ Found supplier:`);
      console.log(`      ID: ${supplier.id}`);
      console.log(`      Name: ${supplier.name}`);
      console.log(`      Created at: ${supplier.createdAt}`);
      console.log(`      Number of procurement orders: ${supplier.procOrders.length}`);

      // Calculate total outstanding
      let totalOutstanding = new Prisma.Decimal(0);
      supplier.procOrders.forEach((order) => {
        const outstanding = new Prisma.Decimal(order.total).sub(order.paidAmount);
        if (outstanding.greaterThan(0)) {
          totalOutstanding = totalOutstanding.add(outstanding);
        }
      });
      console.log(`      Total outstanding: ${totalOutstanding.toString()} SDG`);

      // Delete all procurement orders and their related data
      if (supplier.procOrders.length > 0) {
        console.log(`\n   🗑️  Deleting ${supplier.procOrders.length} procurement order(s)...`);

        for (const order of supplier.procOrders) {
          console.log(`      Deleting order ${order.orderNumber}...`);

          // Delete in transaction to ensure all related data is removed
          await prisma.$transaction(async (tx) => {
            // Delete inventory receipts
            // Note: StockBatch records will have their receiptId set to null (onDelete: SetNull)
            // We don't delete the batches themselves as they may have been used in sales
            await tx.inventoryReceipt.deleteMany({
              where: {
                orderId: order.id,
              },
            });

            // Delete payments (cascade should handle this, but being explicit)
            await tx.procOrderPayment.deleteMany({
              where: { orderId: order.id },
            });

            // Delete returns
            await tx.procOrderReturn.deleteMany({
              where: { orderId: order.id },
            });

            // Delete order items
            await tx.procOrderItem.deleteMany({
              where: { orderId: order.id },
            });

            // Finally delete the order
            await tx.procOrder.delete({
              where: { id: order.id },
            });
          });

          console.log(`      ✅ Deleted order ${order.orderNumber}`);
        }

        console.log(`   ✅ Successfully deleted all procurement orders\n`);
      }

      // Delete opening balances for this supplier
      const openingBalances = await prisma.openingBalance.findMany({
        where: {
          scope: 'SUPPLIER',
          refId: supplier.id,
        },
      });

      if (openingBalances.length > 0) {
        console.log(`   🗑️  Deleting ${openingBalances.length} opening balance(s)...`);
        await prisma.openingBalance.deleteMany({
          where: {
            scope: 'SUPPLIER',
            refId: supplier.id,
          },
        });
        console.log(`   ✅ Successfully deleted opening balances\n`);
      }

      // Delete cumulative aggregates for this supplier
      const aggregates = await prisma.supplierCumulativeAggregate.findMany({
        where: {
          supplierId: supplier.id,
        },
      });

      if (aggregates.length > 0) {
        console.log(`   🗑️  Deleting ${aggregates.length} cumulative aggregate(s)...`);
        await prisma.supplierCumulativeAggregate.deleteMany({
          where: {
            supplierId: supplier.id,
          },
        });
        console.log(`   ✅ Successfully deleted cumulative aggregates\n`);
      }

      // Finally delete the supplier
      console.log(`   🗑️  Deleting supplier "${supplier.name}"...`);
      await prisma.supplier.delete({
        where: { id: supplier.id },
      });
      console.log(`   ✅ Successfully deleted supplier "${supplier.name}"\n`);
    }

    console.log('✅ Script completed successfully!');
    console.log('\n📊 Summary:');
    console.log('   - Removed expense: "الديون الصادرة (علينا)" (if found)');
    console.log('   - Removed supplier: "فواتير قديمة" and all related data (if found)');
    console.log('\n⚠️  Please verify the changes in your database.');

  } catch (error) {
    console.error('❌ Error removing entries:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
removeWrongEntries()
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });

