import { PrismaClient, Section, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Simple seed script for Sub-Warehouse - Just paste your Excel data here!
 * 
 * Copy from Excel (columns: الصنف, رصيد ختامي, سعر الجملة)
 * and paste below in the format:
 * 
 * 'Item Name', stock, price
 * 
 * Example:
 * 'حلواني باسطة', 0, 60000
 * 'دقيق صبايا', 1405, 50000
 * 
 * NOTE: '#####' values will be replaced with 0.
 */

// ============================================
// PASTE YOUR EXCEL DATA HERE (between the quotes):
// ============================================
const pastedData = `
حلواني باسطة	0	 60,700 	
سيقا الاصلي 	36	 50,000 	
الاول	52	 21,200 	
مخصوص	0	 23,700 	
سمولينا	35	 32,700 	
الاصلي 10 ك	18	 21,200 	
زادنا 10 ك	1	 24,700 	
معكرونة نوبو 300 جم * 30	30	 33,700 	
شعيرية نوبو 300 جم * 30	24	 33,700 	
سكسكانية	7	 33,700 	
شعيرية نوبو 500 جم	0	 34,000 	
مكرونة نوبو 500 جم	0	 35,200 	
زيت زادنا 900 مل	0	 88,700 	
كابو 40 جم	10	 71,700 	
كابو 200 جم * 24	0	 127,600 	
كابو 200 جم * 12	10	 69,700 	
كابو 1ك	1	 160,700 	
كابو 2.25 كيلو	8	 175,700 	
خميرة 11 جم	18	 16,784 	
صافية 1.5 لتر	0	 9,750 	
صافية 500 مل	0	 8,750 	
صافية 600 مل	0	 8,750 	
صافية 330مل	0	 14,500 	
صافية 5لتر	0	 7,000 	
صافية 10لتر	0		
معكرونة نوبو 300 جم * 20	0	 117,000 	
خميرة بيكر دريم	0	 113,000 	
خميرة فواريس	0		0
`;

// ============================================
// Script logic (no need to edit below)
// ============================================

function parsePastedData(data: string) {
  const lines = data
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return lines.map((line, index) => {
    // Handle tab-separated or space-separated values
    const parts = line.split(/\t|\s{2,}/).filter(p => p.trim());
    
    if (parts.length < 3) {
      console.warn(`⚠️  Line ${index + 1} has invalid format: ${line}`);
      return null;
    }

    const name = parts[0].trim();
    
    // Parse stock - replace ##### with 0
    let stockStr = parts[1].trim();
    if (stockStr === '#####' || stockStr === '' || isNaN(parseFloat(stockStr.replace(/,/g, '')))) {
      stockStr = '0';
    }
    const stock = parseFloat(stockStr.replace(/,/g, '')) || 0;
    
    // Parse price - replace ##### with 0
    let priceStr = parts[2].trim();
    if (priceStr === '#####' || priceStr === '' || isNaN(parseFloat(priceStr.replace(/,/g, '').replace(/\s/g, '')))) {
      priceStr = '0';
    }
    const price = parseFloat(priceStr.replace(/,/g, '').replace(/\s/g, '')) || 0;

    // Handle negative stock
    const finalStock = stock < 0 ? 0 : stock;

    return { name, stock: finalStock, wholesalePrice: price };
  }).filter(item => item !== null) as Array<{ name: string; stock: number; wholesalePrice: number }>;
}

async function main() {
  console.log('🌱 Starting seed for Sub-Warehouse Grocery Stock...\n');
  console.log('📋 Parsing pasted data...\n');

  const groceryData = parsePastedData(pastedData);
  console.log(`✅ Parsed ${groceryData.length} items\n`);

  // Find or create the sub-warehouse
  console.log('📦 Finding/Creating Sub-Warehouse (المخزن الفرعي)...');
  let subWarehouse = await prisma.inventory.findFirst({
    where: { 
      OR: [
        { name: { contains: 'فرعي' } },
        { name: 'المخزن الفرعي' }
      ]
    }
  });

  if (!subWarehouse) {
    console.log('Creating Sub-Warehouse...');
    subWarehouse = await prisma.inventory.create({
      data: {
        name: 'المخزن الفرعي',
        isMain: false,
      },
    });
  }
  console.log(`✅ Warehouse: ${subWarehouse.name}\n`);

  // Process each item
  console.log('🛒 Processing grocery items...\n');
  
  let created = 0;
  let updated = 0;
  let skipped = 0;
  
  for (const itemData of groceryData) {
    // Skip items with zero stock and zero price
    if (itemData.stock === 0 && itemData.wholesalePrice === 0) {
      console.log(`⏭️  Skipping: ${itemData.name} (no stock, no price)`);
      skipped++;
      continue;
    }

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
      console.log(`  ✨ Creating new item`);
      
      // Calculate retail and agent prices (15% and 10% markup)
      const retailPrice = Math.round(itemData.wholesalePrice * 1.15);
      const agentPrice = Math.round(itemData.wholesalePrice * 1.10);

      item = await prisma.item.create({
        data: {
          name: itemData.name,
          section: Section.GROCERY,
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
      console.log(`  ♻️  Item exists, updating prices`);
      
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
      
      updated++;
    }

    // Update or create stock in sub-warehouse
    const existingStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: subWarehouse.id,
          itemId: item.id,
        },
      },
    });

    if (existingStock) {
      console.log(`  📊 Updating stock: ${existingStock.quantity} → ${itemData.stock}`);
      await prisma.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: subWarehouse.id,
            itemId: item.id,
          },
        },
        data: { quantity: itemData.stock },
      });
    } else {
      console.log(`  📊 Creating stock: ${itemData.stock}`);
      await prisma.inventoryStock.create({
        data: {
          inventoryId: subWarehouse.id,
          itemId: item.id,
          quantity: itemData.stock,
        },
      });
    }

    console.log(`  ✅ Stock=${itemData.stock}, Price=${itemData.wholesalePrice.toLocaleString()} SDG\n`);
  }

  const totalStock = groceryData.reduce((sum, item) => sum + (item.stock > 0 ? item.stock : 0), 0);
  const totalValue = groceryData.reduce((sum, item) => sum + (item.stock * item.wholesalePrice), 0);

  console.log(`\n✅ Seed completed successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Warehouse: ${subWarehouse.name}`);
  console.log(`   Section: البقالات (GROCERY)`);
  console.log(`   Total items: ${groceryData.length}`);
  console.log(`   Created: ${created} items`);
  console.log(`   Updated: ${updated} items`);
  console.log(`   Skipped: ${skipped} items (no stock/price)`);
  console.log(`   Total Stock Units: ${totalStock.toLocaleString()}`);
  console.log(`   Total Value: ${totalValue.toLocaleString()} SDG`);
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

