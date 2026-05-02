/**
 * apply-april-2026-final-balances.ts
 *
 * Single-step script: forces every customer's outstanding to match the
 * الصافي (net) column from the April 2026 Excel sheet as of April 30.
 *
 * Goal:
 *   - Each Excel customer (sections 1a, 1b, 2a, 2b — non-moving excluded)
 *     ends up with outstanding = الصافي.
 *   - Customers in the database that are NOT on the Excel list have their
 *     pre-May outstanding marked PAID (no cash effect).
 *   - Customers only on the Excel list (not in the DB) are created as new.
 *   - Total system outstanding == sum of الصافي across both Excel files.
 *
 * Cutoff: this script ONLY touches data with createdAt < 2026-05-01.
 * Anything from May onwards is left alone.
 *
 * Idempotent: PRE-SYS-* invoices are wiped and re-created each run, and
 * EXCEL-APR2026:* SalesPayments left over from older runs of the apply
 * script are removed.
 *
 * Usage from apps/api:
 *   npm run script:apply-april-final          # dry-run / preview
 *   npm run script:apply-april-final:apply    # write
 */

import {
  PrismaClient,
  Prisma,
  CustomerType,
  Section,
  PaymentStatus,
  DeliveryStatus,
  PaymentMethod,
  Role,
} from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import type { AprilDebtsJson, CustomerData } from './extract-april-2026-debts-to-json';
import { NAME_OVERRIDES } from './data/april-2026-debts/name-overrides';

// ═══════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const CONFIRM = ARGS.includes('--confirm');
const KEEP_NON_MOVING = ARGS.includes('--keep-non-moving');

const DATA_DIR = path.join(__dirname, 'data', 'april-2026-debts');
const DEFAULT_JSON = path.join(DATA_DIR, 'april-2026-debts.json');
const JSON_FILE =
  ARGS.find((a) => a.startsWith('--json='))?.slice('--json='.length) ?? DEFAULT_JSON;

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const MAX_SAFE_AMOUNT = 99_999_999.99;
const MAX_SAFE_DELETE = 20_000;

/** Cutoff: this script does not touch any data created on/after this date. */
const MAY_1 = new Date('2026-05-01T00:00:00.000Z');
/** New PRE-SYS invoices are stamped with this date (last second of April 30). */
const FINAL_BALANCE_DATE = new Date('2026-04-30T23:59:59.999Z');

const REPORTS_DIR = __dirname;
const REPORT_PLAN = path.join(REPORTS_DIR, 'april-final-balances-plan.json');
const REPORT_UNMATCHED = path.join(REPORTS_DIR, 'april-final-balances-unmatched.json');

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════
type SectionTag = '1a' | '1b' | '2a' | '2b';

interface Plan {
  customer: CustomerData;
  finalBalance: number;
  matched: { id: string; name: string } | null;
  isNew: boolean;
  matchNote: string;
}

