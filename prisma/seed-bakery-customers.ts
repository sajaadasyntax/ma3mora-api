import { PrismaClient, CustomerType, Section, PaymentStatus, DeliveryStatus, PaymentMethod, Prisma, Role } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Bakery Customers (الافران)
 * 
 * Creates customers from the provided list
 * All customers are set as WHOLESALE type in BAKERY section
 * Creates unpaid delivered invoices for each customer with amount from images
 */

// ============================================
// CUSTOMER DATA (from images with amounts):
// ============================================
const customerData = [
  // From first image:
  { name: 'عصام ود ابراهيم', amount: 24461600 },
  { name: 'موسى الصادق - الكشيف', amount: 16109600 },
  { name: 'مخبز ام القرى', amount: 40570650 },
  { name: 'مخبز الشهيد', amount: 8035800 },
  { name: 'عادل عثمان ابو شوك', amount: 13502900 },
  { name: 'محمد نصر الدين', amount: 14825000 },
  { name: 'علي صالح', amount: 7708600 },
  { name: 'موسى الصادق - لؤلؤة', amount: 20590500 },
  { name: 'احباب الرسول', amount: 1582000 },
  { name: 'ابراهيم الحبشي', amount: 16580150 },
  { name: 'عبدالمولى حسن', amount: 3900000 },
  { name: 'التوم حميدان', amount: 45421500 },
  { name: 'عوض الجيد عبود', amount: 4160000 },
  { name: 'حاتم الشايقي', amount: 5802550 },
  { name: 'محمد ابو ادريس', amount: 100000 },
  { name: 'احمد عمر بطه', amount: 14892000 },
  { name: 'احمد حسین', amount: 1325000 },
  { name: 'محمد يوسف الجوهرة', amount: 19900000 },
  { name: 'سلفيات العتالة', amount: 60000 },
  { name: 'مخبز الاحسان - حمد', amount: 1000500 },
  { name: 'خالد عبدالقادر', amount: 455000 },
  { name: 'مكاوي بورتسودان', amount: 137100 },
  { name: 'محمدين صوبان', amount: 250000 },
  { name: 'خالد مخبز دریبو', amount: 5800000 },
  { name: 'ابراهيم محمد قرية محمد زين', amount: 3525000 },
  { name: 'عادل ابراهيم', amount: 193000 },
  { name: 'مخبز الجودي - الامين موسى', amount: 1245000 },
  { name: 'احمد الريح - ابو فلج', amount: 1171500 },
  { name: 'حافظ عبدالله - الصلاة على النبي', amount: 6409500 },
  { name: 'عبدالله الامام', amount: 223000 },
  { name: 'محمد ود البحر', amount: 26460000 },
  { name: 'مهدي التوحيد - ام طلحه', amount: 193500 },
  { name: 'محمد مصطفى - الشكينيبة', amount: 198000 },
  { name: 'مدثر الفزاري', amount: 1308500 },
  { name: 'ياسر الطاهر ام طلحه', amount: 2440350 },
  { name: 'الطيب صلاح', amount: 2542500 },
  { name: 'لؤي مصطفى', amount: 1755000 },
  { name: 'فهمي طلحه ود محمود', amount: 3246000 },
  { name: 'الجيلي عبدالله', amount: 482000 },
  { name: 'هيثم حمد النيل', amount: 80000 },
  { name: 'بنج', amount: 30000 },
  { name: 'حاج علي - علي الامين', amount: 2640000 },
  { name: 'عبد العزيز بابكر - ام طلحه عمر مضوي', amount: 1782000 },
  { name: 'ابایزید عبود', amount: 7702500 },
  { name: 'ابراهیم عبود', amount: 2306000 },
  { name: 'احمد محمد حسن - الحله جديده', amount: 2850000 },
  { name: 'عصام يوسف - الحله جديده', amount: 2995500 },
  { name: 'احمد يوسف', amount: 887000 },
  { name: 'عبد العظيم عثمان حله جديده', amount: 3520500 },
  { name: 'سامي ود البحر', amount: 4060000 },
  { name: 'نادر ود حلو', amount: 1644000 },
  { name: 'عادل نادي المريخ فرم', amount: 5210200 },
  { name: 'سامى مخبز الملك 2', amount: 3525000 },
  { name: 'خالد - مدرسة المجد', amount: 174000 },
  
  // From second image:
  { name: 'محمد دفع الله اب سم', amount: 150000 },
  { name: 'عمر مضوي', amount: 30000 },
  { name: 'حساب المخبز محمد + عمر', amount: 18682000 },
  { name: 'مركز معتوق - ممدوح', amount: 167349800 },
  { name: 'مركز القرشي - عدي', amount: 105662000 },
  { name: 'مركز الهدى', amount: 2144450 },
  { name: 'مجدي الطيب', amount: 25078600 },
  { name: 'محمد عادل - نادي المريخ', amount: 3000000 },
  { name: 'خالد يوسف', amount: 1000000 },
  { name: 'مركز القرشي - محمد علي', amount: 71045660 },
];

