/**
 * seed-april-2026-debts.ts
 *
 * Resets April 2026 carry-over seeded debts (PRE-SYS-* invoices only) and
 * re-seeds April 1 opening balances from the canonical JSON produced by
 * extract-april-2026-debts-to-json.ts.
 *
 * Safe for manual invoices: the reset phase deletes ONLY PRE-SYS-* invoices
 * (which are script-generated). Every manually-created pre-April invoice is
 * preserved; apply-april-2026-excel-payments.ts Phase 1 will mark them PAID
 * with no cash effect so they don't double-count.
 *
 * Usage (from apps/api):
 *   npm run script:seed-april-debts          # dry-run / preview
 *   npm run script:seed-april-debts:apply    # live write
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/seed-april-2026-debts.ts [flags]
 *   --dry-run      Parse, match, print plan — no DB writes; also writes diff JSON lists
 *   --confirm      Required to execute destructive writes
 *   --no-reset     Skip the PRE-SYS-* delete phase, only seed
 *   --json=<path>  JSON file produced by extract-april-2026-debts-to-json.ts
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
import * as path from 'path';
import * as fs from 'fs';
import type { AprilDebtsJson, CustomerData } from './extract-april-2026-debts-to-json';
import { NAME_OVERRIDES } from './data/april-2026-debts/name-overrides';

// ═══════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const NO_RESET = ARGS.includes('--no-reset');
const CONFIRM = ARGS.includes('--confirm');

const DATA_DIR = path.join(__dirname, 'data', 'april-2026-debts');
const DEFAULT_JSON = path.join(DATA_DIR, 'april-2026-debts.json');
const JSON_FILE =
  ARGS.find((a) => a.startsWith('--json='))?.slice('--json='.length) ?? DEFAULT_JSON;

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const MAX_SAFE_AMOUNT = 99_999_999.99;
const MAX_SAFE_DELETE = 10_000;
const APRIL_1 = new Date('2026-04-01T00:00:00.000Z');
const SEED_DATE = new Date('2026-04-01T00:00:00.000Z');
const REPORT_FILE = path.join(__dirname, 'unmatched-debts-report.json');

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════
type SectionTag = '1a' | '1b' | '2a' | '2b';

interface DebtRow {
  rowNum: number | null;
  name: string;
  openingBalance: number;
  sectionTag: SectionTag;
  nonMoving: boolean;
  /** Aggregated from JSON daily array */
  totalDebt: number;
  totalCash: number;
  totalBank: number;
}

interface MatchResult {
  row: DebtRow;
  existingCustomerId: string | null;
  existingCustomerName: string | null;
  isNew: boolean;
  matchNote?: string;
}

interface UnmatchedEntry {
  section: SectionTag;
  name: string;
  openingBalance: number;
  candidates: { id: string; name: string; division: Section }[];
  reason: 'no_match' | 'multiple_candidates';
}

// ═══════════════════════════════════════════════════════════
// ARABIC NORMALIZATION & LEVENSHTEIN
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

