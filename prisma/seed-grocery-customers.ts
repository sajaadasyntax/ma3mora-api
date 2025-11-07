import { PrismaClient, CustomerType, Section, PaymentStatus, DeliveryStatus, PaymentMethod, Prisma, Role } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Grocery Customers (البقالات)
 * 
 * Creates customers from the provided list
 * All customers are set as GROCERY type in GROCERY section
 * Creates unpaid delivered invoices for each customer with amount from image
 */

// ============================================
// CUSTOMER DATA (from image with amounts):
// ============================================
const customerData = [
  { name: 'عبد الوهاب دفع الله اب سم', amount: 19433850 },
  { name: 'بقالة البركة - يور / اب سم', amount: 1554000 },
  { name: 'اسعد الزمزمي', amount: 57750 },
  { name: 'عزالدين الحوري', amount: 33618000 },
  { name: 'اسعد مبارك', amount: 296000 },
  { name: 'مبارك الطيب', amount: 211600 },
  { name: 'خالد مدرسة المجد', amount: 488700 },
  { name: 'هيثم حمد النيل', amount: 91450 },
  { name: 'محمد عوض', amount: 730000 },
  { name: 'عابدین محمد - معتوق', amount: 5000 },
  { name: 'حسين علي', amount: 74100 },
  { name: 'اسامه ابراهیم', amount: 351500 },
  { name: 'محمد مهدي', amount: 640000 },
  { name: 'مرکز معتوق - ممدوح', amount: 16377800 },
  { name: 'مركز القرشي - عدي', amount: 31704500 },
  { name: 'علي اب رش الكريمت', amount: 1520000 },
  { name: 'عبد الرحمن عبدالله', amount: 41200 },
  { name: 'حافظ الطيب - العزازي', amount: 37420000 },
  { name: 'محمد عبدالله الحرمين', amount: 1025000 },
  { name: 'فاروق الحوري - معتوق', amount: 4375000 },
  { name: 'بقالة ام القري', amount: 1420000 },
  { name: 'مصعب ميرغني', amount: 102000 },
  { name: 'ود ابراهيم', amount: 180000 },
  { name: 'عبد العزيز اب سم', amount: 282500 },
  { name: 'منصور علي', amount: 121000 },
  { name: 'مركز الهدي', amount: 82700 },
  { name: 'جنابو بكري', amount: 30000 },
  { name: 'يوسف احمد يوسف - بنك النيل', amount: 816000 },
];

