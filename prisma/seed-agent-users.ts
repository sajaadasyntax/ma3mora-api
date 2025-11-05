import { PrismaClient, Role, Section } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Seed script for adding agent users to the database
 * Run with: npx ts-node prisma/seed-agent-users.ts
 */
async function main() {
  console.log('🌱 Starting agent users seed...');

  const hashedPassword = await bcrypt.hash('agent123', 10);

  // Get inventories
  const inventories = await prisma.inventory.findMany();
  const mainInventory = inventories.find(inv => inv.isMain);
  
  if (!mainInventory) {
    throw new Error('Main inventory not found. Please run the main seed first.');
  }

  // Create Agent Grocery User
  const agentGrocery = await prisma.user.upsert({
    where: { username: 'agent_grocery' },
    update: {},
    create: {
      username: 'agent_grocery',
      passwordHash: hashedPassword,
      role: Role.AGENT_GROCERY,
      accesses: {
        create: inventories.map(inv => ({
          inventoryId: inv.id,
          section: Section.GROCERY,
        })),
      },
    },
  });

  console.log('✅ Created agent_grocery user');

  // Create Agent Bakery User
  const agentBakery = await prisma.user.upsert({
    where: { username: 'agent_bakery' },
    update: {},
    create: {
      username: 'agent_bakery',
      passwordHash: hashedPassword,
      role: Role.AGENT_BAKERY,
      accesses: {
        create: inventories.map(inv => ({
          inventoryId: inv.id,
          section: Section.BAKERY,
        })),
      },
    },
  });

  console.log('✅ Created agent_bakery user');

  // Create some sample agent customers
  const agentCustomers = [
    { name: 'عميل وكيل 1', type: 'AGENT', division: Section.GROCERY },
    { name: 'عميل وكيل 2', type: 'AGENT', division: Section.GROCERY },
    { name: 'عميل وكيل 3', type: 'AGENT', division: Section.BAKERY },
  ];

  for (const customerData of agentCustomers) {
    await prisma.customer.upsert({
      where: { 
        // Use a compound where condition to avoid duplicates
        id: `agent-${customerData.name}`,
      },
      update: {},
      create: {
        name: customerData.name,
        type: customerData.type as any,
        division: customerData.division,
        isAgentCustomer: true,
      },
    });
  }

  console.log('✅ Created sample agent customers');

  // Update all items to have AGENT pricing tier
  const items = await prisma.item.findMany({
    include: {
      prices: {
        where: { tier: 'AGENT' },
      },
    },
  });

  let updatedCount = 0;
  for (const item of items) {
    // If item doesn't have AGENT price, create one based on RETAIL price
    if (item.prices.length === 0) {
      const retailPrice = await prisma.itemPrice.findFirst({
        where: {
          itemId: item.id,
          tier: 'RETAIL',
          inventoryId: null, // Global price
        },
        orderBy: { validFrom: 'desc' },
      });

      if (retailPrice) {
        await prisma.itemPrice.create({
          data: {
            itemId: item.id,
            tier: 'AGENT',
            price: retailPrice.price, // Start with same as retail, can be adjusted later
            inventoryId: null, // Global price
          },
        });
        updatedCount++;
      }
    }
  }

  console.log(`✅ Created AGENT prices for ${updatedCount} items`);

  console.log('\n🎉 Agent users seed completed!');
  console.log('\nAgent user credentials:');
  console.log('  Username: agent_grocery | Password: agent123');
  console.log('  Username: agent_bakery  | Password: agent123');
}

main()
  .catch((e) => {
    console.error('Error seeding agent users:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

