import { PrismaClient, Section, PaymentMethod, Prisma, ProcOrderStatus, Role, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Paid and Delivered Bakery Procurement Orders
 * 
 * Creates procurement orders from suppliers (بحري, الضو العوض)
 * All orders are marked as:
 * - Status: RECEIVED (delivered)
 * - Payment: Full payment with paymentConfirmed = true
 * - Section: BAKERY (الافران)
 * - Note: NO InventoryReceipt records created to avoid stock impact
 */

// ============================================
// ORDER DATA (from image):
// ============================================
const orderData = [
  // From بحري (Bahri):
  { supplier: 'بحري', item: 'الأصلي', quantity: 1200, amount: 63480000, date: '2024-10-12' },
  { supplier: 'بحري', item: 'الالي', quantity: 2000, amount: 117400000, date: '2024-10-18' },
  { supplier: 'بحري', item: 'الأصلي', quantity: 3000, amount: 158700000, date: '2024-10-18' },
  { supplier: 'بحري', item: 'البلدي', quantity: 2400, amount: 138600000, date: '2024-10-21' },
  { supplier: 'بحري', item: 'فواريس', quantity: 100, amount: 11200000, date: '2024-10-21' },
  { supplier: 'بحري', item: 'الالي', quantity: 305, amount: 17903500, date: '2024-10-27' },
  { supplier: 'بحري', item: 'الأصلي', quantity: 200, amount: 10580000, date: '2024-10-27' },
  { supplier: 'بحري', item: 'الالي', quantity: 1000, amount: 58700000, date: '2024-10-28' },
  { supplier: 'بحري', item: 'البلدي', quantity: 1116, amount: 64449000, date: '2024-10-29' },
  { supplier: 'بحري', item: 'الالي', quantity: 2340, amount: 137358000, date: '2024-11-01' },
  { supplier: 'بحري', item: 'الالي', quantity: 1200, amount: 70440000, date: '2024-11-04' },
  { supplier: 'بحري', item: 'البلدي', quantity: 1200, amount: 69300000, date: '2024-11-04' },
  { supplier: 'بحري', item: 'البلدي', quantity: 1200, amount: 69300000, date: '2024-11-06' },
  
  // From الضو العوض (Al-Dhaw Al-Awad):
  { supplier: 'الضو العوض', item: 'منتجات', quantity: 10000000, amount: 10000000, date: '2024-10-15' }, // Generic item for general payment
];

async function main() {
  console.log('🌱 Starting seed for Paid and Delivered Bakery Procurement Orders...\n');

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
  
  for (const supplierName of ['بحري', 'الضو العوض']) {
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

  // Find or create items (BAKERY section only)
  console.log('\n📦 Finding/Creating BAKERY items...');
  const items: Record<string, any> = {};
  
  const itemNames = ['الأصلي', 'الالي', 'البلدي', 'فواريس', 'منتجات'];
  
  for (const itemName of itemNames) {
    // Only search for items in BAKERY section
    let item = await prisma.item.findFirst({
      where: {
        name: itemName,
        section: Section.BAKERY, // Ensure it's a bakery item
      },
    });

    if (!item) {
      // Create item in BAKERY section with price = 1 for items without explicit unit cost
      // This allows quantity = amount when unit cost is 1
      item = await prisma.item.create({
        data: {
          name: itemName,
          section: Section.BAKERY, // Explicitly set as bakery item
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: 1 },
              { tier: CustomerType.RETAIL, price: 1 },
            ],
          },
        },
      });
      console.log(`  ✨ Created BAKERY item: ${itemName}`);
    } else {
      // Verify the item is in BAKERY section
      if (item.section !== Section.BAKERY) {
        console.log(`  ⚠️  Item ${itemName} exists but is in ${item.section} section, updating to BAKERY...`);
        item = await prisma.item.update({
          where: { id: item.id },
          data: { section: Section.BAKERY },
        });
        console.log(`  ✅ Updated item ${itemName} to BAKERY section`);
      } else {
        console.log(`  ✅ Found BAKERY item: ${itemName}`);
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

      // Parse date (format: YYYY-MM-DD)
      const orderDate = new Date(orderInfo.date);
      orderDate.setHours(12, 0, 0, 0); // Set to noon to avoid timezone issues

      // Generate unique order number
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const orderNumber = `PRE-SYS-BAKERY-PO-${orderInfo.date.replace(/-/g, '')}-${randomSuffix}`;

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
        console.log(`  ⏭️  Order already exists for ${orderInfo.supplier} on ${orderInfo.date}, skipping...`);
        skipped++;
        continue;
      }

      // Create procurement order (unpaid)
      const order = await prisma.procOrder.create({
        data: {
          orderNumber,
          inventoryId: mainWarehouse.id,
          section: Section.BAKERY, // Bakery section
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
  console.log(`   Section: الافران (BAKERY)`);
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