interface Unmatched {
  excelName: string;
  section: SectionTag;
  finalBalance: number;
  reason: 'multiple_candidates';
  candidates: { id: string; name: string; division: Section; type: CustomerType }[];
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function normalizeArabic(raw: string): string {
  return raw
    .trim()
    .replace(/ـ/g, '')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\u06A9/g, 'ك')
    .replace(/\u06CC/g, 'ي')
    .replace(/[-.\u060C,/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  const curr: number[] = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

function sectionToDivision(tag: SectionTag): Section {
  return tag === '1a' || tag === '1b' ? Section.BAKERY : Section.GROCERY;
}

function sectionToCustomerType(tag: SectionTag): CustomerType {
  switch (tag) {
    case '1a': return CustomerType.WHOLESALE;
    case '1b': return CustomerType.AGENT_WHOLESALE;
    case '2a': return CustomerType.WHOLESALE;
    case '2b': return CustomerType.RETAIL;
  }
}

function sectionLabel(tag: SectionTag): string {
  switch (tag) {
    case '1a': return 'بكري جملة';
    case '1b': return 'بكري وكيل جملة';
    case '2a': return 'بقالات جملة';
    case '2b': return 'بقالات قطاعي';
  }
}

function splitAmount(total: number): number[] {
  const parts: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_SAFE_AMOUNT);
    parts.push(chunk);
    remaining = Math.round((remaining - chunk) * 100) / 100;
  }
  return parts;
}

// ═══════════════════════════════════════════════════════════
// LOAD JSON
// ═══════════════════════════════════════════════════════════
function loadCustomers(jsonPath: string): CustomerData[] {
  if (!fs.existsSync(jsonPath)) {
    console.error(`✗ JSON file not found: ${jsonPath}`);
    console.error('  Run first: npm run script:extract-april-debts');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as AprilDebtsJson;
  if (KEEP_NON_MOVING) return data.customers;
  return data.customers.filter((c) => !c.nonMoving);
}

// ═══════════════════════════════════════════════════════════
// MATCH CUSTOMERS (uses shared NAME_OVERRIDES)
// ═══════════════════════════════════════════════════════════
async function buildPlan(
  prisma: PrismaClient,
  excelCustomers: CustomerData[],
): Promise<{ plans: Plan[]; unmatched: Unmatched[] }> {
  const all = await prisma.customer.findMany({
    select: { id: true, name: true, type: true, division: true },
  });
  const normalized = all.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    division: c.division,
    norm: normalizeArabic(c.name),
  }));
  const byId = new Map(all.map((c) => [c.id, c]));

  const plans: Plan[] = [];
  const unmatched: Unmatched[] = [];

  for (const customer of excelCustomers) {
    const trimmed = customer.name.trim();
    const normQuery = normalizeArabic(trimmed);
    const targetDivision = sectionToDivision(customer.section as SectionTag);
    const finalBalance = Math.round(customer.safiApril30 * 100) / 100;

    // ── NAME_OVERRIDES win over fuzzy match ──
    const override = NAME_OVERRIDES[trimmed];
    if (override !== undefined) {
      const id =
        typeof override === 'string' && override.length > 0 ? override :
        typeof override === 'object' && 'customerId' in override ? override.customerId :
        null;
      if (id && byId.has(id)) {
        const c = byId.get(id)!;
        plans.push({ customer, finalBalance, matched: { id: c.id, name: c.name }, isNew: false, matchNote: 'override' });
        continue;
      }
      // Empty / { create } overrides → fall through; if an existing exact match is
      // found below (e.g. seed already created it), reuse it; otherwise create new.
    }

    // ── Fuzzy match ──
    let candidates = normalized.filter((c) => c.norm === normQuery);
    let matchNote = 'exact';
    if (candidates.length === 0) {
      candidates = normalized.filter((c) => levenshtein(c.norm, normQuery) <= 2);
      matchNote = 'levenshtein≤2';
    }
    if (candidates.length === 0 && normQuery.length >= 8) {
      candidates = normalized.filter(
        (c) => c.norm.length >= 8 && (c.norm.includes(normQuery) || normQuery.includes(c.norm)),
      );
      matchNote = 'substring';
    }
    const sameDivision = candidates.filter((c) => c.division === targetDivision);
    if (sameDivision.length > 0) candidates = sameDivision;

    if (candidates.length === 1) {
      plans.push({ customer, finalBalance, matched: { id: candidates[0].id, name: candidates[0].name }, isNew: false, matchNote });
      continue;
    }

    if (candidates.length > 1) {
      unmatched.push({
        excelName: customer.name,
        section: customer.section as SectionTag,
        finalBalance,
        reason: 'multiple_candidates',
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, division: c.division, type: c.type })),
      });
      // Treat as new for now; user must add a NAME_OVERRIDES entry to resolve.
      plans.push({ customer, finalBalance, matched: null, isNew: true, matchNote: 'multiple_candidates' });
      continue;
    }

    plans.push({ customer, finalBalance, matched: null, isNew: true, matchNote: 'new' });
  }

  return { plans, unmatched };
}

