import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const prisma = new PrismaClient();

async function resetDatabase() {
  console.log('🔄 Resetting database...');
  
  try {
    // Drop all tables using Prisma migrate reset
    console.log('Dropping all tables...');
    execSync('npx prisma migrate reset --force', { stdio: 'inherit' });
    
    console.log('✅ Database reset completed successfully!');
    console.log('📝 Run "npm run seed" to populate with sample data');
  } catch (error) {
    console.error('❌ Error resetting database:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

resetDatabase();