async function main() {
  console.log('🌱 Starting seed for Grocery Customers (البقالات)...\n');

  // Find or create the special item "متاخرات ما قبل السيستيم"
  console.log('📦 Finding/Creating item: متاخرات ما قبل السيستيم...');
  let lateItem = await prisma.item.findFirst({
    where: {
      name: 'متاخرات ما قبل السيستيم',
      section: Section.GROCERY,
    },
  });

  if (!lateItem) {
    lateItem = await prisma.item.create({
      data: {
        name: 'متاخرات ما قبل السيستيم',
        section: Section.GROCERY,
        prices: {
          create: [
            { tier: CustomerType.WHOLESALE, price: 1 },
            { tier: CustomerType.RETAIL, price: 1 },
            { tier: CustomerType.AGENT, price: 1 },
          ],
        },
      },
    });
    console.log('  ✨ Created item: متاخرات ما قبل السيستيم');
  } else {
    console.log('  ✅ Item already exists');
  }

  // Find main warehouse inventory
  console.log('\n📦 Finding Main Warehouse...');
  const mainWarehouse = await prisma.inventory.findFirst({
    where: {
      OR: [
        { name: { contains: 'رئيسي' } },
        { name: 'المخزن الرئيسي' }
      ]
    },
  });

  if (!mainWarehouse) {
    throw new Error('Main warehouse not found. Please create it first.');
  }
  console.log(`  ✅ Found warehouse: ${mainWarehouse.name}`);

  // Find a sales user (GROCERY section)
  console.log('\n👤 Finding sales user...');
  const salesUser = await prisma.user.findFirst({
    where: {
      role: { in: [Role.SALES_GROCERY, Role.AGENT_GROCERY] },
    },
  });

  if (!salesUser) {
    throw new Error('No sales user found. Please create a sales user first.');
  }
  console.log(`  ✅ Found sales user: ${salesUser.username}`);

  let created = 0;
  let updated = 0;
  let invoicesCreated = 0;
  let skipped = 0;

  console.log('\n🛒 Processing customers and creating invoices...\n');

  for (const customerInfo of customerData) {
    try {
      // Check if customer already exists
      let customer = await prisma.customer.findFirst({
        where: { name: customerInfo.name },
      });

      if (customer) {
        // Update existing customer to ensure correct type and division
        customer = await prisma.customer.update({
          where: { id: customer.id },
          data: {
            type: CustomerType.WHOLESALE,
            division: Section.GROCERY,
            isAgentCustomer: false,
          },
        });
        console.log(`  ♻️  Updated customer: ${customerInfo.name}`);
        updated++;
      } else {
        // Create new customer
        customer = await prisma.customer.create({
          data: {
            name: customerInfo.name,
            type: CustomerType.WHOLESALE,
            division: Section.GROCERY,
            isAgentCustomer: false,
          },
        });
        console.log(`  ✨ Created customer: ${customerInfo.name}`);
        created++;
      }

      // Check if invoice already exists for this customer
      const existingInvoice = await prisma.salesInvoice.findFirst({
        where: {
          customerId: customer.id,
          items: {
            some: {
              itemId: lateItem.id,
            },
          },
        },
      });

      if (existingInvoice) {
        console.log(`  ⏭️  Invoice already exists for ${customerInfo.name}, skipping...`);
        continue;
      }

      // Create invoice with the amount
      const amount = new Prisma.Decimal(customerInfo.amount);
      const quantity = amount; // Since price is 1, quantity = amount

      // Generate unique invoice number
      const timestamp = Date.now();
      const customerShortId = customer.id.slice(-6);
      const invoiceNumber = `PRE-SYS-${timestamp}-${customerShortId}`;

      const invoice = await prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          inventoryId: mainWarehouse.id,
          section: Section.GROCERY,
          salesUserId: salesUser.id,
          customerId: customer.id,
          paymentMethod: PaymentMethod.CASH,
          paymentStatus: PaymentStatus.CREDIT, // Unpaid
          deliveryStatus: DeliveryStatus.DELIVERED, // Delivered
          paymentConfirmed: false,
          subtotal: amount,
          discount: new Prisma.Decimal(0),
          total: amount,
          paidAmount: new Prisma.Decimal(0), // Unpaid
          notes: 'متاخرات ما قبل السيستيم',
          items: {
            create: {
              itemId: lateItem.id,
              quantity: quantity,
              unitPrice: new Prisma.Decimal(1),
              lineTotal: amount,
            },
          },
        },
      });

      console.log(`  📄 Created invoice: ${invoiceNumber} - Amount: ${amount.toLocaleString()} SDG`);
      invoicesCreated++;
    } catch (error: any) {
      console.error(`  ❌ Error processing ${customerInfo.name}:`, error.message);
      skipped++;
    }
  }

  const totalAmount = customerData.reduce((sum, c) => sum + c.amount, 0);

  console.log(`\n✅ Seed completed successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Section: البقالات (GROCERY)`);
  console.log(`   Customer Type: WHOLESALE`);
  console.log(`   Total customers: ${customerData.length}`);
  console.log(`   Created: ${created} customers`);
  console.log(`   Updated: ${updated} customers`);
  console.log(`   Invoices created: ${invoicesCreated}`);
  console.log(`   Total invoice amount: ${totalAmount.toLocaleString()} SDG`);
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

