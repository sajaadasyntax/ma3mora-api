/**
 * seed-april-2026-debts.ts
 *
 * Resets all pre-April-2026 carry-over debts and re-seeds them from two Excel
 * sheets (April 1 opening balances).
 *
 * Usage:
 *   --dry-run           Parse, match, print plan — no DB writes
 *   --confirm           Required to execute destructive writes
 *   --no-reset          Skip the delete phase, only seed
 *   --file1=<path>      Override first workbook (default: scripts/data/april-2026-debts/debts-25kg-april-2026.xlsx)
 *   --file2=<path>      Override second workbook (default: .../debts-products-april-2026.xlsx)
 *
 * Quick start (from apps/api):
 *   npm run script:seed-april-debts
 *   npm run script:seed-april-debts:apply
 *
 * If `npx tsx` fails with "Permission denied" (strict .bin permissions or noexec),
 * run the CLI directly:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/seed-april-2026-debts.ts --dry-run
 */

import ExcelJS from 'exceljs';
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

// ═══════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const NO_RESET = ARGS.includes('--no-reset');
const CONFIRM = ARGS.includes('--confirm');

/** Committed copies live next to this script: scripts/data/april-2026-debts/ */
const DEFAULT_DEBT_DATA_DIR = path.join(__dirname, 'data', 'april-2026-debts');
const DEFAULT_FILE1 = path.join(DEFAULT_DEBT_DATA_DIR, 'debts-25kg-april-2026.xlsx');
const DEFAULT_FILE2 = path.join(DEFAULT_DEBT_DATA_DIR, 'debts-products-april-2026.xlsx');

const FILE1 =
  ARGS.find((a) => a.startsWith('--file1='))?.slice('--file1='.length) ?? DEFAULT_FILE1;
const FILE2 =
  ARGS.find((a) => a.startsWith('--file2='))?.slice('--file2='.length) ?? DEFAULT_FILE2;

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
/** Prisma Decimal limit is 15,2 → max safe value per invoice */
const MAX_SAFE_AMOUNT = 99_999_999.99;

/** Bail out if we would delete more rows than this (safety net) */
const MAX_SAFE_DELETE = 10_000;

/**
 * All invoices/orders created *before* this date that are still unpaid are
 * considered legacy carry-over and will be deleted.
 */
const APRIL_1 = new Date('2026-04-01T00:00:00.000Z');

/** New seed invoices will carry this createdAt so aggregates treat them as opening balance */
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
}

interface MatchResult {
  row: DebtRow;
  /** null means we will create a new customer */
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
    .replace(/ـ/g, '')                       // tatweel
    .replace(/[\u064B-\u0652\u0670]/g, '')   // diacritics + superscript alef
    .replace(/[أإآٱ]/g, 'ا')                 // alef variants
    .replace(/ى/g, 'ي')                      // alef maqsura
    .replace(/ة/g, 'ه')                      // taa marbouta
    .replace(/ؤ/g, 'و')                      // waw hamza
    .replace(/ئ/g, 'ي')                      // ya hamza
    .replace(/\u06A9/g, 'ك')                 // Farsi kaf -> Arabic kaf
    .replace(/\u06CC/g, 'ي')                 // Farsi ye -> Arabic ye
    .replace(/[-.\u060C,/()]/g, ' ')         // punctuation -> space
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
// CELL VALUE HELPERS
// ═══════════════════════════════════════════════════════════

/** Safely extract a numeric value from an exceljs cell value (handles formula results) */
function cellNum(v: ExcelJS.CellValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in (v as any)) {
    const r = (v as any).result;
    if (typeof r === 'number') return r;
  }
  return null;
}

