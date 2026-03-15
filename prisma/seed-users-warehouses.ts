/**
 * Minimal Seed: Users (all roles) + Warehouses only
 * Password for all users: password123
 *
 * Run: npm run db:seed:users-warehouses
 * Or:  npx tsx prisma/seed-users-warehouses.ts
 */
import { PrismaClient, Role, Section, WarehouseType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PASSWORD = 'password123';

const usersData: { username: string; role: Role }[] = [
  { username: 'procurement', role: Role.PROCUREMENT },
  { username: 'sales_grocery', role: Role.SALES_GROCERY },
  { username: 'sales_bakery', role: Role.SALES_BAKERY },
  { username: 'agent_grocery', role: Role.AGENT_GROCERY },
  { username: 'agent_bakery', role: Role.AGENT_BAKERY },
  { username: 'inventory', role: Role.INVENTORY },
  { username: 'accountant', role: Role.ACCOUNTANT },
  { username: 'auditor', role: Role.AUDITOR },
  { username: 'manager', role: Role.MANAGER },
];

const warehousesData: { name: string; isMain: boolean; warehouseType: WarehouseType }[] = [
  { name: 'المخزن الرئيسي', isMain: true, warehouseType: WarehouseType.MAIN },
  { name: 'المخزن الفرعي', isMain: false, warehouseType: WarehouseType.MAIN },
  { name: 'مخزن ألقرشي', isMain: false, warehouseType: WarehouseType.ROAD },
  { name: 'المخزن عبود', isMain: false, warehouseType: WarehouseType.SIDE },
];

async function main() {
  console.log('🌱 Seeding Users and Warehouses only...\n');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // 1. Users
  console.log('Creating users...');
  for (const u of usersData) {
    await prisma.user.upsert({
      where: { username: u.username },
      create: {
        username: u.username,
        passwordHash,
        role: u.role,
      },
      update: { role: u.role },
    });
    console.log(`  ✓ ${u.username} (${u.role})`);
  }

  // 2. Warehouses (Inventories)
  console.log('\nCreating warehouses...');
  for (const w of warehousesData) {
    await prisma.inventory.upsert({
      where: { name: w.name },
      create: {
        name: w.name,
        isMain: w.isMain,
        warehouseType: w.warehouseType,
      },
      update: { isMain: w.isMain, warehouseType: w.warehouseType },
    });
    console.log(`  ✓ ${w.name} (${w.warehouseType})`);
  }

  console.log('\n✅ Done. Users: password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
