/**
 * remove-treasury-by-customers.ts
 *
 * Deletes TreasuryTransaction rows linked to specific customers (customerId).
 *
 * Default: dry-run — prints each customer name and treasury totals only.
 * Apply:    npx tsx scripts/remove-treasury-by-customers.ts --apply
 *
 * After partial deletes, consider recalculating aggregates:
 *   npx tsx scripts/recalculate-financial-aggregates.ts --apply
 */

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Target customer IDs (edit this list as needed). */
const CUSTOMER_IDS = [
  'cmn4n271y00xvqyd7rii55h3x',
  'cmn78eo5p007r2tf8tw983myv',
  'cmn78f4mm007u2tf8f03igve8',
  'cmn78fh2b007x2tf8koqmm8hm',
  'cmn1zo68x00fgm99sreup5god',
  'cmn7ed7un00t82tf8lof0psfa',
  'cmn78htm100862tf8rzs8tblc',
].map((id) => id.trim().replace(/^\//, ''));

function sumAmount(rows: { type: string; amount: Prisma.Decimal }[]) {
  let cashIn = new Prisma.Decimal(0);
  let cashOut = new Prisma.Decimal(0);
  for (const r of rows) {
    if (r.type === 'CASH_IN') cashIn = cashIn.add(r.amount);
    else cashOut = cashOut.add(r.amount);
  }
  const net = cashIn.sub(cashOut);
  return { cashIn, cashOut, net };
}

async function main() {
  console.log(APPLY ? '⚠️  APPLY — deletions will run.\n' : '🔍  DRY-RUN — no deletions.\n');

  const uniqueIds = [...new Set(CUSTOMER_IDS)];

  const customers = await prisma.customer.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true },
  });

  const foundIds = new Set(customers.map((c) => c.id));

  const missing = uniqueIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    console.log('⚠️  Customer IDs not found in database (will skip):');
    for (const id of missing) console.log(`   ${id}`);
    console.log('');
  }

  if (customers.length === 0) {
    console.log('No matching customers. Nothing to do.');
    return;
  }

  let grandCount = 0;
  let grandIn = new Prisma.Decimal(0);
  let grandOut = new Prisma.Decimal(0);

  console.log('— Per customer (treasury_transactions where customerId = this customer) —\n');

  for (const c of customers.sort((a, b) => a.name.localeCompare(b.name))) {
    const txs = await prisma.treasuryTransaction.findMany({
      where: { customerId: c.id },
      select: { id: true, type: true, amount: true, method: true, description: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const { cashIn, cashOut, net } = sumAmount(txs);
    grandCount += txs.length;
    grandIn = grandIn.add(cashIn);
    grandOut = grandOut.add(cashOut);

    console.log(`Customer: ${c.name}`);
    console.log(`  id:       ${c.id}`);
    console.log(`  count:    ${txs.length}`);
    console.log(`  CASH_IN:  ${cashIn.toString()}`);
    console.log(`  CASH_OUT: ${cashOut.toString()}`);
    console.log(`  net (IN−OUT): ${net.toString()}`);
    if (txs.length > 0) {
      console.log('  lines:');
      for (const t of txs) {
        console.log(
          `    ${t.createdAt.toISOString()}  ${t.type}  ${t.amount}  ${t.method}  ${t.description.slice(0, 80)}`
        );
      }
    }
    console.log('');
  }

  console.log('— Grand total (all listed customers) —');
  console.log(`  transactions: ${grandCount}`);
  console.log(`  sum CASH_IN:   ${grandIn.toString()}`);
  console.log(`  sum CASH_OUT:  ${grandOut.toString()}`);
  console.log(`  net (IN−OUT):  ${grandIn.sub(grandOut).toString()}`);

  if (!APPLY) {
    console.log('\n✅  Dry-run done. Re-run with --apply to delete these treasury rows.');
    return;
  }

  if (grandCount === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const deleted = await prisma.treasuryTransaction.deleteMany({
    where: { customerId: { in: customers.map((c) => c.id) } },
  });

  console.log(`\n✅  Deleted ${deleted.count} treasury transaction(s).`);
  console.log(
    '\nIf daily aggregates look wrong, run:\n  npx tsx scripts/recalculate-financial-aggregates.ts --apply'
  );
}

main()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
