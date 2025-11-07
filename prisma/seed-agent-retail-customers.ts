import { PrismaClient, CustomerType, Section } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Agent Account Retail Customers
 * 
 * These are retail customers that belong to agent accounts
 * - Type: RETAIL
 * - Division: GROCERY (البقالات)
 * - isAgentCustomer: true (indicates they belong to an agent)
 * 
 * Just paste your customer names in the customerData array below
 */

// ============================================
// CUSTOMER DATA (from images):
// ============================================
const customerData = [
  // From first image:
  { name: 'احمد عبد الحفيظ مندوب القطاعي' },
  { name: 'عماد النخيل' },
  { name: 'مهدى المستشفى' },
  { name: 'سوبر الميناء البري' },
  { name: 'القوس - الزعيم' },
  { name: 'محمد - عربة الكابو' },
  { name: 'خالد برادیس' },
  { name: 'محمد - المستشفي' },
  { name: 'شوقي كافتريا دبل لي' },
  { name: 'حمدي المودة' },
  { name: 'ياسين (سامي)' },
  { name: 'علي محمد - شيش' },
  { name: 'يوسف - اماسينا' },
  { name: 'الشاذلي المستشفي' },
  { name: 'الافريقي مصطفي' },
  { name: 'احمد آدم' },
  { name: 'محمد الزبير المندوب' },
  
  // From second image:
  { name: 'عادل حسن سالم' },
  { name: 'محمد البشير' },
  { name: 'عبد الباقي عبدة' },
  { name: 'عباس رابح' },
  { name: 'عبدالله عمر' },
  { name: 'ازرق عبدالله' },
  { name: 'نادر البشير' },
  { name: 'يس ود البحر' },
  { name: 'موسي سعيد' },
  { name: 'ود البحر محمد احمد' },
  { name: 'قرین محمد احمد' },
  { name: 'عبد الباقي النور' },
  { name: 'محمد الحلبي' },
  { name: 'عصام ادم' },
  { name: 'محمد علي كنو' },
  { name: 'اولاد ابراهیم' },
  { name: 'محمد يوسف النعمة' },
  { name: 'محمد ادم' },
  { name: 'محمد التهامي' },
  { name: 'محمد مصطفي البعيو' },
  { name: 'جلال بابكر' },
];

async function main() {
  console.log('🌱 Starting seed for Agent Account Retail Customers...\n');
  console.log(`📋 Processing ${customerData.length} customers...\n`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const customerInfo of customerData) {
    try {
      // Check if customer already exists
      const existingCustomer = await prisma.customer.findFirst({
        where: { name: customerInfo.name },
      });

      if (existingCustomer) {
        // Update existing customer to ensure correct type and division
        await prisma.customer.update({
          where: { id: existingCustomer.id },
          data: {
            type: CustomerType.RETAIL, // Retail customers for agents
            division: Section.GROCERY, // البقالات section
            isAgentCustomer: true, // This indicates they belong to an agent
          },
        });
        console.log(`  ♻️  Updated: ${customerInfo.name}`);
        updated++;
      } else {
        // Create new customer
        await prisma.customer.create({
          data: {
            name: customerInfo.name,
            type: CustomerType.RETAIL, // Retail customers for agents
            division: Section.GROCERY, // البقالات section
            isAgentCustomer: true, // This indicates they belong to an agent
          },
        });
        console.log(`  ✨ Created: ${customerInfo.name}`);
        created++;
      }
    } catch (error: any) {
      console.error(`  ❌ Error processing ${customerInfo.name}:`, error.message);
      skipped++;
    }
  }

  console.log(`\n✅ Seed completed successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Section: البقالات (GROCERY)`);
  console.log(`   Customer Type: RETAIL`);
  console.log(`   isAgentCustomer: true`);
  console.log(`   Total customers: ${customerData.length}`);
  console.log(`   Created: ${created} customers`);
  console.log(`   Updated: ${updated} customers`);
  console.log(`   Skipped/Errors: ${skipped} customers`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