// ═══════════════════════════════════════════════════════════
// RESET PHASE
// ═══════════════════════════════════════════════════════════
async function resetPhase(prisma: PrismaClient): Promise<void> {
  console.log('\n══════════════════════════════════');
  console.log('PHASE A — RESET (cutoff: createdAt < 2026-05-01)');
  console.log('══════════════════════════════════');

  // 1. Delete all PRE-SYS-* invoices (script-generated; safe to drop & recreate)
  const preSysInvoices = await prisma.salesInvoice.findMany({
    where: { invoiceNumber: { startsWith: 'PRE-SYS-' } },
    select: { id: true, total: true, paidAmount: true },
  });
  console.log(`  PRE-SYS-* invoices to delete:        ${preSysInvoices.length}`);

  // 2. SalesPayments created by old apply script (notes start with 'EXCEL-APR2026:')
  const excelPayments = await prisma.salesPayment.count({
    where: { notes: { startsWith: 'EXCEL-APR2026:' } },
  });
  console.log(`  EXCEL-APR2026:* SalesPayments to remove: ${excelPayments}`);

  // 3. All pre-May real invoices that still have outstanding > 0 → mark PAID
  const realUnpaid = await prisma.salesInvoice.findMany({
    where: {
      createdAt: { lt: MAY_1 },
      paymentConfirmationStatus: { not: 'REJECTED' },
      NOT: { invoiceNumber: { startsWith: 'PRE-SYS-' } },
    },
    select: { id: true, total: true, paidAmount: true },
  });
  let zeroedCount = 0;
  let zeroedAmount = new Prisma.Decimal(0);
  for (const inv of realUnpaid) {
    const due = new Prisma.Decimal(inv.total).sub(inv.paidAmount);
    if (due.greaterThan(0)) {
      zeroedCount++;
      zeroedAmount = zeroedAmount.add(due);
    }
  }
  console.log(`  Pre-May real invoices to mark PAID:  ${zeroedCount} (outstanding ${zeroedAmount.toFixed(2)} SDG zeroed)`);

  // 4. Customer opening balances
  const obCount = await prisma.openingBalance.count({ where: { scope: 'CUSTOMER' } });
  console.log(`  Customer OpeningBalances to delete:  ${obCount}`);

  // 5. Cumulative aggregates — wipe ALL rows so May+ rebuild on top of the
  //    corrected April 30 baseline. (May 1's running total depends on
  //    April 30's data; if we change pre-May invoices, every later row is
  //    stale until it recomputes.)
  const caCount = await prisma.customerCumulativeAggregate.count();
  const saCount = await prisma.supplierCumulativeAggregate.count();
  console.log(`  CustomerCumulativeAggregate (ALL): ${caCount}`);
  console.log(`  SupplierCumulativeAggregate (ALL): ${saCount}`);

  const totalDestructive = preSysInvoices.length + excelPayments + obCount;
  if (totalDestructive > MAX_SAFE_DELETE) {
    throw new Error(
      `Safety check FAILED: would delete ${totalDestructive} rows (limit: ${MAX_SAFE_DELETE}).`,
    );
  }

  if (DRY_RUN || !CONFIRM) {
    console.log('\n  [NO WRITE] reset phase preview only');
    return;
  }

  console.log('\n  Executing reset...');
  const BATCH = 500;

  // Delete PRE-SYS invoices
  let deletedPreSys = 0;
  const preSysIds = preSysInvoices.map((i) => i.id);
  for (let i = 0; i < preSysIds.length; i += BATCH) {
    const r = await prisma.salesInvoice.deleteMany({ where: { id: { in: preSysIds.slice(i, i + BATCH) } } });
    deletedPreSys += r.count;
  }
  console.log(`  ✓ Deleted ${deletedPreSys} PRE-SYS-* invoices`);

  // Delete EXCEL-APR2026 payments
  const deletedPayments = await prisma.salesPayment.deleteMany({
    where: { notes: { startsWith: 'EXCEL-APR2026:' } },
  });
  console.log(`  ✓ Deleted ${deletedPayments.count} EXCEL-APR2026:* SalesPayments`);

  // Mark pre-May real invoices PAID
  let updatedInvoices = 0;
  const toUpdate = realUnpaid.filter((inv) => new Prisma.Decimal(inv.total).greaterThan(inv.paidAmount));
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const slice = toUpdate.slice(i, i + BATCH);
    await prisma.$transaction(
      slice.map((inv) =>
        prisma.salesInvoice.update({
          where: { id: inv.id },
          data: {
            paidAmount: new Prisma.Decimal(inv.total),
            paymentStatus: PaymentStatus.PAID,
          },
        }),
      ),
    );
    updatedInvoices += slice.length;
  }
  console.log(`  ✓ Marked ${updatedInvoices} pre-May real invoices PAID`);

  // Delete customer opening balances
  const obDeleted = await prisma.openingBalance.deleteMany({ where: { scope: 'CUSTOMER' } });
  console.log(`  ✓ Deleted ${obDeleted.count} customer OpeningBalances`);

  // Invalidate ALL aggregates (pre-May AND May+) so they rebuild on top of
  // the corrected April 30 baseline.
  const caDeleted = await prisma.customerCumulativeAggregate.deleteMany({});
  const saDeleted = await prisma.supplierCumulativeAggregate.deleteMany({});
  console.log(`  ✓ Invalidated ${caDeleted.count} customer + ${saDeleted.count} supplier cumulative aggregates (all dates)`);
}

