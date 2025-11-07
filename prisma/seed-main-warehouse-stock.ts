import { PrismaClient, Section, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Main Warehouse Grocery Stock
 * Data from: مخزن رئيسي بقالات.xlsx
 * 
 * الصنف = Item Name
 * رصيد ختامي = Closing Stock
 * سعر الجملة = Wholesale Price
 * 
 * Run with: npx ts-node prisma/seed-main-warehouse-stock.ts
 */

// TODO: Replace this data with your actual Excel data
const groceryData = [
  // Format: { name: 'اسم الصنف', stock: رصيد_ختامي, wholesalePrice: سعر_الجملة }
  { name: 'سكر', stock: 500, wholesalePrice: 250 },
  { name: 'رز', stock: 300, wholesalePrice: 180 },
  { name: 'زيت', stock: 200, wholesalePrice: 450 },
  // Add more items from your Excel file here...
];

async function main() {
  console.log('🌱 Starting seed for Main Warehouse Grocery Stock...\n');

  // Find or create the main warehouse inventory
  console.log('📦 Finding Main Warehouse (المخزن الرئيسي)...');
  let mainWarehouse = await prisma.inventory.findFirst({
    where: { name: { contains: 'رئيسي' } }
  });

  if (!mainWarehouse) {
    console.log('Creating Main Warehouse...');
    mainWarehouse = await prisma.inventory.create({
      data: {
        name: 'المخزن الرئيسي',
        isMain: true,
      },
    });
  }
  console.log(`✅ Found/Created warehouse: ${mainWarehouse.name}\n`);

  // Process each item
  console.log('🛒 Processing grocery items...\n');
  
  for (const itemData of groceryData) {
    console.log(`Processing: ${itemData.name}`);
    
    // Find or create the item
    let item = await prisma.item.findFirst({
      where: {
        name: itemData.name,
        section: Section.GROCERY,
      },
      include: { prices: true },
    });

    if (!item) {
      console.log(`  Creating new item: ${itemData.name}`);
      
      // Create item with prices
      item = await prisma.item.create({
        data: {
          name: itemData.name,
          section: Section.GROCERY,
          prices: {
            create: [
              {
                tier: CustomerType.WHOLESALE,
                price: itemData.wholesalePrice,
              },
              {
                tier: CustomerType.RETAIL,
                price: itemData.wholesalePrice * 1.15, // 15% markup for retail
              },
              {
                tier: CustomerType.AGENT,
                price: itemData.wholesalePrice * 1.10, // 10% markup for agents
              },
            ],
          },
        },
        include: { prices: true },
      });
    } else {
      console.log(`  Item already exists, updating prices...`);
      
      // Update wholesale price
      const wholesalePrice = item.prices.find(p => p.tier === CustomerType.WHOLESALE);
      if (wholesalePrice) {
        await prisma.itemPrice.update({
          where: { id: wholesalePrice.id },
          data: { price: itemData.wholesalePrice },
        });
      } else {
        await prisma.itemPrice.create({
          data: {
            itemId: item.id,
            tier: CustomerType.WHOLESALE,
            price: itemData.wholesalePrice,
          },
        });
      }
    }

    // Update or create stock in main warehouse
    const existingStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: mainWarehouse.id,
          itemId: item.id,
        },
      },
    });

    if (existingStock) {
      console.log(`  Updating stock: ${existingStock.quantity} → ${itemData.stock}`);
      await prisma.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: mainWarehouse.id,
            itemId: item.id,
          },
        },
        data: { quantity: itemData.stock },
      });
    } else {
      console.log(`  Creating stock entry: ${itemData.stock}`);
      await prisma.inventoryStock.create({
        data: {
          inventoryId: mainWarehouse.id,
          itemId: item.id,
          quantity: itemData.stock,
        },
      });
    }

    console.log(`  ✅ ${itemData.name}: Stock=${itemData.stock}, Wholesale=${itemData.wholesalePrice} SDG\n`);
  }

  console.log(`\n✅ Successfully processed ${groceryData.length} items!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Warehouse: ${mainWarehouse.name}`);
  console.log(`   Section: البقالات (GROCERY)`);
  console.log(`   Items: ${groceryData.length}`);
  console.log(`   Total Stock: ${groceryData.reduce((sum, item) => sum + item.stock, 0)}`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

