import { PrismaClient, Section, PaymentMethod, Prisma, ProcOrderStatus, Role, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Paid and Delivered Procurement Orders
 * 
 * Creates procurement orders from suppliers (العهدة, بحري, مدني)
 * All orders are marked as:
 * - Status: RECEIVED (delivered)
 * - Payment: Full payment with paymentConfirmed = true
 * - Note: NO InventoryReceipt records created to avoid stock impact
 */

// ============================================
// ORDER DATA (from image):
// ============================================
const orderData = [
  // From العهدة (Al-Ahda):
  { supplier: 'العهدة', item: 'منتجات', quantity: 23077500, amount: 23077500, date: '2024-10-23' },
  { supplier: 'العهدة', item: 'منتجات', quantity: 36122500, amount: 36122500, date: '2024-10-27' },
  { supplier: 'العهدة', item: 'الأول', quantity: 1898, amount: 35777300, date: '2024-11-03' },
  { supplier: 'العهدة', item: 'شعيرية', quantity: 1450, amount: 45457500, date: '2024-11-04' },
  
  // From بحري (Bahri):
  { supplier: 'بحري', item: 'الأول', quantity: 1500, amount: 27225000, date: '2024-10-28' },
  { supplier: 'بحري', item: 'صافية', quantity: 11850000, amount: 11850000, date: '2024-10-28' },
  { supplier: 'بحري', item: 'الأول', quantity: 1250, amount: 22687500, date: '2024-10-29' },
  { supplier: 'بحري', item: 'الأول', quantity: 1000, amount: 18150000, date: '2024-11-05' },
  { supplier: 'بحري', item: 'سمولينا', quantity: 500, amount: 15225000, date: '2024-11-05' },
  { supplier: 'بحري', item: 'الأول', quantity: 500, amount: 9075000, date: '2024-11-05' },
  
  // From مدني (Madani):
  { supplier: 'مدني', item: 'منتجات', quantity: 31935000, amount: 31935000, date: '2024-10-29' },
];

async function main() {
  console.log('🌱 Starting seed for Paid and Delivered Procurement Orders...\n');

  // Find main warehouse
  console.log('📦 Finding Main Warehouse...');
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

  // Find procurement user
  console.log('\n👤 Finding procurement user...');
  const procurementUser = await prisma.user.findFirst({
    where: {
      role: 'PROCUREMENT',
    },
  });

  if (!procurementUser) {
    throw new Error('No procurement user found. Please create a procurement user first.');
  }
  console.log(`  ✅ Found procurement user: ${procurementUser.username}`);

  // Find accountant user for payment confirmation
  console.log('\n👤 Finding accountant user...');
  const accountantUser = await prisma.user.findFirst({
    where: {
      role: { in: ['ACCOUNTANT', 'MANAGER'] },
    },
  });

  if (!accountantUser) {
    throw new Error('No accountant/manager user found. Please create one first.');
  }
  console.log(`  ✅ Found accountant user: ${accountantUser.username}`);

  // Find or create suppliers
  console.log('\n🏭 Finding/Creating suppliers...');
  const suppliers: Record<string, any> = {};
  
  for (const supplierName of ['العهدة', 'بحري', 'مدني']) {
    let supplier = await prisma.supplier.findFirst({
      where: { name: supplierName },
    });

    if (!supplier) {
      supplier = await prisma.supplier.create({
        data: {
          name: supplierName,
          phone: null,
          address: null,
        },
      });
      console.log(`  ✨ Created supplier: ${supplierName}`);
    } else {
      console.log(`  ✅ Found supplier: ${supplierName}`);
    }
    suppliers[supplierName] = supplier;
  }

  // Find or create items (GROCERY section only)
  console.log('\n📦 Finding/Creating GROCERY items...');
  const items: Record<string, any> = {};
  
  const itemNames = ['منتجات', 'الأول', 'صافية', 'شعيرية', 'سمولينا'];
  
  for (const itemName of itemNames) {
    // Only search for items in GROCERY section
    let item = await prisma.item.findFirst({
      where: {
        name: itemName,
        section: Section.GROCERY, // Ensure it's a grocery item
      },
    });

    if (!item) {
      // Create item in GROCERY section with price = 1 for items without explicit unit cost
      // This allows quantity = amount when unit cost is 1
      item = await prisma.item.create({
        data: {
          name: itemName,
          section: Section.GROCERY, // Explicitly set as grocery item
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: 1 },
              { tier: CustomerType.RETAIL, price: 1 },
            ],
          },
        },
      });
      console.log(`  ✨ Created GROCERY item: ${itemName}`);
    } else {
      // Verify the item is in GROCERY section
      if (item.section !== Section.GROCERY) {
        console.log(`  ⚠️  Item ${itemName} exists but is in ${item.section} section, updating to GROCERY...`);
        item = await prisma.item.update({
          where: { id: item.id },
          data: { section: Section.GROCERY },
        });
        console.log(`  ✅ Updated item ${itemName} to GROCERY section`);
      } else {
        console.log(`  ✅ Found GROCERY item: ${itemName}`);
      }
    }
    items[itemName] = item;
  }

  let ordersCreated = 0;
  let skipped = 0;

  console.log('\n🛒 Processing orders...\n');

  for (const orderInfo of orderData) {
    try {
      const supplier = suppliers[orderInfo.supplier];
      const item = items[orderInfo.item];
      
      // Calculate unit cost
      // For items where quantity = amount, unit cost is 1
      // For items with explicit quantity, calculate unit cost
      const unitCost = orderInfo.quantity > 0 && orderInfo.quantity !== orderInfo.amount
        ? orderInfo.amount / orderInfo.quantity
        : 1;

      // Generate unique order number
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const orderNumber = `PRE-SYS-PO-${orderInfo.date.replace(/-/g, '')}-${randomSuffix}`;

      // Check if order already exists for this supplier/date/amount
      const existingOrder = await prisma.procOrder.findFirst({
        where: {
          supplierId: supplier.id,
          total: orderInfo.amount,
          createdAt: {
            gte: new Date(new Date(orderInfo.date).setHours(0, 0, 0, 0)),
            lte: new Date(new Date(orderInfo.date).setHours(23, 59, 59, 999)),
          },
        },
      });

      if (existingOrder) {
        console.log(`  ⏭️  Order already exists: ${orderNumber}, skipping...`);
        skipped++;
        continue;
      }

      // Parse date (format: YYYY-MM-DD)
      const orderDate = new Date(orderInfo.date);
      orderDate.setHours(12, 0, 0, 0); // Set to noon to avoid timezone issues

      // Create procurement order (unpaid)
      const order = await prisma.procOrder.create({
        data: {
          orderNumber,
          inventoryId: mainWarehouse.id,
          section: Section.GROCERY,
          createdBy: procurementUser.id,
          supplierId: supplier.id,
          status: ProcOrderStatus.RECEIVED, // Mark as received (delivered)
          total: new Prisma.Decimal(orderInfo.amount),
          paidAmount: new Prisma.Decimal(0), // Unpaid
          paymentConfirmed: false, // Payment not confirmed
          notes: `طلب شراء من ${orderInfo.supplier} بتاريخ ${orderInfo.date} - لا يؤثر على المخزون`,
          createdAt: orderDate, // Set creation date to match order date
          items: {
            create: {
              itemId: item.id,
              quantity: new Prisma.Decimal(orderInfo.quantity),
              unitCost: new Prisma.Decimal(unitCost),
              lineTotal: new Prisma.Decimal(orderInfo.amount),
            },
          },
        },
      });

      console.log(`  📄 Created order: ${orderNumber}`);
      console.log(`     Supplier: ${orderInfo.supplier}`);
      console.log(`     Item: ${orderInfo.item} (Qty: ${orderInfo.quantity}, Amount: ${orderInfo.amount.toLocaleString()} SDG)`);
      console.log(`     Date: ${orderInfo.date}`);
      console.log(`     Status: RECEIVED, Payment: UNPAID`);
      
      ordersCreated++;
    } catch (error: any) {
      console.error(`  ❌ Error processing order from ${orderInfo.supplier}:`, error.message);
      skipped++;
    }
  }

  const totalAmount = orderData.reduce((sum, o) => sum + o.amount, 0);

  console.log(`\n✅ Seed completed successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Section: البقالات (GROCERY)`);
  console.log(`   Total orders: ${orderData.length}`);
  console.log(`   Orders created: ${ordersCreated}`);
  console.log(`   Total order amount: ${totalAmount.toLocaleString()} SDG`);
  console.log(`   Skipped/Errors: ${skipped} orders`);
  console.log(`\n⚠️  Note: Orders are marked as RECEIVED but UNPAID`);
  console.log(`   NO InventoryReceipt records were created (ensures stock is NOT affected)`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

