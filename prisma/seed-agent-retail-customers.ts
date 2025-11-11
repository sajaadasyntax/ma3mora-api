import { PrismaClient, CustomerType, Section, PaymentStatus, DeliveryStatus, PaymentMethod, Prisma, Role } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Agent Account Retail Customers
 * 
 * These are retail customers that belong to agent accounts
 * - Type: RETAIL
 * - Division: GROCERY (البقالات)
 * - isAgentCustomer: true (indicates they belong to an agent)
 * Creates unpaid delivered invoices for each customer with amount from images
 */

// ============================================
// CUSTOMER DATA (from images with amounts):
// ============================================
const customerData = [
  // From first image:
  { name: 'احمد عبد الحفيظ مندوب القطاعي', amount: 1500900 },
  { name: 'عماد النخيل', amount: 300000 },
  { name: 'مهدى المستشفى', amount: 447500 },
  { name: 'سوبر الميناء البري', amount: 592500 },
  { name: 'القوس - الزعيم', amount: 463500 },
  { name: 'محمد - عربة الكابو', amount: 266250 },
  { name: 'خالد برادیس', amount: 348800 },
  { name: 'محمد - المستشفي', amount: 237500 },
  { name: 'شوقي كافتريا دبل لي', amount: 582500 },
  { name: 'حمدي المودة', amount: 495000 },
  { name: 'ياسين (سامي)', amount: 207500 },
  { name: 'علي محمد - شيش', amount: 449500 },
  { name: 'يوسف - اماسينا', amount: 427750 },
  { name: 'الشاذلي المستشفي', amount: 632500 },
  { name: 'الافريقي مصطفي', amount: 185000 },
  { name: 'احمد آدم', amount: 500000 },
  { name: 'محمد الزبير المندوب', amount: 95250 },
  
  // From second image:
  { name: 'احمد مالك', amount: 2561500 },
  { name: 'محمد خليفة', amount: 804000 },
  { name: 'الرشيد صالح', amount: 2195000 },
  { name: 'معتز سالم', amount: 90700 },
  { name: 'يس المندوب', amount: 209700 },
  { name: 'سلمان بقالة', amount: 209800 },
  { name: 'عادل ابراهيم', amount: 412000 },
  { name: 'دفع الله خليفة', amount: 3605000 },
  { name: 'بدر الدین محمد سالم', amount: 1769000 },
  { name: 'الهادي حمد', amount: 245000 },
  { name: 'عثمان صوبان', amount: 246000 },
  { name: 'محمد عبد الحميد', amount: 865000 },
  { name: 'محمد جبارة', amount: 2105000 },
  { name: 'اسامه يوسف', amount: 532500 },
  { name: 'عبد المنعم الكش', amount: 921000 },
  { name: 'احمد رابح', amount: 445000 },
  { name: 'قسم جبارة', amount: 740000 },
  { name: 'الخير المدني', amount: 810000 },
  { name: 'مدثر احمد', amount: 370000 },
  { name: 'بكري دفع الله', amount: 1136000 },
  { name: 'محمد المامون', amount: 2000 },
  { name: 'يوسف الجزولي', amount: 1675000 },
  { name: 'طه معتصم', amount: 365000 },
  { name: 'علي اشهد', amount: 300000 },
  { name: 'عاصم عبد الباقي', amount: 250000 },
  { name: 'موسي عبد الباقي', amount: 1355000 },
  { name: 'خالد عمر لطفي', amount: 1155000 },
  { name: 'عبدالله ملح', amount: 1614000 },
  { name: 'البيهقي محمد النعمة', amount: 95000 },
  { name: 'محمد نادر', amount: 3000 },
  { name: 'ضياء الدين حاج على', amount: 300000 },
  { name: 'عمر آدم', amount: 2734500 },
  { name: 'ابراهيم عادل', amount: 66000 },
  { name: 'محي الدين صالح', amount: 522000 },
  { name: 'عادل حسن سالم', amount: 490000 },
  { name: 'محمد البشير', amount: 2895000 },
  { name: 'عبد الباقى عبدة', amount: 250000 },
  { name: 'عباس رابح', amount: 120000 },
  { name: 'عبدالله عمر', amount: 40000 },
  { name: 'ازرق عبدالله', amount: 2835500 },
  { name: 'نادر البشير', amount: 700000 },
  { name: 'احمد آدم', amount: 1650000 },
  { name: 'يس ود البحر', amount: 2175000 },
  { name: 'موسي سعيد', amount: 20000 },
  { name: 'ود البحر محمد احمد', amount: 9200 },
  { name: 'قرین محمد احمد', amount: 600000 },
  { name: 'عبد الباقي النور', amount: 1430000 },
  { name: 'محمد الحلبي', amount: 2705000 },
  { name: 'عصام ادم', amount: 1675000 },
  { name: 'محمد علی کنو', amount: 2310000 },
  { name: 'اولاد ابراهیم', amount: 2482000 },
  { name: 'محمد يوسف النعمة', amount: 2015000 },
  { name: 'محمد ادم', amount: 177500 },
  { name: 'محمد التهامي', amount: 1025000 },
  { name: 'محمد مصطفى البعيو', amount: 1381000 },
  { name: 'جلال بابكر', amount: 25000 },
];

async function main() {
  console.log('🌱 Starting seed for Agent Account Retail Customers...\n');

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

  // Find an agent user (AGENT_GROCERY role)
  console.log('\n👤 Finding agent user...');
  const agentUser = await prisma.user.findFirst({
    where: {
      role: 'AGENT_GROCERY' as Role,
    },
  });

  if (!agentUser) {
    throw new Error('No agent user found. Please create an agent user first.');
  }
  console.log(`  ✅ Found agent user: ${agentUser.username}`);

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
            type: CustomerType.RETAIL,
            division: Section.GROCERY,
          },
        });
        console.log(`  ♻️  Updated customer: ${customerInfo.name}`);
        updated++;
      } else {
        // Create new customer
        customer = await prisma.customer.create({
          data: {
            name: customerInfo.name,
            type: CustomerType.RETAIL,
            division: Section.GROCERY,
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
      const invoiceNumber = `PRE-SYS-AGENT-${timestamp}-${customerShortId}`;

      // Create invoice WITHOUT creating InventoryDelivery records
      // This ensures stock is NOT affected since stock is only reduced when
      // InventoryDelivery records are created through the delivery endpoint
      const invoice = await prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          inventoryId: mainWarehouse.id,
          section: Section.GROCERY,
          salesUserId: agentUser.id,
          customerId: customer.id,
          paymentMethod: PaymentMethod.CASH,
          paymentStatus: PaymentStatus.CREDIT, // Unpaid
          deliveryStatus: DeliveryStatus.DELIVERED, // Marked as delivered but NO delivery record created
          paymentConfirmationStatus: 'PENDING',
          subtotal: amount,
          discount: new Prisma.Decimal(0),
          total: amount,
          paidAmount: new Prisma.Decimal(0), // Unpaid
          notes: 'متاخرات ما قبل السيستيم - لا يؤثر على المخزون',
          items: {
            create: {
              itemId: lateItem.id,
              quantity: quantity,
              unitPrice: new Prisma.Decimal(1),
              lineTotal: amount,
            },
          },
          // IMPORTANT: Do NOT create InventoryDelivery records here
          // Stock is only reduced when InventoryDelivery is created via the delivery endpoint
        },
      });

      console.log(`  📄 Created invoice: ${invoiceNumber} - Amount: ${amount.toLocaleString()} SDG (No stock impact)`);
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
  console.log(`   Customer Type: RETAIL`);
  console.log(`   isAgentCustomer: true`);
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

