import { PrismaClient, Role, Section, CustomerType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Production Seed Script with Real Data from November 2025 Sales Report
 * Run with: npx ts-node prisma/seed-production.ts
 */
async function main() {
  console.log('🌱 Starting production seed with real data...');

  // WARNING: This will clear all existing data!
  console.log('⚠️  WARNING: This will DELETE all existing data!');
  console.log('Press Ctrl+C within 5 seconds to cancel...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Clear existing data
  console.log('🗑️  Clearing existing data...');
  await prisma.$transaction([
    prisma.salesPayment.deleteMany(),
    prisma.salesInvoiceItem.deleteMany(),
    prisma.inventoryDeliveryBatch.deleteMany(),
    prisma.inventoryDeliveryItem.deleteMany(),
    prisma.inventoryDelivery.deleteMany(),
    prisma.salesInvoice.deleteMany(),
    prisma.procOrderPayment.deleteMany(),
    prisma.procOrderReturn.deleteMany(),
    prisma.procOrderItem.deleteMany(),
    prisma.inventoryReceipt.deleteMany(),
    prisma.procOrder.deleteMany(),
    prisma.stockBatch.deleteMany(),
    prisma.inventoryStock.deleteMany(),
    prisma.itemPrice.deleteMany(),
    prisma.item.deleteMany(),
    prisma.supplier.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.userInventoryAccess.deleteMany(),
    prisma.openingBalance.deleteMany(),
    prisma.user.deleteMany(),
    prisma.inventory.deleteMany(),
  ]);

  const hashedPassword = await bcrypt.hash('admin123', 10);

  // Create Inventories
  console.log('📦 Creating inventories...');
  const mainInventory = await prisma.inventory.create({
    data: { name: 'المخزن الرئيسي', isMain: true },
  });

  const branchInventories = await Promise.all([
    prisma.inventory.create({ data: { name: 'الفرعي', isMain: false } }),
    prisma.inventory.create({ data: { name: 'القرشي', isMain: false } }),
    prisma.inventory.create({ data: { name: 'الهدى', isMain: false } }),
    prisma.inventory.create({ data: { name: 'عبود', isMain: false } }),
  ]);

  const allInventories = [mainInventory, ...branchInventories];
  console.log(`✅ Created ${allInventories.length} inventories`);

  // Create Users
  console.log('👥 Creating users...');
  const manager = await prisma.user.create({
    data: {
      username: 'manager',
      passwordHash: hashedPassword,
      role: Role.MANAGER,
    },
  });

  const accountant = await prisma.user.create({
    data: {
      username: 'accountant',
      passwordHash: hashedPassword,
      role: Role.ACCOUNTANT,
    },
  });

  const salesGrocery = await prisma.user.create({
    data: {
      username: 'sales_grocery',
      passwordHash: hashedPassword,
      role: Role.SALES_GROCERY,
      accesses: {
        create: allInventories.map(inv => ({
          inventoryId: inv.id,
          section: Section.GROCERY,
        })),
      },
    },
  });

  const inventory = await prisma.user.create({
    data: {
      username: 'inventory',
      passwordHash: hashedPassword,
      role: Role.INVENTORY,
      accesses: {
        create: allInventories.map(inv => ({
          inventoryId: inv.id,
          section: Section.GROCERY,
        })),
      },
    },
  });

  const procurement = await prisma.user.create({
    data: {
      username: 'procurement',
      passwordHash: hashedPassword,
      role: Role.PROCUREMENT,
      accesses: {
        create: allInventories.map(inv => ({
          inventoryId: inv.id,
          section: Section.GROCERY,
        })),
      },
    },
  });

  console.log('✅ Created 5 users');

  // Create Real Items from November 2025 Sales Data
  console.log('🛒 Creating real products from sales data...');

  const itemsData = [
    // Flour Products
    { name: 'دقيق الاول 50 كجم', retailPrice: 21000, wholesalePrice: 20000, agentPrice: 20500 },
    { name: 'دقيق مخصوص 50 كجم', retailPrice: 23500, wholesalePrice: 22500, agentPrice: 23000 },
    { name: 'دقيق سمولينا 25 كجم', retailPrice: 32500, wholesalePrice: 31000, agentPrice: 31750 },
    { name: 'دقيق زادنا 50 كجم', retailPrice: 24500, wholesalePrice: 23500, agentPrice: 24000 },
    { name: 'دقيق اصلي 10 كجم', retailPrice: 21000, wholesalePrice: 20000, agentPrice: 20500 },
    
    // Pasta & Noodles
    { name: 'معكرونة نوبو 300 جم', retailPrice: 33500, wholesalePrice: 32000, agentPrice: 32750 },
    { name: 'شعيرية نوبو 300 جم', retailPrice: 33500, wholesalePrice: 32000, agentPrice: 32750 },
    { name: 'سكسكانية نوبو 300 جم', retailPrice: 33500, wholesalePrice: 32000, agentPrice: 32750 },
    { name: 'شعيرية نوبو 500 جم', retailPrice: 30000, wholesalePrice: 28500, agentPrice: 29250 },
    { name: 'معكرونة نوبو 500 جم', retailPrice: 33000, wholesalePrice: 31500, agentPrice: 32250 },
    
    // Cooking Oil
    { name: 'زيت زادنا 900 مل', retailPrice: 88500, wholesalePrice: 86000, agentPrice: 87000 },
    { name: 'زيت زادنا 1.5 لتر', retailPrice: 145000, wholesalePrice: 140000, agentPrice: 142500 },
    { name: 'زيت زادنا 18 لتر', retailPrice: 1600000, wholesalePrice: 1550000, agentPrice: 1575000 },
    
    // Coffee (Cabo Brand)
    { name: 'قهوة كابو 40 جم', retailPrice: 71500, wholesalePrice: 69000, agentPrice: 70000 },
    { name: 'قهوة كابو 200 جم × 12', retailPrice: 69500, wholesalePrice: 67000, agentPrice: 68000 },
    { name: 'قهوة كابو 1 كجم', retailPrice: 160500, wholesalePrice: 155000, agentPrice: 157500 },
    { name: 'قهوة كابو 2.25 كجم', retailPrice: 175500, wholesalePrice: 170000, agentPrice: 172500 },
    
    // Lentils
    { name: 'عدس 200 جم', retailPrice: 41000, wholesalePrice: 39000, agentPrice: 40000 },
    { name: 'عدس 1 كجم', retailPrice: 48500, wholesalePrice: 46000, agentPrice: 47000 },
    { name: 'عدس 5 كجم', retailPrice: 230000, wholesalePrice: 220000, agentPrice: 225000 },
    
    // Other Grocery Items
    { name: 'خميرة فورية 11 جم', retailPrice: 17000, wholesalePrice: 16000, agentPrice: 16500 },
    { name: 'سكر أبيض 5 كجم', retailPrice: 160000, wholesalePrice: 155000, agentPrice: 157500 },
    
    // Water (Safia Brand)
    { name: 'مياه صافية 330 مل', retailPrice: 14500, wholesalePrice: 13500, agentPrice: 14000 },
    { name: 'مياه صافية 500 مل', retailPrice: 8750, wholesalePrice: 8250, agentPrice: 8500 },
    { name: 'مياه صافية 600 مل', retailPrice: 8750, wholesalePrice: 8250, agentPrice: 8500 },
    { name: 'مياه صافية 1.5 لتر', retailPrice: 9750, wholesalePrice: 9250, agentPrice: 9500 },
    { name: 'مياه صافية 5 لتر', retailPrice: 7000, wholesalePrice: 6500, agentPrice: 6750 },
    { name: 'مياه صافية 10 لتر', retailPrice: 12000, wholesalePrice: 11000, agentPrice: 11500 },
    
    // Soft Drinks
    { name: 'كوكاكولا 300 مل', retailPrice: 18500, wholesalePrice: 17000, agentPrice: 17750 },
    { name: 'كوكاكولا 1.5 لتر', retailPrice: 35500, wholesalePrice: 33000, agentPrice: 34000 },
    { name: 'سبرايت 300 مل', retailPrice: 18500, wholesalePrice: 17000, agentPrice: 17750 },
    { name: 'سبرايت 1.5 لتر', retailPrice: 35500, wholesalePrice: 33000, agentPrice: 34000 },
    { name: 'فانتا برتقال 300 مل', retailPrice: 18500, wholesalePrice: 17000, agentPrice: 17750 },
    { name: 'فانتا برتقال 1.5 لتر', retailPrice: 35500, wholesalePrice: 33000, agentPrice: 34000 },
    
    // Instant Noodles
    { name: 'نودلز خضار', retailPrice: 19000, wholesalePrice: 18000, agentPrice: 18500 },
    { name: 'نودلز فراخ', retailPrice: 19000, wholesalePrice: 18000, agentPrice: 18500 },
    
    // Baking Supplies
    { name: 'بيكر دريم (خليط كيك)', retailPrice: 117500, wholesalePrice: 112000, agentPrice: 114500 },
    { name: 'فواريس (بيكنج بودر)', retailPrice: 113000, wholesalePrice: 108000, agentPrice: 110500 },
    
    // Additional Common Items
    { name: 'سكر 1 كجم', retailPrice: 33000, wholesalePrice: 31500, agentPrice: 32250 },
    { name: 'ملح 1 كجم', retailPrice: 12000, wholesalePrice: 11000, agentPrice: 11500 },
    { name: 'أرز بسمتي 5 كجم', retailPrice: 190000, wholesalePrice: 185000, agentPrice: 187500 },
  ];

  const createdItems = [];
  for (const itemData of itemsData) {
    const item = await prisma.item.create({
      data: {
        name: itemData.name,
        section: Section.GROCERY,
        prices: {
          create: [
            { tier: CustomerType.WHOLESALE, price: itemData.wholesalePrice },
            { tier: CustomerType.RETAIL, price: itemData.retailPrice },
            { tier: CustomerType.AGENT, price: itemData.agentPrice },
          ],
        },
      },
      include: { prices: true },
    });

    // Create stock entries for all inventories
    for (const inv of allInventories) {
      await prisma.inventoryStock.create({
        data: {
          inventoryId: inv.id,
          itemId: item.id,
          quantity: 0, // Start with 0, will be updated when receiving procurement orders
        },
      });
    }

    createdItems.push(item);
  }

  console.log(`✅ Created ${createdItems.length} products with real prices`);

  // Create Suppliers
  console.log('🏭 Creating suppliers...');
  const suppliers = await Promise.all([
    prisma.supplier.create({
      data: {
        name: 'شركة الخرطوم للمواد الغذائية',
        phone: '0123456789',
        address: 'الخرطوم',
      },
    }),
    prisma.supplier.create({
      data: {
        name: 'مطاحن النيل',
        phone: '0123456790',
        address: 'أم درمان',
      },
    }),
    prisma.supplier.create({
      data: {
        name: 'شركة زادنا للزيوت',
        phone: '0123456791',
        address: 'الخرطوم بحري',
      },
    }),
    prisma.supplier.create({
      data: {
        name: 'وكيل كوكاكولا - السودان',
        phone: '0123456792',
        address: 'الخرطوم',
      },
    }),
    prisma.supplier.create({
      data: {
        name: 'شركة نوبو للمعكرونات',
        phone: '0123456793',
        address: 'الخرطوم',
      },
    }),
  ]);

  console.log(`✅ Created ${suppliers.length} suppliers`);

  // Create Customers
  console.log('🤝 Creating customers...');
  const customers = await Promise.all([
    // Wholesale Customers
    prisma.customer.create({
      data: {
        name: 'سوبر ماركت الصفاء',
        type: CustomerType.WHOLESALE,
        division: Section.GROCERY,
        phone: '0111111111',
        address: 'حي العمارات',
        isAgentCustomer: false,
      },
    }),
    prisma.customer.create({
      data: {
        name: 'بقالة النور',
        type: CustomerType.WHOLESALE,
        division: Section.GROCERY,
        phone: '0111111112',
        address: 'حي الرياض',
        isAgentCustomer: false,
      },
    }),
    prisma.customer.create({
      data: {
        name: 'متجر البركة',
        type: CustomerType.WHOLESALE,
        division: Section.GROCERY,
        phone: '0111111113',
        address: 'السوق الشعبي',
        isAgentCustomer: false,
      },
    }),
    prisma.customer.create({
      data: {
        name: 'سوبر ماركت الهدى',
        type: CustomerType.WHOLESALE,
        division: Section.GROCERY,
        phone: '0111111114',
        address: 'حي الديوم',
        isAgentCustomer: false,
      },
    }),
    
    // Retail Customers
    prisma.customer.create({
      data: {
        name: 'أحمد محمد علي',
        type: CustomerType.RETAIL,
        division: Section.GROCERY,
        phone: '0222222221',
        isAgentCustomer: false,
      },
    }),
    prisma.customer.create({
      data: {
        name: 'فاطمة عبدالله',
        type: CustomerType.RETAIL,
        division: Section.GROCERY,
        phone: '0222222222',
        isAgentCustomer: false,
      },
    }),
    prisma.customer.create({
      data: {
        name: 'مطعم الخرطوم',
        type: CustomerType.RETAIL,
        division: Section.GROCERY,
        phone: '0222222223',
        address: 'شارع النيل',
        isAgentCustomer: false,
      },
    }),
  ]);

  console.log(`✅ Created ${customers.length} customers`);

  // Create Opening Balance
  console.log('💰 Creating opening balance...');
  await prisma.openingBalance.create({
    data: {
      scope: 'CASHBOX',
      amount: 1000000, // 1 million SDG starting balance
      paymentMethod: 'CASH',
      notes: 'رأس المال الافتتاحي - نوفمبر 2025',
      isClosed: false,
    },
  });

  await prisma.openingBalance.create({
    data: {
      scope: 'CASHBOX',
      amount: 500000, // 500k SDG in bank
      paymentMethod: 'BANK',
      notes: 'رصيد افتتاحي - حساب بنكك',
      isClosed: false,
    },
  });

  console.log('✅ Created opening balances');

  console.log('\n🎉 Production seed completed successfully!');
  console.log('\n📝 Login Credentials:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Manager:     username: manager        | password: admin123');
  console.log('Accountant:  username: accountant     | password: admin123');
  console.log('Sales:       username: sales_grocery  | password: admin123');
  console.log('Inventory:   username: inventory      | password: admin123');
  console.log('Procurement: username: procurement    | password: admin123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  console.log('📊 Summary:');
  console.log(`- ${allInventories.length} Inventories`);
  console.log(`- ${createdItems.length} Products with real prices`);
  console.log(`- ${suppliers.length} Suppliers`);
  console.log(`- ${customers.length} Customers`);
  console.log(`- Opening Balance: ${formatSDG(1500000)}`);
  console.log('\n✨ System is ready for production use!');
}

function formatSDG(amount: number): string {
  return `${amount.toLocaleString()} SDG`;
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