async function main() {
  console.log('🌱 Starting seed for Bakery Customers (الافران)...\n');

  // Find or create the special item "متاخرات ما قبل السيستيم"
  console.log('📦 Finding/Creating item: متاخرات ما قبل السيستيم...');
  let lateItem = await prisma.item.findFirst({
    where: {
      name: 'متاخرات ما قبل السيستيم',
      section: Section.BAKERY,
    },
  });

  if (!lateItem) {
    lateItem = await prisma.item.create({
      data: {
        name: 'متاخرات ما قبل السيستيم',
        section: Section.BAKERY,
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

  // Find a sales user (BAKERY section)
  console.log('\n👤 Finding sales user...');
  const salesUser = await prisma.user.findFirst({
    where: {
      role: 'SALES_BAKERY',
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
            division: Section.BAKERY,
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
            division: Section.BAKERY,
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

      // Create invoice(s) with the amount
      // Split large amounts (> 99,999,999.99) into multiple invoices to avoid Decimal overflow
      const MAX_SAFE_AMOUNT = 99999999.99;
      const totalAmount = customerInfo.amount;
      const timestamp = Date.now();
      const customerShortId = customer.id.slice(-6);
      
      if (totalAmount > MAX_SAFE_AMOUNT) {
        // Split into multiple invoices
        let remaining = totalAmount;
        let invoiceIndex = 1;
        
        while (remaining > 0) {
          const invoiceAmount = Math.min(remaining, MAX_SAFE_AMOUNT);
          const amount = new Prisma.Decimal(invoiceAmount);
          const quantity = amount; // Since price is 1, quantity = amount
          
          const invoiceNumber = `PRE-SYS-BAKERY-${timestamp}-${customerShortId}-${invoiceIndex}`;
          
          await prisma.salesInvoice.create({
            data: {
              invoiceNumber,
              inventoryId: mainWarehouse.id,
              section: Section.BAKERY,
              salesUserId: salesUser.id,
              customerId: customer.id,
              paymentMethod: PaymentMethod.CASH,
              paymentStatus: PaymentStatus.CREDIT, // Unpaid
              deliveryStatus: DeliveryStatus.DELIVERED, // Marked as delivered but NO delivery record created
              paymentConfirmed: false,
              subtotal: amount,
              discount: new Prisma.Decimal(0),
              total: amount,
              paidAmount: new Prisma.Decimal(0), // Unpaid
              notes: `متاخرات ما قبل السيستيم - لا يؤثر على المخزون (جزء ${invoiceIndex})`,
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
          
          console.log(`  📄 Created invoice ${invoiceIndex}: ${invoiceNumber} - Amount: ${amount.toLocaleString()} SDG (No stock impact)`);
          invoicesCreated++;
          remaining -= invoiceAmount;
          invoiceIndex++;
        }
      } else {
        // Single invoice for amounts within limit
        const amount = new Prisma.Decimal(totalAmount);
        const quantity = amount; // Since price is 1, quantity = amount
        
        const invoiceNumber = `PRE-SYS-BAKERY-${timestamp}-${customerShortId}`;
        
        await prisma.salesInvoice.create({
          data: {
            invoiceNumber,
            inventoryId: mainWarehouse.id,
            section: Section.BAKERY,
            salesUserId: salesUser.id,
            customerId: customer.id,
            paymentMethod: PaymentMethod.CASH,
            paymentStatus: PaymentStatus.CREDIT, // Unpaid
            deliveryStatus: DeliveryStatus.DELIVERED, // Marked as delivered but NO delivery record created
            paymentConfirmed: false,
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
      }
    } catch (error: any) {
      console.error(`  ❌ Error processing ${customerInfo.name}:`, error.message);
      skipped++;
    }
  }

  const totalAmount = customerData.reduce((sum, c) => sum + c.amount, 0);

  console.log(`\n✅ Seed completed successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Section: الافران (BAKERY)`);
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