// ═══════════════════════════════════════════════════════════
// LATE-PAYMENT ITEM
// ═══════════════════════════════════════════════════════════
async function ensureLateItem(
  prisma: PrismaClient,
  section: Section,
): Promise<{ id: string }> {
  const existing = await prisma.item.findFirst({
    where: { name: 'متاخرات ما قبل السيستيم', section },
    select: { id: true },
  });
  if (existing) return existing;

  const created = await prisma.item.create({
    data: {
      name: 'متاخرات ما قبل السيستيم',
      section,
      prices: {
        create: [
          { tier: CustomerType.WHOLESALE, price: new Prisma.Decimal(1) },
          { tier: CustomerType.RETAIL, price: new Prisma.Decimal(1) },
          { tier: CustomerType.AGENT_WHOLESALE, price: new Prisma.Decimal(1) },
          { tier: CustomerType.BAKERY_CUSTOMER, price: new Prisma.Decimal(1) },
        ],
      },
    },
    select: { id: true },
  });
  console.log(`  ✨ Created item "متاخرات ما قبل السيستيم" (${section})`);
  return created;
}

// ═══════════════════════════════════════════════════════════
// SEED FINAL BALANCE INVOICES
// ═══════════════════════════════════════════════════════════
interface SeedSummary {
  invoicesPlanned: number;
  invoicesCreated: number;
  customersCreated: number;
  customersZero: number;
  totalSeeded: Prisma.Decimal;
  perSection: Record<SectionTag, { customers: number; invoices: number; sdg: number }>;
}

