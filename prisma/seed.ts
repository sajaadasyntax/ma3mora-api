import { PrismaClient, Role, Section, CustomerType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  // Create inventories
  console.log('Creating inventories...');
  const mainInventory = await prisma.inventory.upsert({
    where: { name: 'المخزن الرئيسي' },
    update: {},
    create: { name: 'المخزن الرئيسي', isMain: true },
  });

  const branches = ['الفرعي', 'القرشي', 'الهدى', 'عبود'];
  const branchInventories = await Promise.all(
    branches.map((name) =>
      prisma.inventory.upsert({
        where: { name },
        update: {},
        create: { name, isMain: false },
      })
    )
  );

  console.log(`✅ Created ${1 + branches.length} inventories`);

  // Create users
  console.log('Creating users...');
  const hashedPassword = await bcrypt.hash('password123', 10);

  const accountant = await prisma.user.upsert({
    where: { username: 'accountant' },
    update: {},
    create: {
      username: 'accountant',
      passwordHash: hashedPassword,
      role: Role.ACCOUNTANT,
    },
  });

  const salesGrocery = await prisma.user.upsert({
    where: { username: 'sales_grocery' },
    update: {},
    create: {
      username: 'sales_grocery',
      passwordHash: hashedPassword,
      role: Role.SALES_GROCERY,
      accesses: {
        create: [
          { inventoryId: mainInventory.id, section: Section.GROCERY },
          ...branchInventories.map(inv => ({ inventoryId: inv.id, section: Section.GROCERY })),
        ],
      },
    },
  });

  const salesBakery = await prisma.user.upsert({
    where: { username: 'sales_bakery' },
    update: {},
    create: {
      username: 'sales_bakery',
      passwordHash: hashedPassword,
      role: Role.SALES_BAKERY,
      accesses: {
        create: [
          { inventoryId: mainInventory.id, section: Section.BAKERY },
          ...branchInventories.map(inv => ({ inventoryId: inv.id, section: Section.BAKERY })),
        ],
      },
    },
  });

  const inventoryUser = await prisma.user.upsert({
    where: { username: 'inventory' },
    update: {},
    create: {
      username: 'inventory',
      passwordHash: hashedPassword,
      role: Role.INVENTORY,
    },
  });

  const procurementUser = await prisma.user.upsert({
    where: { username: 'procurement' },
    update: {},
    create: {
      username: 'procurement',
      passwordHash: hashedPassword,
      role: Role.PROCUREMENT,
    },
  });

  const auditor = await prisma.user.upsert({
    where: { username: 'auditor' },
    update: {},
    create: {
      username: 'auditor',
      passwordHash: hashedPassword,
      role: Role.AUDITOR,
    },
  });

  console.log('✅ Created 6 users');

  // Create sample items for Grocery section
  console.log('Creating sample items...');
  const groceryItems = [
    'سكر',
    'رز',
    'زيت',
    'طحين',
    'معكرونة',
    'شاي',
    'قهوة',
    'ملح',
  ];

  const bakeryItems = [
    'خبز طازج',
    'كعك',
    'معجنات',
    'بسكويت',
    'كرواسون',
  ];

  const createdGroceryItems = await Promise.all(
    groceryItems.map((name) =>
      prisma.item.create({
        data: {
          name,
          section: Section.GROCERY,
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: Math.random() * 20 + 10 },
              { tier: CustomerType.RETAIL, price: Math.random() * 30 + 15 },
            ],
          },
        },
      })
    )
  );

  const createdBakeryItems = await Promise.all(
    bakeryItems.map((name) =>
      prisma.item.create({
        data: {
          name,
          section: Section.BAKERY,
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: Math.random() * 10 + 5 },
              { tier: CustomerType.RETAIL, price: Math.random() * 15 + 8 },
            ],
          },
        },
      })
    )
  );

  console.log(`✅ Created ${groceryItems.length + bakeryItems.length} items with prices`);

  // Create initial stock for items
  console.log('Creating initial stock...');
  const allInventories = [mainInventory, ...branchInventories];
  const allItems = [...createdGroceryItems, ...createdBakeryItems];

  for (const inventory of allInventories) {
    for (const item of allItems) {
      await prisma.inventoryStock.create({
        data: {
          inventoryId: inventory.id,
          itemId: item.id,
          quantity: Math.floor(Math.random() * 500) + 100,
        },
      });
    }
  }

  console.log('✅ Created initial stock');

  // Create sample customers
  console.log('Creating sample customers...');
  const customers = [
    { name: 'محل الأمانة', type: CustomerType.WHOLESALE, division: Section.GROCERY },
    { name: 'سوبر ماركت النور', type: CustomerType.RETAIL, division: Section.GROCERY },
    { name: 'مخبز الفرح', type: CustomerType.WHOLESALE, division: Section.BAKERY },
    { name: 'مطعم البركة', type: CustomerType.RETAIL, division: Section.BAKERY },
  ];

  await Promise.all(
    customers.map((customer) =>
      prisma.customer.create({
        data: customer,
      })
    )
  );

  console.log('✅ Created 4 sample customers');

  // Create sample suppliers
  console.log('Creating sample suppliers...');
  const suppliers = [
    { name: 'مورد الأرز الذهبي', phone: '+964770123456' },
    { name: 'شركة الدقيق الممتاز', phone: '+964771234567' },
  ];

  await Promise.all(
    suppliers.map((supplier) =>
      prisma.supplier.create({
        data: supplier,
      })
    )
  );

  console.log('✅ Created 2 sample suppliers');

  console.log('🎉 Seed completed successfully!');
  console.log('\n📝 Login credentials:');
  console.log('  Accountant: accountant / password123');
  console.log('  Sales (Grocery): sales_grocery / password123');
  console.log('  Sales (Bakery): sales_bakery / password123');
  console.log('  Inventory: inventory / password123');
  console.log('  Procurement: procurement / password123');
  console.log('  Auditor: auditor / password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

