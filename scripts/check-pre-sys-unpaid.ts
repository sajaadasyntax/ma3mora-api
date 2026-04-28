/**
 * Read-only: sum unpaid (total - paidAmount) for legacy "pre-system" sales invoices.
 * Identifies invoices by invoiceNumber prefix (default PRE-SYS), matching seed / migration data.
 *
 * Usage (from apps/api):
 *   node ./node_modules/tsx/dist/cli.mjs scripts/check-pre-sys-unpaid.ts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/check-pre-sys-unpaid.ts --prefix=PRE-SYS
 *   node ./node_modules/tsx/dist/cli.mjs scripts/check-pre-sys-unpaid.ts --json
 *   node ./node_modules/tsx/dist/cli.mjs scripts/check-pre-sys-unpaid.ts --include-rejected
 *
 * Env: DATABASE_URL (same as Prisma).
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const includeRejected = args.includes('--include-rejected');
  const prefixArg = args.find((a) => a.startsWith('--prefix='));
  const prefix = prefixArg ? prefixArg.split('=')[1]?.trim() || 'PRE-SYS' : 'PRE-SYS';
  return { json, includeRejected, prefix };
}

async function main() {
  const { json, includeRejected, prefix } = parseArgs();

  const whereBase: Prisma.SalesInvoiceWhereInput = {
    invoiceNumber: { startsWith: prefix },
    ...(includeRejected ? {} : { paymentConfirmationStatus: { not: 'REJECTED' } }),
  };

  const invoices = await prisma.salesInvoice.findMany({
    where: whereBase,
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      paidAmount: true,
      paymentStatus: true,
      deliveryStatus: true,
      paymentConfirmationStatus: true,
      createdAt: true,
      inventory: { select: { id: true, name: true } },
      section: true,
      customer: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  let totalFace = new Prisma.Decimal(0);
  let totalPaid = new Prisma.Decimal(0);
  let outstandingPositive = new Prisma.Decimal(0);
  let countPositive = 0;
  let countPaidInFull = 0;
  let countRejected = 0;

  const byInventory = new Map<string, { name: string; outstanding: Prisma.Decimal; count: number }>();

  for (const inv of invoices) {
    if (inv.paymentConfirmationStatus === 'REJECTED') countRejected += 1;
    const total = new Prisma.Decimal(inv.total);
    const paid = new Prisma.Decimal(inv.paidAmount ?? 0);
    totalFace = totalFace.add(total);
    totalPaid = totalPaid.add(paid);
    const out = total.sub(paid);
    if (out.greaterThan(0)) {
      outstandingPositive = outstandingPositive.add(out);
      countPositive += 1;
      const key = inv.inventory?.id ?? '_none';
      const name = inv.inventory?.name ?? '(no warehouse)';
      const cur = byInventory.get(key) ?? { name, outstanding: new Prisma.Decimal(0), count: 0 };
      cur.outstanding = cur.outstanding.add(out);
      cur.count += 1;
      byInventory.set(key, cur);
    } else {
      countPaidInFull += 1;
    }
  }

  const payload = {
    prefix,
    excludeRejected: !includeRejected,
    invoiceCount: invoices.length,
    countUnpaidPositive: countPositive,
    countPaidOrOverpaid: countPaidInFull,
    countRejectedIncluded: includeRejected ? countRejected : undefined,
    totals: {
      invoiceFaceValue: totalFace.toFixed(2),
      paidAmount: totalPaid.toFixed(2),
      outstandingUnpaid: outstandingPositive.toFixed(2),
    },
    byWarehouse: Array.from(byInventory.entries())
      .map(([, v]) => ({
        warehouse: v.name,
        unpaidInvoiceCount: v.count,
        outstanding: v.outstanding.toFixed(2),
      }))
      .sort((a, b) => parseFloat(b.outstanding) - parseFloat(a.outstanding)),
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('\nPRE-SYSTEM SALES INVOICES — UNPAID CHECK (read-only)');
  console.log('='.repeat(72));
  console.log(`Invoice number prefix: ${prefix}`);
  console.log(`Rejected invoices: ${includeRejected ? 'included' : 'excluded'}`);
  console.log('-'.repeat(72));
  console.log(`Invoices matched:              ${invoices.length}`);
  console.log(`With balance due (> 0):       ${countPositive}`);
  console.log(`Paid / no balance:             ${countPaidInFull}`);
  if (includeRejected) console.log(`Rejected (in result set):      ${countRejected}`);
  console.log('-'.repeat(72));
  console.log(`Total invoice face (Σ total):  ${totalFace.toFixed(2)} SDG`);
  console.log(`Total paid (Σ paidAmount):     ${totalPaid.toFixed(2)} SDG`);
  console.log(`Total still unpaid (Σ max(0,total-paid)): ${outstandingPositive.toFixed(2)} SDG`);
  console.log('-'.repeat(72));
  if (byInventory.size > 0) {
    console.log('By warehouse (unpaid balance only):');
    for (const row of payload.byWarehouse) {
      console.log(`  ${row.warehouse}: ${row.outstanding} SDG (${row.unpaidInvoiceCount} invoices)`);
    }
  }
  console.log('='.repeat(72) + '\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
