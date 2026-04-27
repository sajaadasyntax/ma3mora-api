/**
 * Deletes all customer-scope opening balances and the treasury transactions that
 * the API auto-creates for them (description: "رصيد افتتاحي — عميل: ...").
 *
 * Use after moving debt to SalesInvoice (e.g. PRE-SYS-APR2026) so the UI does not
 * double-count opening balance + invoice receivables.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/clear-customer-opening-balances.ts --dry-run
 *   node ./node_modules/tsx/dist/cli.mjs scripts/clear-customer-opening-balances.ts --confirm
 */

import { PrismaClient, Prisma } from '@prisma/client';

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const CONFIRM = ARGS.includes('--confirm');

/** Matches accounting.ts: `رصيد افتتاحي — عميل: ${name}` (em dash U+2014) */
const OB_TREASURY_PREFIX = 'رصيد افتتاحي — عميل:';

const prisma = new PrismaClient();

async function main() {
  const obRows = await prisma.openingBalance.findMany({
    where: { scope: 'CUSTOMER' },
    select: { id: true, customerId: true, amount: true, openedAt: true },
  });
  const obTotal = obRows.reduce(
    (s, r) => s.add(new Prisma.Decimal(r.amount)),
    new Prisma.Decimal(0),
  );

  const treasuryRows = await prisma.treasuryTransaction.findMany({
    where: {
      customerId: { not: null },
      OR: [
        { description: { startsWith: OB_TREASURY_PREFIX } },
        // Some DBs/imports may have used ASCII hyphen
        { description: { startsWith: 'رصيد افتتاحي - عميل:' } },
      ],
    },
    select: { id: true, customerId: true, amount: true, type: true, description: true },
  });

  const trTotal = treasuryRows.reduce(
    (s, r) => s.add(new Prisma.Decimal(r.amount)),
    new Prisma.Decimal(0),
  );

  console.log('══════════════════════════════════════════════════');
  console.log('Clear customer opening balances + OB treasury mirrors');
  console.log('══════════════════════════════════════════════════');
  console.log(`  OpeningBalance (scope=CUSTOMER):  ${obRows.length} rows, total amount ${obTotal.toFixed(2)} SDG`);
  console.log(
    `  TreasuryTransaction (OB mirrors):  ${treasuryRows.length} rows, total amount ${trTotal.toFixed(2)} SDG`,
  );

  if (DRY_RUN || !CONFIRM) {
    console.log(
      DRY_RUN
        ? '\n  [DRY RUN] No changes. Run with --confirm to apply.'
        : '\n  Run with --confirm to delete, or use --dry-run to preview only.',
    );
    return;
  }

  const deletedTr = await prisma.treasuryTransaction.deleteMany({
    where: {
      id: { in: treasuryRows.map((t) => t.id) },
    },
  });
  const deletedOb = await prisma.openingBalance.deleteMany({
    where: { scope: 'CUSTOMER' },
  });

  console.log(`\n  ✓ Deleted ${deletedTr.count} treasury transactions`);
  console.log(`  ✓ Deleted ${deletedOb.count} customer opening balances`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