// ═══════════════════════════════════════════════════════════
// JSON LOADER
// ═══════════════════════════════════════════════════════════
function loadDebtRowsFromJson(jsonPath: string): DebtRow[] {
  if (!fs.existsSync(jsonPath)) {
    console.error(`\n✗ JSON file not found: ${jsonPath}`);
    console.error('  Run first:  npm run script:extract-april-debts');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as AprilDebtsJson;
  const rows: DebtRow[] = [];

  for (const c of data.customers) {
    if (c.openingBalanceApril1 <= 0) continue;
    const totalDebt = c.daily.reduce((s, d) => s + d.debt, 0);
    const totalCash = c.daily.reduce((s, d) => s + d.cash, 0);
    const totalBank = c.daily.reduce((s, d) => s + d.bank, 0);
    rows.push({
      rowNum: c.rowNum,
      name: c.name,
      openingBalance: c.openingBalanceApril1,
      sectionTag: c.section as SectionTag,
      nonMoving: c.nonMoving,
      totalDebt,
      totalCash,
      totalBank,
    });
  }

  return rows;
}

// ═══════════════════════════════════════════════════════════
// SECTION HELPERS
// ═══════════════════════════════════════════════════════════
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

function sectionToInvoiceSection(tag: SectionTag): Section {
  return tag === '1a' || tag === '1b' ? Section.BAKERY : Section.GROCERY;
}

function sectionLabel(tag: SectionTag): string {
  switch (tag) {
    case '1a': return 'ديون 25 كيلو - مجموعة 1';
    case '1b': return 'ديون 25 كيلو - مجموعة 2';
    case '2a': return 'منتجات جملة';
    case '2b': return 'منتجات قطاعي';
  }
}

// ═══════════════════════════════════════════════════════════
// NAME_OVERRIDES VALIDATION
// ═══════════════════════════════════════════════════════════
async function validateOverrides(prisma: PrismaClient): Promise<void> {
  for (const [excelName, override] of Object.entries(NAME_OVERRIDES)) {
    const id =
      typeof override === 'string' ? override :
      typeof override === 'object' && 'customerId' in override ? override.customerId :
      null;
    if (!id) continue;
    const exists = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      console.warn(`  ⚠ NAME_OVERRIDES["${excelName}"] -> id "${id}" not found in DB — entry will be treated as new customer`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// NAME MATCHING
// ═══════════════════════════════════════════════════════════
async function matchRows(
  prisma: PrismaClient,
  rows: DebtRow[],
): Promise<{ matched: MatchResult[]; unmatchedReport: UnmatchedEntry[] }> {
  const allCustomers = await prisma.customer.findMany({
    select: { id: true, name: true, division: true },
  });

  const normalizedDb = allCustomers.map((c) => ({
    id: c.id,
    name: c.name,
    division: c.division,
    normalized: normalizeArabic(c.name),
  }));

  const matched: MatchResult[] = [];
  const unmatchedReport: UnmatchedEntry[] = [];

  for (const row of rows) {
    const trimmedName = row.name.trim();
    const normQuery = normalizeArabic(trimmedName);
    const targetDivision = sectionToDivision(row.sectionTag);

    // ── NAME_OVERRIDES takes precedence ─────────────────────
    const override = NAME_OVERRIDES[trimmedName];
    if (override !== undefined) {
      const id =
        typeof override === 'string' ? override :
        typeof override === 'object' && 'customerId' in override ? override.customerId :
        null;

      if (id) {
        const exists = await prisma.customer.findUnique({ where: { id }, select: { id: true, name: true } });
        if (exists) {
          matched.push({ row, existingCustomerId: id, existingCustomerName: exists.name, isNew: false, matchNote: 'override' });
          continue;
        }
        console.warn(`  ⚠ Override id "${id}" for "${trimmedName}" not found — treating as new`);
      }
      // Empty string or { create: true } normally means create. If the seed was
      // already run once, prefer the exact DB match so the script remains rerunnable.
      const exactCreated = normalizedDb.filter(
        (c) => c.normalized === normQuery && c.division === targetDivision,
      );
      if (exactCreated.length === 1) {
        matched.push({
          row,
          existingCustomerId: exactCreated[0].id,
          existingCustomerName: exactCreated[0].name,
          isNew: false,
          matchNote: 'override:create-existing',
        });
        continue;
      }
      matched.push({ row, existingCustomerId: null, existingCustomerName: null, isNew: true, matchNote: 'override:create' });
      continue;
    }

    // ── Fuzzy matching ───────────────────────────────────────
    let candidates = normalizedDb.filter(() => false);
    let matchNote = '';

    const exact = normalizedDb.filter((c) => c.normalized === normQuery);
    if (exact.length > 0) { candidates = exact; matchNote = 'exact'; }

    if (candidates.length === 0) {
      const lev = normalizedDb.filter((c) => levenshtein(c.normalized, normQuery) <= 2);
      if (lev.length > 0) { candidates = lev; matchNote = 'levenshtein≤2'; }
    }

    if (candidates.length === 0 && normQuery.length >= 8) {
      const sub = normalizedDb.filter(
        (c) =>
          c.normalized.length >= 8 &&
          (c.normalized.includes(normQuery) || normQuery.includes(c.normalized)),
      );
      if (sub.length > 0) { candidates = sub; matchNote = 'substring'; }
    }

    // Prefer same-division candidates to break ties
    const sameDivision = candidates.filter((c) => c.division === targetDivision);
    if (sameDivision.length > 0) candidates = sameDivision;

    if (candidates.length === 1) {
      matched.push({
        row,
        existingCustomerId: candidates[0].id,
        existingCustomerName: candidates[0].name,
        isNew: false,
        matchNote: matchNote === 'exact' ? undefined : matchNote,
      });
    } else if (candidates.length > 1) {
      unmatchedReport.push({
        section: row.sectionTag,
        name: row.name,
        openingBalance: row.openingBalance,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, division: c.division })),
        reason: 'multiple_candidates',
      });
      matched.push({ row, existingCustomerId: null, existingCustomerName: null, isNew: true });
    } else {
      unmatchedReport.push({
        section: row.sectionTag,
        name: row.name,
        openingBalance: row.openingBalance,
        candidates: [],
        reason: 'no_match',
      });
      matched.push({ row, existingCustomerId: null, existingCustomerName: null, isNew: true });
    }
  }

  return { matched, unmatchedReport };
}

// ═══════════════════════════════════════════════════════════
// DRY-RUN DIFF LISTS
// ═══════════════════════════════════════════════════════════
async function writeDryRunLists(
  prisma: PrismaClient,
  rows: DebtRow[],
  matched: MatchResult[],
): Promise<void> {
  const reportsDir = __dirname;

  // ── 1. Excel customers ──────────────────────────────────
  interface ExcelCustomerEntry {
    excelName: string;
    section: SectionTag;
    nonMoving: boolean;
    openingBalanceApril1: number;
    totalDebtApril: number;
    totalCashApril: number;
    totalBankApril: number;
    matchedCustomerId: string | null;
    matchedCustomerName: string | null;
    isNew: boolean;
    matchNote?: string;
  }

  const excelList: ExcelCustomerEntry[] = matched.map((m) => ({
    excelName: m.row.name,
    section: m.row.sectionTag,
    nonMoving: m.row.nonMoving,
    openingBalanceApril1: m.row.openingBalance,
    totalDebtApril: m.row.totalDebt,
    totalCashApril: m.row.totalCash,
    totalBankApril: m.row.totalBank,
    matchedCustomerId: m.existingCustomerId,
    matchedCustomerName: m.existingCustomerName,
    isNew: m.isNew,
    matchNote: m.matchNote,
  }));

  fs.writeFileSync(
    path.join(reportsDir, 'april-customers-from-excel.json'),
    JSON.stringify(excelList, null, 2),
    'utf8',
  );

  // ── 2. DB customers with pre-April unpaid invoices ─────
  const preAprilInvoices = await prisma.salesInvoice.findMany({
    where: {
      createdAt: { lt: APRIL_1 },
      paymentConfirmationStatus: { not: 'REJECTED' },
    },
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      paidAmount: true,
      customerId: true,
      customer: { select: { id: true, name: true, division: true, type: true } },
    },
  });

  const unpaidByCustomer = new Map<
    string,
    { id: string; name: string; division: Section; type: CustomerType; outstanding: number; invoiceCount: number; hasPreSys: boolean; hasManual: boolean }
  >();

  for (const inv of preAprilInvoices) {
    const outstanding = new Prisma.Decimal(inv.total).sub(new Prisma.Decimal(inv.paidAmount));
    if (!outstanding.greaterThan(0)) continue;
    if (!inv.customerId || !inv.customer) continue;

    const existing = unpaidByCustomer.get(inv.customerId);
    const isPreSys = inv.invoiceNumber.startsWith('PRE-SYS-');
    if (existing) {
      existing.outstanding += outstanding.toNumber();
      existing.invoiceCount += 1;
      if (isPreSys) existing.hasPreSys = true;
      else existing.hasManual = true;
    } else {
      unpaidByCustomer.set(inv.customerId, {
        id: inv.customerId,
        name: inv.customer.name,
        division: inv.customer.division,
        type: inv.customer.type,
        outstanding: outstanding.toNumber(),
        invoiceCount: 1,
        hasPreSys: isPreSys,
        hasManual: !isPreSys,
      });
    }
  }

  const dbList = Array.from(unpaidByCustomer.values());
  fs.writeFileSync(
    path.join(reportsDir, 'april-customers-with-unpaid-in-db.json'),
    JSON.stringify(dbList, null, 2),
    'utf8',
  );

  // ── 3. Overlap ─────────────────────────────────────────
  const matchedIds = new Set<string>(
    matched.filter((m) => m.existingCustomerId).map((m) => m.existingCustomerId as string),
  );
  const dbCustomerIds = new Set(dbList.map((c) => c.id));

  const excelOnly = excelList.filter((e) => e.isNew);
  const dbOnly = dbList.filter((c) => !matchedIds.has(c.id));
  const inBoth = matched
    .filter((m) => m.existingCustomerId && dbCustomerIds.has(m.existingCustomerId))
    .map((m) => {
      const dbEntry = unpaidByCustomer.get(m.existingCustomerId!);
      const diff = Math.abs((dbEntry?.outstanding ?? 0) - m.row.openingBalance);
      return {
        excelName: m.row.name,
        customerId: m.existingCustomerId,
        customerName: m.existingCustomerName,
        section: m.row.sectionTag,
        nonMoving: m.row.nonMoving,
        excelOpening: m.row.openingBalance,
        dbOutstanding: dbEntry?.outstanding ?? 0,
        diff: diff,
        mismatch: diff > 0.01,
      };
    });

  const mismatchCount = inBoth.filter((e) => e.mismatch).length;

  fs.writeFileSync(
    path.join(reportsDir, 'april-customers-overlap.json'),
    JSON.stringify({ excelOnly, dbOnly, inBoth }, null, 2),
    'utf8',
  );

  // ── Console summary ─────────────────────────────────────
  const sectionCounts: Record<SectionTag, number> = { '1a': 0, '1b': 0, '2a': 0, '2b': 0 };
  for (const r of rows) sectionCounts[r.sectionTag]++;

  console.log(`\n  Excel customers:              ${rows.length} (1a:${sectionCounts['1a']} 1b:${sectionCounts['1b']} 2a:${sectionCounts['2a']} 2b:${sectionCounts['2b']})`);
  console.log(`  DB customers w/ unpaid:       ${dbList.length}`);
  console.log(`    → Excel-only (will create):   ${excelOnly.length}`);
  console.log(`    → DB-only (will be PAID):     ${dbOnly.length}`);
  console.log(`    → In both:                    ${inBoth.length}  (${inBoth.length - mismatchCount} match, ${mismatchCount} mismatches)`);
  console.log(`\n  Diff reports written to:`);
  console.log(`    ${path.join(reportsDir, 'april-customers-from-excel.json')}`);
  console.log(`    ${path.join(reportsDir, 'april-customers-with-unpaid-in-db.json')}`);
  console.log(`    ${path.join(reportsDir, 'april-customers-overlap.json')}`);
}