/** Safely extract a string from a cell value */
function cellStr(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && 'text' in (v as any)) {
    const t = (v as any).text;
    return typeof t === 'string' ? t.trim() || null : null;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// EXCEL PARSERS
// ═══════════════════════════════════════════════════════════

/**
 * Parse ديون 25 كيلو.xlsx
 * Sheet structure: two sections separated by a repeated header row where cell A = 'الرقم'.
 * Section 1a → BAKERY WHOLESALE
 * Section 1b → GROCERY AGENT_WHOLESALE
 */
async function parseFile1(filePath: string): Promise<DebtRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows: DebtRow[] = [];
  let currentSection: SectionTag = '1a';
  let headerCount = 0;

  ws.eachRow({ includeEmpty: false }, (row) => {
    const v = row.values as ExcelJS.CellValue[];
    // exceljs row.values is 1-indexed: v[1]=colA, v[2]=colB, v[3]=colC
    const colA = v[1];
    const colB = v[2];
    const colC = v[3];

    // Section boundary: col A is the string 'الرقم'
    const aStr = cellStr(colA);
    if (aStr === 'الرقم') {
      headerCount++;
      currentSection = headerCount <= 1 ? '1a' : '1b';
      return;
    }

    // Data row: col A is an integer row number, col B is a customer name
    const aNum = cellNum(colA);
    const bStr = cellStr(colB);
    if (aNum !== null && Number.isInteger(aNum) && bStr) {
      const opening = cellNum(colC) ?? 0;
      if (opening > 0) {
        rows.push({
          rowNum: aNum,
          name: bStr,
          openingBalance: opening,
          sectionTag: currentSection,
        });
      }
    }
  });

  return rows;
}

/**
 * Parse ديون شهر 4 المنتجات.xlsx
 * Sheet structure: two sections.
 * First section header: a row where col B contains 'مديونية منتجات الجملة' (or file starts with section 2a implicitly).
 * Second section header: a row where col B contains 'قطاعي'.
 * Section 2a → GROCERY WHOLESALE
 * Section 2b → GROCERY RETAIL
 */
async function parseFile2(filePath: string): Promise<DebtRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows: DebtRow[] = [];
  let currentSection: SectionTag = '2a';

  ws.eachRow({ includeEmpty: false }, (row) => {
    const v = row.values as ExcelJS.CellValue[];
    const colA = v[1];
    const colB = v[2];
    const colC = v[3];

    const bStr = cellStr(colB);

    // Detect section 2b boundary: col B contains 'قطاعي'
    if (bStr && bStr.includes('قطاعي')) {
      currentSection = '2b';
      return;
    }

    // Data row: col A is an integer, col B is a name
    const aNum = cellNum(colA);
    if (aNum !== null && Number.isInteger(aNum) && bStr) {
      const opening = cellNum(colC) ?? 0;
      if (opening > 0) {
        rows.push({
          rowNum: aNum,
          name: bStr,
          openingBalance: opening,
          sectionTag: currentSection,
        });
      }
    }
  });

  return rows;
}

// ═══════════════════════════════════════════════════════════
// SECTION HELPERS
// ═══════════════════════════════════════════════════════════

