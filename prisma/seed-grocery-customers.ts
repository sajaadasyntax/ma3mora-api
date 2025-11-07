import { PrismaClient, CustomerType, Section } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Grocery Customers (البقالات)
 * 
 * Creates customers from the provided list
 * All customers are set as GROCERY type in GROCERY section
 */

// ============================================
// CUSTOMER DATA (from image):
// ============================================
const customerData = [
  { name: 'عبد الوهاب دفع الله اب سم' },
  { name: 'بقالة البركة - يور / اب سم' },
  { name: 'اسعد الزمزمي' },
  { name: 'عزالدين الحوري' },
  { name: 'اسعد مبارك' },
  { name: 'مبارك الطيب' },
  { name: 'خالد مدرسة المجد' },
  { name: 'هيثم حمد النيل' },
  { name: 'محمد عوض' },
  { name: 'عابدین محمد - معتوق' },
  { name: 'حسين علي' },
  { name: 'اسامه ابراهیم' },
  { name: 'محمد مهدي' },
  { name: 'مرکز معتوق - ممدوح' },
  { name: 'مركز القرشي - عدي' },
  { name: 'علي اب رش الكريمت' },
  { name: 'عبد الرحمن عبدالله' },
  { name: 'حافظ الطيب - العزازي' },
  { name: 'محمد عبدالله الحرمين' },
  { name: 'فاروق الحوري - معتوق' },
  { name: 'بقالة ام القري' },
  { name: 'مصعب ميرغني' },
  { name: 'ود ابراهيم' },
  { name: 'عبد العزيز اب سم' },
  { name: 'منصور علي' },
  { name: 'مركز الهدي' },
  { name: 'جنابو بكري' },
  { name: 'يوسف احمد يوسف - بنك النيل' },
];

async function main() {
  console.log('🌱 Starting seed for Grocery Customers (البقالات)...\n');

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
            type: CustomerType.WHOLESALE, // Grocery stores are wholesale customers
            division: Section.GROCERY,
            isAgentCustomer: false,
          },
        });
        console.log(`  ♻️  Updated: ${customerInfo.name}`);
        updated++;
      } else {
        // Create new customer
        await prisma.customer.create({
          data: {
            name: customerInfo.name,
            type: CustomerType.WHOLESALE, // Grocery stores are wholesale customers
            division: Section.GROCERY,
            isAgentCustomer: false,
            phone: customerInfo.phone || null,
            address: customerInfo.address || null,
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
  console.log(`   Customer Type: WHOLESALE`);
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