// ═══════════════════════════════════════════════════════════
// RESET PHASE — deletes PRE-SYS-* only; manual invoices preserved
// ═══════════════════════════════════════════════════════════
async function resetPhase(prisma: PrismaClient): Promise<void> {
  console.log('\n══════════════════════════════════');
  console.log('RESET PHASE');
  console.log('══════════════════════════════════');
  console.log('  Scope: PRE-SYS-* invoices only (manual invoices are preserved).');

  const preSysInvoices = await prisma.salesInvoice.findMany({
    where: { invoiceNumber: { startsWith: 'PRE-SYS-' } },
    select: { id: true, invoiceNumber: true, total: true, paidAmount: true },
  });

  const outstanding = preSysInvoices.reduce(
    (sum, inv) => {
      const o = new Prisma.Decimal(inv.total).sub(new Prisma.Decimal(inv.paidAmount));
      return sum.add(o.greaterThan(0) ? o : new Prisma.Decimal(0));
    },
    new Prisma.Decimal(0),
  );

  console.log(`  PRE-SYS-* invoices to delete:   ${preSysInvoices.length}`);
  console.log(`  Outstanding receivables freed:   ${outstanding.toFixed(2)} SDG`);

  const obCount = await prisma.openingBalance.count({ where: { scope: 'CUSTOMER' } });
  console.log(`  Customer OpeningBalances:        ${obCount} (will be deleted)`);

  if (preSysInvoices.length + obCount > MAX_SAFE_DELETE) {
    throw new Error(
      `Safety check FAILED: would delete ${preSysInvoices.length + obCount} rows (limit: ${MAX_SAFE_DELETE}).`,
    );
  }

  if (DRY_RUN || !CONFIRM) {
    console.log('\n  [NO WRITE] Run with --confirm to execute the reset phase.');
    return;
  }

  const BATCH = 500;
  let deleted = 0;
  const ids = preSysInvoices.map((i) => i.id);
  for (let i = 0; i < ids.length; i += BATCH) {
    const r = await prisma.salesInvoice.deleteMany({ where: { id: { in: ids.slice(i, i + BATCH) } } });
    deleted += r.count;
  }
  console.log(`  ✓ Deleted ${deleted} PRE-SYS-* SalesInvoices`);

  const obDeleted = await prisma.openingBalance.deleteMany({ where: { scope: 'CUSTOMER' } });
  console.log(`  ✓ Deleted ${obDeleted.count} customer OpeningBalances`);

  const caDeleted = await prisma.customerCumulativeAggregate.deleteMany({ where: { date: { lt: APRIL_1 } } });
  const saDeleted = await prisma.supplierCumulativeAggregate.deleteMany({ where: { date: { lt: APRIL_1 } } });
  console.log(`  ✓ Invalidated ${caDeleted.count} CustomerCumulativeAggregates + ${saDeleted.count} SupplierCumulativeAggregates`);
}