function sectionToDivision(tag: SectionTag): Section {
  return tag === '1a' ? Section.BAKERY : Section.GROCERY;
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
  return tag === '1a' ? Section.BAKERY : Section.GROCERY;
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
    const normQuery = normalizeArabic(row.name);
    const targetDivision = sectionToDivision(row.sectionTag);
    let candidates = normalizedDb.filter((c) => false); // empty start
    let matchNote = '';

    // Step 1: exact normalized match
    const exact = normalizedDb.filter((c) => c.normalized === normQuery);
    if (exact.length > 0) { candidates = exact; matchNote = 'exact'; }

    // Step 2: Levenshtein ≤ 2
    if (candidates.length === 0) {
      const lev = normalizedDb.filter((c) => levenshtein(c.normalized, normQuery) <= 2);
      if (lev.length > 0) { candidates = lev; matchNote = 'levenshtein≤2'; }
    }

    // Step 3: substring (min 8 chars both sides)
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
// RESET PHASE
// ═══════════════════════════════════════════════════════════

async function resetPhase(prisma: PrismaClient): Promise<void> {
  console.log('\n══════════════════════════════════');
  console.log('RESET PHASE');
  console.log('══════════════════════════════════');

  // ── Find target SalesInvoices ──────────────────────────────
  const preSysInvoices = await prisma.salesInvoice.findMany({
    where: { invoiceNumber: { startsWith: 'PRE-SYS-' } },
    select: { id: true, invoiceNumber: true, total: true, paidAmount: true },
  });

  const preAprilAllInvoices = await prisma.salesInvoice.findMany({
    where: {
      createdAt: { lt: APRIL_1 },
      NOT: { invoiceNumber: { startsWith: 'PRE-SYS-' } },
    },
    select: { id: true, invoiceNumber: true, total: true, paidAmount: true, createdAt: true },
  });

  const preAprilUnpaidInvoices = preAprilAllInvoices.filter((inv) =>
    new Prisma.Decimal(inv.total).greaterThan(new Prisma.Decimal(inv.paidAmount)),
  );

  const invoiceIdSet = new Set<string>([
    ...preSysInvoices.map((i) => i.id),
    ...preAprilUnpaidInvoices.map((i) => i.id),
  ]);
  const invoiceIds = Array.from(invoiceIdSet);

  // Outstanding receivables being deleted
  const outstandingInvoices = [
    ...preSysInvoices,
    ...preAprilUnpaidInvoices,
  ].reduce((sum, inv) => {
    const outstanding = new Prisma.Decimal(inv.total).sub(new Prisma.Decimal(inv.paidAmount));
    return sum.add(outstanding.greaterThan(0) ? outstanding : new Prisma.Decimal(0));
  }, new Prisma.Decimal(0));

  console.log(`  PRE-SYS-* SalesInvoices:          ${preSysInvoices.length}`);
  console.log(`  Unpaid pre-April SalesInvoices:    ${preAprilUnpaidInvoices.length}`);
  console.log(`  Total SalesInvoices to delete:     ${invoiceIds.length}`);
  console.log(`  Outstanding receivables deleted:   ${outstandingInvoices.toFixed(2)} SDG`);

  // ── Find target ProcOrders ─────────────────────────────────
  const preSysProcOrders = await prisma.procOrder.findMany({
    where: { orderNumber: { startsWith: 'PRE-SYS-PO-' } },
    select: { id: true, orderNumber: true, total: true, paidAmount: true },
  });

  const preAprilAllPO = await prisma.procOrder.findMany({
    where: {
      createdAt: { lt: APRIL_1 },
      NOT: { orderNumber: { startsWith: 'PRE-SYS-PO-' } },
    },
    select: { id: true, orderNumber: true, total: true, paidAmount: true },
  });

  const preAprilUnpaidPO = preAprilAllPO.filter((po) =>
    new Prisma.Decimal(po.total).greaterThan(new Prisma.Decimal(po.paidAmount)),
  );

  const poIdSet = new Set<string>([
    ...preSysProcOrders.map((p) => p.id),
    ...preAprilUnpaidPO.map((p) => p.id),
  ]);
  const poIds = Array.from(poIdSet);

  const outstandingPO = [...preSysProcOrders, ...preAprilUnpaidPO].reduce((sum, po) => {
    const outstanding = new Prisma.Decimal(po.total).sub(new Prisma.Decimal(po.paidAmount));
    return sum.add(outstanding.greaterThan(0) ? outstanding : new Prisma.Decimal(0));
  }, new Prisma.Decimal(0));

  console.log(`  PRE-SYS-PO-* ProcOrders:           ${preSysProcOrders.length}`);
  console.log(`  Unpaid pre-April ProcOrders:        ${preAprilUnpaidPO.length}`);
  console.log(`  Total ProcOrders to delete:         ${poIds.length}`);
  console.log(`  Outstanding payables deleted:       ${outstandingPO.toFixed(2)} SDG`);

  // ── Opening Balances ───────────────────────────────────────
  const obCount = await prisma.openingBalance.count({
    where: { scope: { in: ['CUSTOMER', 'SUPPLIER'] } },
  });
  console.log(`  OpeningBalances to delete:          ${obCount}`);

  // ── Safety check ───────────────────────────────────────────
  const totalRows = invoiceIds.length + poIds.length + obCount;
  if (totalRows > MAX_SAFE_DELETE) {
    throw new Error(
      `\nSafety check FAILED: would delete ${totalRows} rows (limit: ${MAX_SAFE_DELETE}).\n` +
        `Review the numbers above and increase MAX_SAFE_DELETE if intentional.`,
    );
  }

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] No changes made.');
    return;
  }

  if (!CONFIRM) {
    console.log('\n  Run with --confirm to execute the reset phase.');
    return;
  }

  // ── Execute ────────────────────────────────────────────────
  console.log('\n  Executing deletions...');

  // Delete SalesInvoices in batches — cascade handles children automatically
  const BATCH = 500;
  let deletedInvoices = 0;
  for (let i = 0; i < invoiceIds.length; i += BATCH) {
    const batch = invoiceIds.slice(i, i + BATCH);
    const result = await prisma.salesInvoice.deleteMany({ where: { id: { in: batch } } });
    deletedInvoices += result.count;
  }
  console.log(`  ✓ Deleted ${deletedInvoices} SalesInvoices`);

  // Delete ProcOrders in batches — cascade handles items/payments/receipts
  let deletedPO = 0;
  for (let i = 0; i < poIds.length; i += BATCH) {
    const batch = poIds.slice(i, i + BATCH);
    const result = await prisma.procOrder.deleteMany({ where: { id: { in: batch } } });
    deletedPO += result.count;
  }
  console.log(`  ✓ Deleted ${deletedPO} ProcOrders`);

  // Delete OpeningBalances
  const obDeleted = await prisma.openingBalance.deleteMany({
    where: { scope: { in: ['CUSTOMER', 'SUPPLIER'] } },
  });
  console.log(`  ✓ Deleted ${obDeleted.count} OpeningBalances`);

  // Invalidate pre-April cumulative aggregates so they recompute cleanly
  const caDeleted = await prisma.customerCumulativeAggregate.deleteMany({
    where: { date: { lt: APRIL_1 } },
  });
  const saDeleted = await prisma.supplierCumulativeAggregate.deleteMany({
    where: { date: { lt: APRIL_1 } },
  });
  console.log(
    `  ✓ Invalidated ${caDeleted.count} CustomerCumulativeAggregates + ${saDeleted.count} SupplierCumulativeAggregates`,
  );
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

    // ── Resolve customer ───────────────────────────────────
    let customerId: string;
    let customerName: string;

    if (!isNew && existingCustomerId) {
      customerId = existingCustomerId;
      customerName = existingCustomerName!;
    } else {
      // New customer
      if (DRY_RUN || !CONFIRM) {
        const note = match.matchNote ? ` [${match.matchNote}]` : '';
        console.log(
          `  [NEW] "${row.name}" (${sectionLabel(row.sectionTag)}) → ${row.openingBalance.toLocaleString()} SDG${note}`,
        );
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

    // ── Determine invoice metadata ─────────────────────────
    const invoiceSection = sectionToInvoiceSection(row.sectionTag);
    const lateItem = invoiceSection === Section.BAKERY ? lateItemBakery : lateItemGrocery;
    const salesUserId =
      salesUserBySection.get(invoiceSection) ??
      salesUserBySection.get(Section.GROCERY) ??
      [...salesUserBySection.values()][0];
    const shortId = customerId.slice(-6);
    const timestamp = Date.now();
    const label = sectionLabel(row.sectionTag);
    const notes = `رصيد افتتاحي 2026-04-01 - ${label}`;

    // ── Split if amount exceeds Decimal(15,2) limit ────────
    const amount = row.openingBalance;
    const parts = amount > MAX_SAFE_AMOUNT ? splitAmount(amount) : [amount];

    if (DRY_RUN || !CONFIRM) {
      const note = match.matchNote ? ` [${match.matchNote}]` : '';
      const partsNote = parts.length > 1 ? ` (split into ${parts.length} invoices)` : '';
      console.log(
        `  [SEED] "${customerName}" → ${amount.toLocaleString()} SDG (${label})${note}${partsNote}`,
      );
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

/** Split an amount into chunks of MAX_SAFE_AMOUNT */
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
// MAIN
// ═══════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   APRIL 2026 DEBT RESET & SEED                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  if (DRY_RUN) console.log('  MODE: DRY RUN — no database writes');
  else if (!CONFIRM) console.log('  MODE: PREVIEW — run with --confirm to write');
  else console.log('  MODE: LIVE — database will be modified');
  console.log(`  File 1: ${FILE1}`);
  console.log(`  File 2: ${FILE2}`);
  console.log();

  // Verify files exist
  for (const [label, fpath] of [['File 1', FILE1], ['File 2', FILE2]] as [string, string][]) {
    if (!fs.existsSync(fpath)) {
      console.error(`✗ ${label} not found: ${fpath}`);
      console.error('  Use --file1=<path> and/or --file2=<path> to override.');
      process.exit(1);
    }
  }

  const prisma = new PrismaClient();

  try {
    // ── Parse Excel files ────────────────────────────────────
    console.log('Parsing Excel files...');
    const rows1 = await parseFile1(FILE1);
    const rows2 = await parseFile2(FILE2);
    const allRows = [...rows1, ...rows2];

    console.log(`  File 1: ${rows1.length} rows (${rows1.filter(r => r.sectionTag === '1a').length} section-1a, ${rows1.filter(r => r.sectionTag === '1b').length} section-1b)`);
    console.log(`  File 2: ${rows2.length} rows (${rows2.filter(r => r.sectionTag === '2a').length} section-2a, ${rows2.filter(r => r.sectionTag === '2b').length} section-2b)`);
    console.log(`  Total:  ${allRows.length} rows`);

    const grandOpeningTotal = allRows.reduce((s, r) => s + r.openingBalance, 0);
    console.log(`  Grand opening balance total: ${grandOpeningTotal.toLocaleString()} SDG`);

    // ── Find warehouse ───────────────────────────────────────
    const mainWarehouse = await prisma.inventory.findFirst({
      where: { OR: [{ name: { contains: 'رئيسي' } }, { name: 'المخزن الرئيسي' }] },
      select: { id: true, name: true },
    });
    if (!mainWarehouse) {
      throw new Error('Main warehouse not found. Make sure a warehouse named "رئيسي" or "المخزن الرئيسي" exists.');
    }
    console.log(`\n  Warehouse: ${mainWarehouse.name} (${mainWarehouse.id})`);

    // ── Find sales users ─────────────────────────────────────
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

    // ── Match names ──────────────────────────────────────────
    console.log('\nMatching names against existing customers...');
    const { matched, unmatchedReport } = await matchRows(prisma, allRows);

    const exactCount = matched.filter((m) => !m.matchNote && !m.isNew).length;
    const fuzzyCount = matched.filter((m) => m.matchNote && !m.isNew).length;
    const newCount = matched.filter((m) => m.isNew).length;
    console.log(`  Exact matches:     ${exactCount}`);
    console.log(`  Fuzzy matches:     ${fuzzyCount}`);
    console.log(`  New customers:     ${newCount}`);

    if (fuzzyCount > 0) {
      console.log('\n  Fuzzy match details:');
      matched
        .filter((m) => m.matchNote && !m.isNew)
        .forEach((m) =>
          console.log(`    "${m.row.name}" → "${m.existingCustomerName}" [${m.matchNote}]`),
        );
    }

    if (unmatchedReport.length > 0) {
      fs.writeFileSync(REPORT_FILE, JSON.stringify(unmatchedReport, null, 2), 'utf8');
      console.log(`\n  ⚠ ${unmatchedReport.length} unmatched/ambiguous rows → ${REPORT_FILE}`);
      console.log('    New customers will be created for these.');
    }

    // ── Reset phase ──────────────────────────────────────────
    if (!NO_RESET) {
      await resetPhase(prisma);
    } else {
      console.log('\n[--no-reset] Skipping reset phase.');
    }

    // ── Seed phase ───────────────────────────────────────────
    const { invoicesCreated, newCustomers: nc, totalSeeded, perSection } = await seedPhase(
      prisma,
      matched,
      mainWarehouse.id,
      salesUserBySection,
    );

    // ── Final summary ────────────────────────────────────────
    console.log('\n══════════════════════════════════');
    console.log('SUMMARY');
    console.log('══════════════════════════════════');
    console.log(`  Section 1a (25kg group 1):  ${perSection['1a'].invoices} invoices, ${perSection['1a'].sdg.toLocaleString()} SDG`);
    console.log(`  Section 1b (25kg group 2):  ${perSection['1b'].invoices} invoices, ${perSection['1b'].sdg.toLocaleString()} SDG`);
    console.log(`  Section 2a (products jml):  ${perSection['2a'].invoices} invoices, ${perSection['2a'].sdg.toLocaleString()} SDG`);
    console.log(`  Section 2b (products ret):  ${perSection['2b'].invoices} invoices, ${perSection['2b'].sdg.toLocaleString()} SDG`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  Total invoices:  ${invoicesCreated}`);
    console.log(`  New customers:   ${nc}`);
    console.log(`  Total seeded:    ${totalSeeded.toFixed(2)} SDG`);
    if (DRY_RUN || !CONFIRM) {
      console.log('\n  Run with --confirm to apply the above changes.');
    } else {
      console.log('\n  ✅ Done. Debt reset and April 2026 opening balances seeded.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message ?? err);
  process.exit(1);
});
