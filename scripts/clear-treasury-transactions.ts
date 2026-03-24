/**
 * clear-treasury-transactions.ts
 *
 * Deletes all TreasuryTransaction records and cleans up the aggregate
 * fields that are sourced exclusively from those records:
 *   - dailyFinancialAggregate.treasuryInflow  → reset to 0
 *   - dailyFinancialAggregate.treasuryOutflow → reset to 0
 *
 * NOTE: supplierCumulativeAggregate.totalPaid is built from BOTH
 * procurement order payments AND treasury CASH_OUT transactions.
 * To avoid corrupting supplier balances, those aggregates are NOT
 * touched here; they will naturally reflect the correct value on
 * the next recalculation (run recalculate-financial-aggregates.ts).
 *
 * Usage (dry-run, default):
 *   npx tsx scripts/clear-treasury-transactions.ts
 *
 * Usage (apply):
 *   npx tsx scripts/clear-treasury-transactions.ts --apply
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log(DRY_RUN ? '🔍  DRY-RUN mode — no changes will be written.\n' : '⚠️   APPLY mode — changes WILL be written.\n');

  // ── 1. Count what we're about to delete ──────────────────────────────────
  const count = await prisma.treasuryTransaction.count();
  console.log(`Treasury transactions to delete: ${count}`);

  if (count === 0) {
    console.log('Nothing to delete. Exiting.');
    return;
  }

  // ── 2. Show a breakdown ───────────────────────────────────────────────────
  const breakdown = await prisma.treasuryTransaction.groupBy({
    by: ['type'],
    _count: { id: true },
    _sum: { amount: true },
  });
  console.log('\nBreakdown by type:');
  for (const row of breakdown) {
    console.log(`  ${row.type}: ${row._count.id} records, total = ${row._sum.amount}`);
  }

  // ── 3. Find daily aggregates that have treasury data ─────────────────────
  const affectedAggregates = await (prisma as any).dailyFinancialAggregate.findMany({
    where: {
      OR: [
        { treasuryInflow: { gt: 0 } },
        { treasuryOutflow: { gt: 0 } },
      ],
    },
    select: { id: true, date: true, treasuryInflow: true, treasuryOutflow: true },
    orderBy: { date: 'asc' },
  });

  console.log(`\nDaily aggregate rows with treasury data: ${affectedAggregates.length}`);
  if (affectedAggregates.length > 0) {
    for (const agg of affectedAggregates) {
      const d = new Date(agg.date).toISOString().slice(0, 10);
      console.log(`  ${d} — inflow: ${agg.treasuryInflow}, outflow: ${agg.treasuryOutflow}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n✅  Dry-run complete. Re-run with --apply to execute.');
    return;
  }

  // ── 4. Delete treasury transactions ──────────────────────────────────────
  console.log('\nDeleting treasury transactions...');
  const deleted = await prisma.treasuryTransaction.deleteMany({});
  console.log(`✅  Deleted ${deleted.count} treasury transaction(s).`);

  // ── 5. Zero out treasury fields on daily aggregates ───────────────────────
  if (affectedAggregates.length > 0) {
    console.log('Resetting treasuryInflow / treasuryOutflow on daily aggregates...');
    const updated = await (prisma as any).dailyFinancialAggregate.updateMany({
      where: {
        id: { in: affectedAggregates.map((a: any) => a.id) },
      },
      data: {
        treasuryInflow: 0,
        treasuryOutflow: 0,
      },
    });
    console.log(`✅  Updated ${updated.count} daily aggregate row(s).`);
  }

  console.log('\n🏁  Done.');
  console.log(
    '\nNote: If supplier cumulative aggregates need updating, run:\n' +
    '  npx tsx scripts/recalculate-financial-aggregates.ts'
  );
}

main()
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