// ═══════════════════════════════════════════════════════════
// ENSURE LEGACY ITEM
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
// SEED PHASE
// ═══════════════════════════════════════════════════════════
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

async function seedPhase(
  prisma: PrismaClient,
  matchedRows: MatchResult[],
  mainWarehouseId: string,
  salesUserBySection: Map<Section, string>,
): Promise<{
  invoicesCreated: number;
  newCustomers: number;
  totalSeeded: Prisma.Decimal;
  perSection: Record<SectionTag, { invoices: number; sdg: number }>;
}> {
  console.log('\n══════════════════════════════════');
  console.log('SEED PHASE');
  console.log('══════════════════════════════════');

  const lateItemBakery = await ensureLateItem(prisma, Section.BAKERY);
  const lateItemGrocery = await ensureLateItem(prisma, Section.GROCERY);

  let invoicesCreated = 0;
  let newCustomers = 0;
  let totalSeeded = new Prisma.Decimal(0);
  const perSection: Record<SectionTag, { invoices: number; sdg: number }> = {
    '1a': { invoices: 0, sdg: 0 },
    '1b': { invoices: 0, sdg: 0 },
    '2a': { invoices: 0, sdg: 0 },
    '2b': { invoices: 0, sdg: 0 },
  };

  for (const match of matchedRows) {
    const { row, existingCustomerId, existingCustomerName, isNew } = match;

    let customerId: string;
    let customerName: string;

    if (!isNew && existingCustomerId) {
      customerId = existingCustomerId;
      customerName = existingCustomerName!;
    } else {
      if (DRY_RUN || !CONFIRM) {
        const note = match.matchNote ? ` [${match.matchNote}]` : '';
        console.log(`  [NEW] "${row.name}" (${sectionLabel(row.sectionTag)}) → ${row.openingBalance.toLocaleString()} SDG${note}`);
        perSection[row.sectionTag].invoices += 1;
        perSection[row.sectionTag].sdg += row.openingBalance;
        totalSeeded = totalSeeded.add(new Prisma.Decimal(row.openingBalance));
        invoicesCreated += 1;
        continue;
      }
      const created = await prisma.customer.create({
        data: {
          name: row.name,
          type: sectionToCustomerType(row.sectionTag),
          division: sectionToDivision(row.sectionTag),
        },
        select: { id: true, name: true },
      });
      customerId = created.id;
      customerName = created.name;
      newCustomers++;
      console.log(`  ✨ Created customer: "${customerName}"`);
    }

    const invoiceSection = sectionToInvoiceSection(row.sectionTag);
    const lateItem = invoiceSection === Section.BAKERY ? lateItemBakery : lateItemGrocery;
    const salesUserId =
      salesUserBySection.get(invoiceSection) ??
      salesUserBySection.get(Section.GROCERY) ??
      [...salesUserBySection.values()][0];
    const shortId = customerId.slice(-6);
    const timestamp = Date.now();
    const label = sectionLabel(row.sectionTag);
    const nmSuffix = row.nonMoving ? ' (غير متحركة)' : '';
    const notes = `رصيد افتتاحي 2026-04-01 - ${label}${nmSuffix}`;

    const amount = row.openingBalance;
    const parts = amount > MAX_SAFE_AMOUNT ? splitAmount(amount) : [amount];

    if (DRY_RUN || !CONFIRM) {
      const note = match.matchNote ? ` [${match.matchNote}]` : '';
      const partsNote = parts.length > 1 ? ` (split into ${parts.length} invoices)` : '';
      console.log(`  [SEED] "${customerName}" → ${amount.toLocaleString()} SDG (${label}${nmSuffix})${note}${partsNote}`);
      perSection[row.sectionTag].invoices += parts.length;
      perSection[row.sectionTag].sdg += amount;
      totalSeeded = totalSeeded.add(new Prisma.Decimal(amount));
      invoicesCreated += parts.length;
      continue;
    }

    for (let partIdx = 0; partIdx < parts.length; partIdx++) {
      const partAmount = parts[partIdx];
      const inv = new Prisma.Decimal(partAmount);
      const partSuffix = parts.length > 1 ? `-part${partIdx + 1}` : '';
      const invoiceNumber = `PRE-SYS-APR2026-${row.sectionTag.toUpperCase()}-${timestamp}-${shortId}${partSuffix}`;

      await prisma.salesInvoice.create({
        data: {
          invoiceNumber,
          inventoryId: mainWarehouseId,
          section: invoiceSection,
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
          notes: parts.length > 1 ? `${notes} (جزء ${partIdx + 1})` : notes,
          createdAt: SEED_DATE,
          updatedAt: SEED_DATE,
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
      invoicesCreated++;
    }

    perSection[row.sectionTag].invoices += parts.length;
    perSection[row.sectionTag].sdg += amount;
    totalSeeded = totalSeeded.add(new Prisma.Decimal(amount));

    const partsNote = parts.length > 1 ? ` (${parts.length} parts)` : '';
    const note = match.matchNote ? ` [${match.matchNote}]` : '';
    console.log(`  ✓ "${customerName}" → ${amount.toLocaleString()} SDG${partsNote}${note}`);
  }

  return { invoicesCreated, newCustomers, totalSeeded, perSection };
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   APRIL 2026 DEBT RESET & SEED                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  MODE: DRY RUN — no database writes');
  else if (!CONFIRM) console.log('  MODE: PREVIEW — run with --confirm to write');
  else console.log('  MODE: LIVE — database will be modified');
  console.log(`  JSON: ${JSON_FILE}`);
  console.log();

  const rows = loadDebtRowsFromJson(JSON_FILE);

  const sectionCounts: Record<SectionTag, number> = { '1a': 0, '1b': 0, '2a': 0, '2b': 0 };
  for (const r of rows) sectionCounts[r.sectionTag]++;
  const nonMovingCount = rows.filter((r) => r.nonMoving).length;

  console.log(`Loaded ${rows.length} rows from JSON:`);
  console.log(`  1a: ${sectionCounts['1a']}  1b: ${sectionCounts['1b']}  2a: ${sectionCounts['2a']}  2b: ${sectionCounts['2b']}  (non-moving: ${nonMovingCount})`);
  console.log(`  Grand opening total: ${rows.reduce((s, r) => s + r.openingBalance, 0).toLocaleString()} SDG`);

  const prisma = new PrismaClient();

  try {
    await validateOverrides(prisma);

    // ── Find warehouse ─────────────────────────────────────
    const mainWarehouse = await prisma.inventory.findFirst({
      where: { OR: [{ name: { contains: 'رئيسي' } }, { name: 'المخزن الرئيسي' }] },
      select: { id: true, name: true },
    });
    if (!mainWarehouse) {
      throw new Error('Main warehouse not found. Make sure a warehouse named "رئيسي" or "المخزن الرئيسي" exists.');
    }
    console.log(`\n  Warehouse: ${mainWarehouse.name} (${mainWarehouse.id})`);

    // ── Find sales users ──────────────────────────────────
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
    console.log(`  Bakery user:  ${bakeryUser.username}`);
    console.log(`  Grocery user: ${groceryUser.username}`);

    // ── Match names ────────────────────────────────────────
    console.log('\nMatching names against existing customers...');
    const { matched, unmatchedReport } = await matchRows(prisma, rows);

    const exactCount = matched.filter((m) => !m.matchNote && !m.isNew).length;
    const fuzzyCount = matched.filter((m) => m.matchNote && !m.isNew && m.matchNote !== 'override').length;
    const overrideCount = matched.filter((m) => m.matchNote === 'override').length;
    const newCount = matched.filter((m) => m.isNew).length;
    console.log(`  Exact matches:     ${exactCount}`);
    console.log(`  Fuzzy matches:     ${fuzzyCount}`);
    console.log(`  Override matches:  ${overrideCount}`);
    console.log(`  New customers:     ${newCount}`);

    if (fuzzyCount > 0) {
      console.log('\n  Fuzzy match details:');
      matched
        .filter((m) => m.matchNote && !m.isNew && m.matchNote !== 'override')
        .forEach((m) => console.log(`    "${m.row.name}" → "${m.existingCustomerName}" [${m.matchNote}]`));
    }

    if (unmatchedReport.length > 0) {
      fs.writeFileSync(REPORT_FILE, JSON.stringify(unmatchedReport, null, 2), 'utf8');
      console.log(`\n  ⚠ ${unmatchedReport.length} unmatched/ambiguous rows → ${REPORT_FILE}`);
      console.log(`    Edit scripts/data/april-2026-debts/name-overrides.ts for these names.`);
    }

    // ── Dry-run diff lists ────────────────────────────────
    if (DRY_RUN || !CONFIRM) {
      console.log('\n── DRY-RUN DIFF LISTS ──');
      await writeDryRunLists(prisma, rows, matched);
    }

    // ── Reset phase ────────────────────────────────────────
    if (!NO_RESET) {
      await resetPhase(prisma);
    } else {
      console.log('\n[--no-reset] Skipping reset phase.');
    }

    // ── Seed phase ─────────────────────────────────────────
    const { invoicesCreated, newCustomers: nc, totalSeeded, perSection } = await seedPhase(
      prisma,
      matched,
      mainWarehouse.id,
      salesUserBySection,
    );

    // ── Final summary ──────────────────────────────────────
    console.log('\n══════════════════════════════════');
    console.log('SUMMARY');
    console.log('══════════════════════════════════');
    console.log(`  Section 1a (bakery whl):    ${perSection['1a'].invoices} invoices, ${perSection['1a'].sdg.toLocaleString()} SDG`);
    console.log(`  Section 1b (bakery agent):  ${perSection['1b'].invoices} invoices, ${perSection['1b'].sdg.toLocaleString()} SDG`);
    console.log(`  Section 2a (grocery whl):   ${perSection['2a'].invoices} invoices, ${perSection['2a'].sdg.toLocaleString()} SDG`);
    console.log(`  Section 2b (grocery ret):   ${perSection['2b'].invoices} invoices, ${perSection['2b'].sdg.toLocaleString()} SDG`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  Total invoices:  ${invoicesCreated}`);
    console.log(`  New customers:   ${nc}`);
    console.log(`  Total seeded:    ${totalSeeded.toFixed(2)} SDG`);
    if (DRY_RUN || !CONFIRM) {
      console.log('\n  Run with --confirm to apply the above changes.');
    } else {
      console.log('\n  ✅ Done. April 2026 opening balances seeded.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message ?? err);
  process.exit(1);
});
