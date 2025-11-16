import { PrismaClient, PaymentMethod, Prisma, Role } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Inbound Debts (Income records marked as debt)
 * 
 * Creates Income records with isDebt = true
 * These represent money owed to the company (inbound debts)
 */

// ============================================
// DEBT DATA (from image):
// ============================================
const debtData = [
  { description: 'مخزن الشارع', amount: 368714500 },
  { description: 'تعويضات 25 كيلو', amount: 34721200 },
  { description: 'ترحيل إبراهيم عبدالله - الشركة', amount: 450000 },
  { description: 'قيمة 30 الف ريال اب سم وعمر مضوي', amount: 12275000 },
];

async function main() {
  console.log('🌱 Starting seed for Inbound Debts (Income records)...\n');

  // Find accountant user
  console.log('👤 Finding accountant user...');
  const accountantUser = await prisma.user.findFirst({
    where: {
      role: { in: ['ACCOUNTANT', 'MANAGER'] },
    },
  });

  if (!accountantUser) {
    throw new Error('No accountant/manager user found. Please create one first.');
  }
  console.log(`  ✅ Found accountant user: ${accountantUser.username}`);

  let created = 0;
  let skipped = 0;

  console.log('\n💰 Processing inbound debts...\n');

  for (const debtInfo of debtData) {
    try {
      // Check if debt already exists (by description and amount)
      const existingDebt = await prisma.income.findFirst({
        where: {
          description: debtInfo.description,
          amount: debtInfo.amount,
          isDebt: true,
        },
      });

      if (existingDebt) {
        console.log(`  ⏭️  Debt already exists: ${debtInfo.description}, skipping...`);
        skipped++;
        continue;
      }

      // Create income record marked as debt
      const income = await prisma.income.create({
        data: {
          amount: new Prisma.Decimal(debtInfo.amount),
          method: PaymentMethod.CASH, // Default payment method (can be changed when paid)
          description: debtInfo.description,
          isDebt: true, // Mark as debt
          createdBy: accountantUser.id,
          // No inventoryId or section - these are general debts
        },
      });

      console.log(`  ✅ Created debt: ${debtInfo.description}`);
      console.log(`     Amount: ${debtInfo.amount.toLocaleString()} SDG`);
      console.log(`     Status: Unpaid (isDebt = true)`);
      
      created++;
    } catch (error: any) {
      console.error(`  ❌ Error processing debt "${debtInfo.description}":`, error.message);
      skipped++;
    }
  }

  const totalAmount = debtData.reduce((sum, d) => sum + d.amount, 0);

  console.log(`\n✅ Seed completed successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Total debts: ${debtData.length}`);
  console.log(`   Created: ${created} debts`);
  console.log(`   Skipped: ${skipped} debts (already exist)`);
  console.log(`   Total debt amount: ${totalAmount.toLocaleString()} SDG`);
  console.log(`\n💡 Note: These debts can be paid using the /accounting/income/:id/pay-debt endpoint`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });











