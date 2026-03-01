#!/usr/bin/env npx tsx
/**
 * Backfill paidAt for advances that have paidAt=null.
 * Advances created before the fix (paidAt at creation) need this to appear in reports.
 * Run: npx tsx scripts/backfill-advance-paid-at.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const updated = await prisma.$executeRaw`
    UPDATE advances SET "paidAt" = "createdAt" WHERE "paidAt" IS NULL
  `;

  console.log(`✅ Backfilled paidAt for ${updated} advance(s) (using createdAt as paidAt date)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
