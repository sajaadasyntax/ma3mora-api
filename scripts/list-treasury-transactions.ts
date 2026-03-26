/**
 * list-treasury-transactions.ts
 *
 * Prints every TreasuryTransaction with amount and key fields.
 *
 * Usage:
 *   npx tsx scripts/list-treasury-transactions.ts
 *   npx tsx scripts/list-treasury-transactions.ts --json
 *
 * From apps/api via package.json:
 *   pnpm run script:list-treasury
 *   pnpm run script:list-treasury -- --json
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const asJson = process.argv.includes('--json');

async function main() {
  const rows = await prisma.treasuryTransaction.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      customer: { select: { name: true } },
      supplier: { select: { name: true } },
      creator: { select: { username: true } },
    },
  });

  if (rows.length === 0) {
    console.log('No treasury transactions.');
    return;
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          type: r.type,
          amount: r.amount.toString(),
          method: r.method,
          description: r.description,
          referenceNumber: r.referenceNumber,
          customerId: r.customerId,
          customerName: r.customer?.name ?? null,
          supplierId: r.supplierId,
          supplierName: r.supplier?.name ?? null,
          createdBy: r.createdBy,
          createdByUsername: r.creator.username,
          createdAt: r.createdAt.toISOString(),
        })),
        null,
        2
      )
    );
    return;
  }

  let totalSigned = 0;
  const byMethod: Record<string, number> = { CASH: 0, BANKAK: 0, BANK_NILE: 0 };

  for (const r of rows) {
    const amt = Number(r.amount);
    const signed = r.type === 'CASH_IN' ? amt : -amt;
    totalSigned += signed;
    const m = r.method as string;
    if (m in byMethod) {
      byMethod[m] += signed;
    }

    const party =
      r.customer?.name != null
        ? `customer: ${r.customer.name}`
        : r.supplier?.name != null
          ? `supplier: ${r.supplier.name}`
          : '—';
    const ref = r.referenceNumber ? ` ref=${r.referenceNumber}` : '';

    console.log(
      [
        r.createdAt.toISOString().slice(0, 19).replace('T', ' '),
        r.type.padEnd(8),
        String(r.amount).padStart(14),
        r.method.padEnd(10),
        `signed: ${signed >= 0 ? '+' : ''}${signed.toFixed(2)}`.padStart(16),
        `| ${r.description}${ref}`,
        `| ${party}`,
        `| by ${r.creator.username}`,
      ].join('  ')
    );
  }

  console.log('\n— Summary —');
  console.log(`  Count: ${rows.length}`);
  console.log(`  Net signed (IN minus OUT): ${totalSigned.toFixed(2)}`);
  console.log(`  By method (net): CASH=${byMethod.CASH.toFixed(2)}  BANKAK=${byMethod.BANKAK.toFixed(2)}  BANK_NILE=${byMethod.BANK_NILE.toFixed(2)}`);
}

main()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