async function seedPhase(
  prisma: PrismaClient,
  plans: Plan[],
  warehouseId: string,
  salesUserBySection: Map<Section, string>,
): Promise<SeedSummary> {
  console.log('\n══════════════════════════════════');
  console.log('PHASE B — SEED FINAL BALANCES (createdAt = 2026-04-30)');
  console.log('══════════════════════════════════');

  const lateBakery = await ensureLateItem(prisma, Section.BAKERY);
  const lateGrocery = await ensureLateItem(prisma, Section.GROCERY);

  const summary: SeedSummary = {
    invoicesPlanned: 0,
    invoicesCreated: 0,
    customersCreated: 0,
    customersZero: 0,
    totalSeeded: new Prisma.Decimal(0),
    perSection: {
      '1a': { customers: 0, invoices: 0, sdg: 0 },
      '1b': { customers: 0, invoices: 0, sdg: 0 },
      '2a': { customers: 0, invoices: 0, sdg: 0 },
      '2b': { customers: 0, invoices: 0, sdg: 0 },
    },
  };

  for (const plan of plans) {
    const section = plan.customer.section as SectionTag;
    const finalBalance = plan.finalBalance;
    summary.perSection[section].customers++;

    if (finalBalance <= 0) {
      summary.customersZero++;
      continue;
    }

    let customerId: string | null = plan.matched?.id ?? null;
    let customerName: string = plan.matched?.name ?? plan.customer.name;

    if (!customerId) {
      // Create customer
      if (DRY_RUN || !CONFIRM) {
        console.log(`  [NEW] "${plan.customer.name}" (${sectionLabel(section)}) → outstanding ${finalBalance.toLocaleString()} SDG`);
      } else {
        const created = await prisma.customer.create({
          data: {
            name: plan.customer.name,
            type: sectionToCustomerType(section),
            division: sectionToDivision(section),
          },
          select: { id: true, name: true },
        });
        customerId = created.id;
        customerName = created.name;
        summary.customersCreated++;
        console.log(`  ✨ Created customer: "${customerName}"`);
      }
    }

    const division = sectionToDivision(section);
    const lateItem = division === Section.BAKERY ? lateBakery : lateGrocery;
    const salesUserId =
      salesUserBySection.get(division) ??
      salesUserBySection.get(Section.GROCERY) ??
      [...salesUserBySection.values()][0];

    const parts = finalBalance > MAX_SAFE_AMOUNT ? splitAmount(finalBalance) : [finalBalance];
    summary.invoicesPlanned += parts.length;
    summary.totalSeeded = summary.totalSeeded.add(new Prisma.Decimal(finalBalance));
    summary.perSection[section].invoices += parts.length;
    summary.perSection[section].sdg += finalBalance;

    if (DRY_RUN || !CONFIRM) {
      const partsNote = parts.length > 1 ? ` (${parts.length} parts)` : '';
      console.log(`  [SEED] "${customerName}" → ${finalBalance.toLocaleString()} SDG (${sectionLabel(section)})${partsNote}`);
      continue;
    }

    if (!customerId) continue; // safety; should never happen in CONFIRM mode

    const shortId = customerId.slice(-6);
    const timestamp = Date.now();
    const notes = `رصيد ختامي 2026-04-30 - ${sectionLabel(section)}`;

    for (let i = 0; i < parts.length; i++) {
      const partAmount = parts[i];
      const inv = new Prisma.Decimal(partAmount);
      const partSuffix = parts.length > 1 ? `-part${i + 1}` : '';
      const invoiceNumber = `PRE-SYS-APR2026-FINAL-${section.toUpperCase()}-${timestamp}-${shortId}${partSuffix}`;

      await prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          inventoryId: warehouseId,
          section: division,
          salesUserId,
          customerId,
          paymentMethod: PaymentMethod.DEBT,
          paymentStatus: PaymentStatus.CREDIT,
          deliveryStatus: DeliveryStatus.DELIVERED,
          paymentConfirmationStatus: 'PENDING',
          subtotal: inv,
          discount: new Prisma.Decimal(0),
          total: inv,
          paidAmount: new Prisma.Decimal(0),
          notes: parts.length > 1 ? `${notes} (جزء ${i + 1})` : notes,
          createdAt: FINAL_BALANCE_DATE,
          updatedAt: FINAL_BALANCE_DATE,
          items: {
            create: {
              itemId: lateItem.id,
              quantity: inv,
              unitPrice: new Prisma.Decimal(1),
              lineTotal: inv,
            },
          },
        },
      });
      summary.invoicesCreated++;
    }
  }

  return summary;
}

