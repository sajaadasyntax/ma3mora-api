import { PrismaClient, Section, CustomerType } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Simple seed script - Just paste your Excel data here!
 * 
 * Copy from Excel (columns: الصنف, رصيد ختامي, سعر الجملة)
 * and paste below in the format:
 * 
 * 'Item Name', stock, price
 * 
 * Example:
 * 'حلواني باسطة', 0, 60000
 * 'دقيق صبايا', 1405, 50000
 */

// ================================
// PASTE YOUR EXCEL DATA HERE (between the quotes):
// ============================================
const pastedData = `
حلواني باسطة	0	 60,000 	
سيقا الاصلي 	1405	 50,000 	
الاول	0	 20,500 	
مخصوص	2	 23,000 	
سمولينا	316	 32,000 	
الاصلي 10 ك	247	 20,500 	
زادنا 10 ك	165	 24,000 	
معكرونة نوبو 300 جم * 30	1358	 33,000 	
شعيرية نوبو 300 جم * 30	467	 33,000 	
سكسكانية	1	 33,000 	
شعيرية نوبو 500 جم	0	 31,500 	
مكرونة نوبو 500 جم	277	 34,500 	
زيت زادنا 900 مل	26	 88,000 	
زيت زادنا 1.5 لتر	0		
زيت زادنا 18 لتر	50	 129,000 	
كابو 40 جم	68	 71,000 	
كابو 200 جم * 24	0		
كابو 200 جم * 12	59	 69,000 	
كابو 1ك	21	 160,000 	
كابو 2.25 كيلو	22	 175,000 	
سكر 5 كيلو	0	 13,500 	
بسكويت	0	 14,000 	
نودلز خضار	0	 18,500 	
نودلز فراخ	0	 18,500 	
عدس 200 جم	0	 40,500 	
عدس 1 ك	20	 48,000 	
عدس 5 كيلو	0	 15,000 	
خميرة 11 جم	205	 16,667 	
صافية 1.5 لتر	64	 9,750 	
صافية 500 مل	0	 8,750 	
صافية 600 مل	695	 8,750 	
صافية 330مل	54	 14,500 	
صافية 5لتر	80	 7,000 	
صافية 10لتر	0		
سبرايت 250 مل علب	0	 34,000 	
كولا علب 250 مل	0	 34,000 	
كولا 300 مل	0	 19,000 	
فانتا برتقال 300 مل	0	 19,000 	
سبرايت 300 مل	0	 19,000 	
كولا 1.45 لتر	0	 35,500 	
سبرايت 1.45 لتر	0	 35,500 	
فانتا برتقال 1.45 لتر	0	 35,500 	
الاصلي 10ك	0	 20,500 	
معكرونة نوبو 300 جم * 20	65	 19,000 	
خميرة بيكر دريم	16	 116,000 	
خميرة فواريس	0	 113,000 	
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
    const stock = parseFloat(parts[1].replace(/,/g, '')) || 0;
    const price = parseFloat(parts[2].replace(/,/g, '').replace(/\s/g, '')) || 0;

    // Handle negative stock
    const finalStock = stock < 0 ? 0 : stock;

    return { name, stock: finalStock, wholesalePrice: price };
  }).filter(item => item !== null) as Array<{ name: string; stock: number; wholesalePrice: number }>;
}

async function main() {
  console.log('🌱 Starting seed for Main Warehouse Grocery Stock...\n');
  console.log('📋 Parsing pasted data...\n');

  const groceryData = parsePastedData(pastedData);
  console.log(`✅ Parsed ${groceryData.length} items\n`);

  // Find or create the main warehouse
  console.log('📦 Finding/Creating Main Warehouse (المخزن الرئيسي)...');
  let mainWarehouse = await prisma.inventory.findFirst({
    where: { 
      OR: [
        { name: { contains: 'رئيسي' } },
        { name: 'المخزن الرئيسي' }
      ]
    }
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
  console.log(`✅ Warehouse: ${mainWarehouse.name}\n`);

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

    // Update or create stock
    const existingStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: mainWarehouse.id,
          itemId: item.id,
        },
      },
    });

    if (existingStock) {
      console.log(`  📊 Updating stock: ${existingStock.quantity} → ${itemData.stock}`);
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
      console.log(`  📊 Creating stock: ${itemData.stock}`);
      await prisma.inventoryStock.create({
        data: {
          inventoryId: mainWarehouse.id,
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
  console.log(`   Warehouse: ${mainWarehouse.name}`);
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

