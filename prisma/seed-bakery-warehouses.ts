import { PrismaClient, Section, CustomerType, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed script for Bakery (الافران) Stock across 5 warehouses
 * 
 * Warehouses in order:
 * 1. الرئيسي (Main)
 * 2. الفرعي (Sub)
 * 3. القرشي (Al-Qurashi)
 * 4. عبود (Aboud)
 * 5. معتوق (Maatouq)
 */

// ============================================
// WAREHOUSE DATA (from images):
// ============================================

// Warehouse 1: الرئيسي (Main)
const mainWarehouseData = [
  { name: 'البلدي', stock: 1022, wholesalePrice: 56500 },
  { name: 'الالي', stock: 604, wholesalePrice: 58000 },
  { name: 'الوافر', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة بيضاء', stock: 235, wholesalePrice: 125000 }, // Note: "مايروبان" normalized to "بيضاء"
  { name: 'خميرة فكتوريا', stock: 741, wholesalePrice: 120000 },
  { name: 'خميرة دريم', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة فواريس', stock: 12, wholesalePrice: 113000 },
  { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 116000 },
  { name: 'الأصلي', stock: 1759, wholesalePrice: 52200 },
  { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
];

// Warehouse 2: الفرعي (Sub)
const subWarehouseData = [
  { name: 'البلدي', stock: 0, wholesalePrice: 56500 },
  { name: 'الالي', stock: 1, wholesalePrice: 58000 },
  { name: 'الوافر', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة بيضاء', stock: 48, wholesalePrice: 125000 },
  { name: 'خميرة فكتوريا', stock: 40, wholesalePrice: 120000 },
  { name: 'خميرة دريم', stock: 0, wholesalePrice: 113000 },
  { name: 'خميرة فواريس', stock: 3, wholesalePrice: 113000 },
  { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 116000 },
  { name: 'الأصلي', stock: 34, wholesalePrice: 50000 },
  { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
];

// Warehouse 3: القرشي (Al-Qurashi)
const qurashiWarehouseData = [
  { name: 'البلدي', stock: 0, wholesalePrice: 57100 },
  { name: 'الالي', stock: 384, wholesalePrice: 58600 }, // Note: "الالى" normalized to "الالي"
  { name: 'الوافر', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة بيضاء', stock: 9, wholesalePrice: 126000 },
  { name: 'خميرة فكتوريا', stock: 38, wholesalePrice: 121000 },
  { name: 'خميرة دريم', stock: 0, wholesalePrice: 114000 },
  { name: 'خميرة فواريس', stock: 25, wholesalePrice: 114000 },
  { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 117000 },
  { name: 'الأصلي', stock: 716, wholesalePrice: 52800 },
  { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
];

// Warehouse 4: عبود (Aboud)
const aboudWarehouseData = [
  { name: 'الالي', stock: 50, wholesalePrice: 58000 },
  { name: 'الوافر', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة بيضاء', stock: 4, wholesalePrice: 125000 },
  { name: 'خميرة فكتوريا', stock: 5, wholesalePrice: 120000 },
  { name: 'خميرة دريم', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة فواريس', stock: 10, wholesalePrice: 113000 },
  { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 116000 },
  { name: 'الأصلي', stock: 65, wholesalePrice: 52200 }, // Note: "الأصلى" normalized to "الأصلي"
  { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
];

// Warehouse 5: معتوق (Maatouq)
const maatouqWarehouseData = [
  { name: 'الالي', stock: 177, wholesalePrice: 58600 },
  { name: 'الوافر', stock: 0, wholesalePrice: 0 },
  { name: 'خميرة بيضاء', stock: 0, wholesalePrice: 126000 },
  { name: 'خميرة فكتوريا', stock: 67, wholesalePrice: 121000 },
  { name: 'خميرة دريم', stock: 0, wholesalePrice: 114000 },
  { name: 'خميرة فواريس', stock: 0, wholesalePrice: 114000 },
  { name: 'خميرة بيكر دريم', stock: 0, wholesalePrice: 117000 },
  { name: 'الأصلي', stock: 679, wholesalePrice: 52800 },
  { name: 'سمولينا 10 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني باسطة 25 ك', stock: 0, wholesalePrice: 0 },
  { name: 'حلواني كيك', stock: 0, wholesalePrice: 0 },
];

// Warehouse configurations
const warehouses = [
  {
    name: 'المخزن الرئيسي',
    searchTerms: ['رئيسي', 'المخزن الرئيسي'],
    data: mainWarehouseData,
  },
  {
    name: 'المخزن الفرعي',
    searchTerms: ['فرعي', 'المخزن الفرعي'],
    data: subWarehouseData,
  },
  {
    name: 'القرشي',
    searchTerms: ['قرشي', 'القرشي'],
    data: qurashiWarehouseData,
  },
  {
    name: 'عبود',
    searchTerms: ['عبود'],
    data: aboudWarehouseData,
  },
  {
    name: 'معتوق',
    searchTerms: ['معتوق'],
    data: maatouqWarehouseData,
  },
];

async function processWarehouse(warehouseConfig: typeof warehouses[0]) {
  console.log(`\n📦 Processing: ${warehouseConfig.name}...`);

  // Find or create warehouse
  let warehouse = await prisma.inventory.findFirst({
    where: {
      OR: warehouseConfig.searchTerms.map(term => ({
        name: { contains: term },
      })),
    },
  });

  if (!warehouse) {
    console.log(`  ✨ Creating warehouse: ${warehouseConfig.name}`);
    warehouse = await prisma.inventory.create({
      data: {
        name: warehouseConfig.name,
        isMain: false,
      },
    });
  } else {
    console.log(`  ✅ Found warehouse: ${warehouse.name}`);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // Process each item
  for (const itemData of warehouseConfig.data) {
    // Skip items with zero stock and zero price
    if (itemData.stock === 0 && itemData.wholesalePrice === 0) {
      skipped++;
      continue;
    }

    console.log(`  Processing: ${itemData.name}`);

    // Find or create the item
    let item = await prisma.item.findFirst({
      where: {
        name: itemData.name,
        section: Section.BAKERY,
      },
      include: { prices: true },
    });

    if (!item) {
      console.log(`    ✨ Creating new item`);
      
      // Calculate retail and agent prices (15% and 10% markup)
      const retailPrice = Math.round(itemData.wholesalePrice * 1.15);
      const agentPrice = Math.round(itemData.wholesalePrice * 1.10);

      item = await prisma.item.create({
        data: {
          name: itemData.name,
          section: Section.BAKERY,
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: itemData.wholesalePrice },
              { tier: CustomerType.RETAIL, price: retailPrice },
              { tier: CustomerType.AGENT, price: agentPrice },
            ],
          },
        },
        include: { prices: true },
      });
      created++;
    } else {
      console.log(`    ♻️  Item exists, updating prices`);
      
      // Update wholesale price if provided
      if (itemData.wholesalePrice > 0) {
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

        // Update retail price
        const retailPrice = Math.round(itemData.wholesalePrice * 1.15);
        const existingRetailPrice = item.prices.find(p => p.tier === CustomerType.RETAIL);
        if (existingRetailPrice) {
          await prisma.itemPrice.update({
            where: { id: existingRetailPrice.id },
            data: { price: retailPrice },
          });
        }

        // Update agent price
        const agentPrice = Math.round(itemData.wholesalePrice * 1.10);
        const existingAgentPrice = item.prices.find(p => p.tier === CustomerType.AGENT);
        if (existingAgentPrice) {
          await prisma.itemPrice.update({
            where: { id: existingAgentPrice.id },
            data: { price: agentPrice },
          });
        }
      }
      
      updated++;
    }

    // Update or create stock
    const existingStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: warehouse.id,
          itemId: item.id,
        },
      },
    });

    if (existingStock) {
      console.log(`    📊 Updating stock: ${existingStock.quantity} → ${itemData.stock}`);
      await prisma.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: warehouse.id,
            itemId: item.id,
          },
        },
        data: { quantity: itemData.stock },
      });
    } else {
      console.log(`    📊 Creating stock: ${itemData.stock}`);
      await prisma.inventoryStock.create({
        data: {
          inventoryId: warehouse.id,
          itemId: item.id,
          quantity: itemData.stock,
        },
      });
    }

    console.log(`    ✅ Stock=${itemData.stock}, Price=${itemData.wholesalePrice.toLocaleString()} SDG`);
  }

  const totalStock = warehouseConfig.data.reduce((sum, item) => sum + (item.stock > 0 ? item.stock : 0), 0);
  const totalValue = warehouseConfig.data.reduce((sum, item) => sum + (item.stock * item.wholesalePrice), 0);

  console.log(`\n  📊 Summary for ${warehouseConfig.name}:`);
  console.log(`     Created: ${created} items`);
  console.log(`     Updated: ${updated} items`);
  console.log(`     Skipped: ${skipped} items (no stock/price)`);
  console.log(`     Total Stock Units: ${totalStock.toLocaleString()}`);
  console.log(`     Total Value: ${totalValue.toLocaleString()} SDG`);

  return { created, updated, skipped, totalStock, totalValue };
}

async function main() {
  console.log('🌱 Starting seed for Bakery (الافران) Stock across 5 warehouses...\n');
  console.log('📋 Processing warehouses in order:');
  console.log('   1. الرئيسي (Main)');
  console.log('   2. الفرعي (Sub)');
  console.log('   3. القرشي (Al-Qurashi)');
  console.log('   4. عبود (Aboud)');
  console.log('   5. معتوق (Maatouq)\n');

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let grandTotalStock = 0;
  let grandTotalValue = 0;

  for (const warehouseConfig of warehouses) {
    const result = await processWarehouse(warehouseConfig);
    totalCreated += result.created;
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    grandTotalStock += result.totalStock;
    grandTotalValue += result.totalValue;
  }

  console.log(`\n\n✅ Seed completed successfully!`);
  console.log(`\n📊 Overall Summary:`);
  console.log(`   Section: الافران (BAKERY)`);
  console.log(`   Warehouses processed: ${warehouses.length}`);
  console.log(`   Total items created: ${totalCreated}`);
  console.log(`   Total items updated: ${totalUpdated}`);
  console.log(`   Total items skipped: ${totalSkipped}`);
  console.log(`   Grand Total Stock Units: ${grandTotalStock.toLocaleString()}`);
  console.log(`   Grand Total Value: ${grandTotalValue.toLocaleString()} SDG`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