// ═══════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════
async function validateOutstanding(
  prisma: PrismaClient,
  expectedTotal: Prisma.Decimal,
): Promise<void> {
  console.log('\n══════════════════════════════════');
  console.log('PHASE C — VALIDATE OUTSTANDING');
  console.log('══════════════════════════════════');

  const allInvoices = await prisma.salesInvoice.findMany({
    where: {
      createdAt: { lt: MAY_1 },
      paymentConfirmationStatus: { not: 'REJECTED' },
    },
    select: { invoiceNumber: true, total: true, paidAmount: true },
  });
  let outstanding = new Prisma.Decimal(0);
  let preSysOutstanding = new Prisma.Decimal(0);
  let realOutstanding = new Prisma.Decimal(0);
  for (const inv of allInvoices) {
    const due = new Prisma.Decimal(inv.total).sub(inv.paidAmount);
    if (due.lessThanOrEqualTo(0)) continue;
    outstanding = outstanding.add(due);
    if (inv.invoiceNumber.startsWith('PRE-SYS-')) {
      preSysOutstanding = preSysOutstanding.add(due);
    } else {
      realOutstanding = realOutstanding.add(due);
    }
  }

  console.log(`  PRE-SYS-* outstanding (pre-May):  ${preSysOutstanding.toFixed(2)} SDG`);
  console.log(`  Other pre-May outstanding:        ${realOutstanding.toFixed(2)} SDG`);
  console.log(`  TOTAL pre-May outstanding:        ${outstanding.toFixed(2)} SDG`);
  console.log(`  Expected total (Excel الصافي):    ${expectedTotal.toFixed(2)} SDG`);
  const diff = outstanding.sub(expectedTotal);
  console.log(`  Difference (DB - Excel):          ${diff.toFixed(2)} SDG`);
  if (diff.abs().greaterThan(new Prisma.Decimal('0.5'))) {
    console.log('\n  ⚠ Difference exceeds tolerance — investigate before relying on numbers.');
  } else {
    console.log('\n  ✓ Outstanding matches Excel within tolerance.');
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   APRIL 2026 FINAL BALANCES (الصافي)            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  MODE: DRY RUN — no DB writes');
  else if (!CONFIRM) console.log('  MODE: PREVIEW — pass --confirm to write');
  else console.log('  MODE: LIVE — database will be modified');
  console.log(`  JSON: ${JSON_FILE}`);
  console.log(`  Non-moving section: ${KEEP_NON_MOVING ? 'INCLUDED' : 'SKIPPED (default — Excel grand total excludes them)'}`);
  console.log(`  Cutoff: createdAt < ${MAY_1.toISOString()}`);
  console.log();

  const customers = loadCustomers(JSON_FILE);
  const totalSafi = customers.reduce((s, c) => s + c.safiApril30, 0);
  const counts = customers.reduce(
    (acc, c) => ((acc[c.section as SectionTag] = (acc[c.section as SectionTag] ?? 0) + 1), acc),
    {} as Record<SectionTag, number>,
  );
  console.log(`Loaded ${customers.length} customers from JSON:`);
  console.log(`  1a=${counts['1a'] ?? 0}  1b=${counts['1b'] ?? 0}  2a=${counts['2a'] ?? 0}  2b=${counts['2b'] ?? 0}`);
  console.log(`  Total الصافي target outstanding: ${totalSafi.toLocaleString()} SDG`);

  const prisma = new PrismaClient();
  try {
    // Find warehouse
    const warehouse = await prisma.inventory.findFirst({
      where: { OR: [{ name: { contains: 'رئيسي' } }, { name: 'المخزن الرئيسي' }] },
      select: { id: true, name: true },
    });
    if (!warehouse) {
      throw new Error('Main warehouse not found.');
    }

    // Find sales users
    const bakeryUser = await prisma.user.findFirst({
      where: { role: { in: [Role.SALES_BAKERY, Role.ACCOUNTANT, Role.MANAGER] } },
      select: { id: true, username: true },
      orderBy: { createdAt: 'asc' },
    });
    const groceryUser = await prisma.user.findFirst({
      where: { role: { in: [Role.SALES_GROCERY, Role.ACCOUNTANT, Role.MANAGER] } },
      select: { id: true, username: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!bakeryUser || !groceryUser) {
      throw new Error('Could not find a sales/accountant user. Ensure users exist.');
    }
    const salesUserBySection = new Map<Section, string>([
      [Section.BAKERY, bakeryUser.id],
      [Section.GROCERY, groceryUser.id],
    ]);

    console.log(`\n  Warehouse:    ${warehouse.name}`);
    console.log(`  Bakery user:  ${bakeryUser.username}`);
    console.log(`  Grocery user: ${groceryUser.username}`);

    // Build the plan
    const { plans, unmatched } = await buildPlan(prisma, customers);
    const matchedExisting = plans.filter((p) => p.matched).length;
    const newCustomers = plans.filter((p) => !p.matched).length;

    console.log(`\n  Plans:`);
    console.log(`    Matched existing customers: ${matchedExisting}`);
    console.log(`    New customers to create:    ${newCustomers}`);
    console.log(`    Unresolved (multi-match):    ${unmatched.length}`);
    if (unmatched.length > 0) {
      fs.writeFileSync(REPORT_UNMATCHED, JSON.stringify(unmatched, null, 2), 'utf8');
      console.log(`    → ${REPORT_UNMATCHED} (add NAME_OVERRIDES entries to resolve)`);
    }

    fs.writeFileSync(
      REPORT_PLAN,
      JSON.stringify(
        plans.map((p) => ({
          excelName: p.customer.name,
          section: p.customer.section,
          matchedCustomerId: p.matched?.id ?? null,
          matchedCustomerName: p.matched?.name ?? null,
          isNew: p.isNew,
          matchNote: p.matchNote,
          finalBalance: p.finalBalance,
        })),
        null,
        2,
      ),
      'utf8',
    );
    console.log(`    → ${REPORT_PLAN}`);

    // Reset
    await resetPhase(prisma);

    // Seed final balances
    const summary = await seedPhase(prisma, plans, warehouse.id, salesUserBySection);

    // Final summary
    console.log('\n══════════════════════════════════');
    console.log('SUMMARY');
    console.log('══════════════════════════════════');
    for (const tag of ['1a', '1b', '2a', '2b'] as SectionTag[]) {
      const s = summary.perSection[tag];
      console.log(`  ${tag} (${sectionLabel(tag)}): ${s.customers} customers, ${s.invoices} invoices, ${s.sdg.toLocaleString()} SDG`);
    }
    console.log('  ─────────────────────────────────');
    console.log(`  Customers with zero final balance (skipped): ${summary.customersZero}`);
    console.log(`  Total invoices ${DRY_RUN || !CONFIRM ? 'planned' : 'created'}: ${DRY_RUN || !CONFIRM ? summary.invoicesPlanned : summary.invoicesCreated}`);
    console.log(`  New customers ${DRY_RUN || !CONFIRM ? 'planned' : 'created'}: ${DRY_RUN || !CONFIRM ? newCustomers : summary.customersCreated}`);
    console.log(`  Total seeded: ${summary.totalSeeded.toFixed(2)} SDG`);

    if (CONFIRM && !DRY_RUN) {
      await validateOutstanding(prisma, summary.totalSeeded);
      console.log('\n  ✅ Done. Each customer now reflects the Excel الصافي as of April 30.');
    } else {
      console.log('\n  Run with --confirm to apply changes.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message ?? err);
  process.exit(1);
});
