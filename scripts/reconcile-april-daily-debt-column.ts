/**
 * Read-only reconciliation: compare JSON "المديونية" (new debt added per day)
 * against DB SalesInvoice totals per customer per day.
 *
 * Usage from apps/api:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/reconcile-april-daily-debt-column.ts
 *
 * Flags:
 *   --json=<path>             default: scripts/data/april-2026-debts/april-2026-debts.json
 *   --customer=<id>           only one DB customer id
 *   --date=YYYY-MM-DD         only one day
 *   --section=1a|1b|2a|2b     only one JSON section
 *   --tolerance=<amount>      default 0.01
 */

import { CustomerType, Prisma, PrismaClient, Section } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import type { AprilDebtsJson } from './extract-april-2026-debts-to-json';
import { NAME_OVERRIDES } from './data/april-2026-debts/name-overrides';

type SectionTag = '1a' | '1b' | '2a' | '2b';

interface ExcelDebtRow {
  sourceFile: string;
  section: SectionTag;
  rowNum: number | null;
  name: string;
  date: string;
  debt: Prisma.Decimal;
}

interface CustomerCandidate {
  id: string;
  name: string;
  type: CustomerType;
  division: Section;
  norm: string;
}

const prisma = new PrismaClient();
const ARGS = process.argv.slice(2);
const DATA_DIR = path.join(__dirname, 'data', 'april-2026-debts');
const JSON_FILE =
  ARGS.find((a) => a.startsWith('--json='))?.slice('--json='.length) ??
  path.join(DATA_DIR, 'april-2026-debts.json');
const CUSTOMER_FILTER = ARGS.find((a) => a.startsWith('--customer='))?.slice('--customer='.length) ?? null;
const DATE_FILTER = ARGS.find((a) => a.startsWith('--date='))?.slice('--date='.length) ?? null;
const SECTION_FILTER = ARGS.find((a) => a.startsWith('--section='))?.slice('--section='.length) as SectionTag | undefined;
const TOLERANCE = new Prisma.Decimal(
  ARGS.find((a) => a.startsWith('--tolerance='))?.slice('--tolerance='.length) ?? '0.01',
);
const REPORT_FILE = path.join(__dirname, 'april-daily-debt-reconciliation.json');

const SECTION_DEFAULTS: Record<SectionTag, { type: CustomerType; division: Section }> = {
  '1a': { type: CustomerType.WHOLESALE, division: Section.BAKERY },
  '1b': { type: CustomerType.AGENT_WHOLESALE, division: Section.BAKERY },
  '2a': { type: CustomerType.WHOLESALE, division: Section.GROCERY },
  '2b': { type: CustomerType.RETAIL, division: Section.GROCERY },
};

const SECTION_TYPE_GROUPS: Record<SectionTag, CustomerType[]> = {
  '1a': [CustomerType.WHOLESALE],
  '1b': [CustomerType.AGENT_WHOLESALE],
  '2a': [CustomerType.WHOLESALE, CustomerType.AGENT_WHOLESALE],
  '2b': [CustomerType.RETAIL, CustomerType.AGENT_RETAIL, CustomerType.BAKERY_CUSTOMER],
};

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

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayRange(dateStr: string): { gte: Date; lt: Date } {
  const gte = new Date(`${dateStr}T00:00:00.000Z`);
  const lt = new Date(gte);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte, lt };
}

function loadExcelDebtRows(): ExcelDebtRow[] {
  if (!fs.existsSync(JSON_FILE)) {
    throw new Error(`JSON file not found: ${JSON_FILE}\nRun first: npm run script:extract-april-debts`);
  }
  const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')) as AprilDebtsJson;
  const rows: ExcelDebtRow[] = [];
  for (const customer of data.customers) {
    if (SECTION_FILTER && customer.section !== SECTION_FILTER) continue;
    for (const day of customer.daily) {
      if (DATE_FILTER && day.date !== DATE_FILTER) continue;
      if (day.debt <= 0) continue;
      rows.push({
        sourceFile: customer.sourceFile,
        section: customer.section as SectionTag,
        rowNum: customer.rowNum,
        name: customer.name,
        date: day.date,
        debt: new Prisma.Decimal(day.debt),
      });
    }
  }
  return rows;
}

function chooseCustomer(
  row: ExcelDebtRow,
  normalized: CustomerCandidate[],
  byId: Map<string, CustomerCandidate>,
): { customer: CustomerCandidate | null; note: string; candidates: CustomerCandidate[] } {
  const override = NAME_OVERRIDES[row.name.trim()];
  if (override !== undefined) {
    const overrideId =
      typeof override === 'string' && override.length > 0
        ? override
        : typeof override === 'object' && 'customerId' in override
          ? override.customerId
          : null;
    if (overrideId) {
      const c = byId.get(overrideId);
      if (c) return { customer: c, note: 'override', candidates: [] };
      return { customer: null, note: 'stale-override-id', candidates: [] };
    }
    // Empty/create overrides are useful before seeding. After seeding, prefer an
    // exact DB match in the row's intended section so the reconciler stays rerunnable.
  }

  const query = normalizeArabic(row.name);
  const defaults = SECTION_DEFAULTS[row.section];
  const preferredTypes = SECTION_TYPE_GROUPS[row.section];
  let candidates = normalized.filter((c) => c.norm === query);
  let note = 'exact';

  if (candidates.length === 0) {
    candidates = normalized.filter((c) => levenshtein(c.norm, query) <= 2);
    note = 'levenshtein<=2';
  }

  if (candidates.length === 0 && query.length >= 8) {
    candidates = normalized.filter(
      (c) => c.norm.length >= 8 && (c.norm.includes(query) || query.includes(c.norm)),
    );
    note = 'substring';
  }

  if (candidates.length > 1) {
    const typeFiltered = candidates.filter((c) => preferredTypes.includes(c.type));
    if (typeFiltered.length > 0) candidates = typeFiltered;
    const divisionFiltered = candidates.filter((c) => c.division === defaults.division);
    if (divisionFiltered.length > 0) candidates = divisionFiltered;
  }

  if (candidates.length === 1) return { customer: candidates[0], note, candidates: [] };
  return {
    customer: null,
    note: candidates.length > 1 ? 'multiple-candidates' : 'no-match',
    candidates,
  };
}

async function main(): Promise<void> {
  console.log('APRIL DAILY DEBT COLUMN RECONCILIATION (read-only)');
  console.log('='.repeat(78));
  console.log(`JSON:      ${JSON_FILE}`);
  console.log(`Customer:  ${CUSTOMER_FILTER ?? '(all)'}`);
  console.log(`Date:      ${DATE_FILTER ?? '(April 2026)'}`);
  console.log(`Section:   ${SECTION_FILTER ?? '(all)'}`);
  console.log(`Tolerance: ${TOLERANCE.toFixed(2)}`);

  const excelRows = loadExcelDebtRows();
  const customers = await prisma.customer.findMany({
    select: { id: true, name: true, type: true, division: true },
  });
  const normalized: CustomerCandidate[] = customers.map((c) => ({
    ...c,
    norm: normalizeArabic(c.name),
  }));
  const byId = new Map(normalized.map((c) => [c.id, c]));

  const excelByCustomerDay = new Map<
    string,
    { customerId: string; customerName: string; date: string; excelDebt: Prisma.Decimal; rows: ExcelDebtRow[]; matchNote: string }
  >();
  const unmatched: any[] = [];
  let excelTotal = new Prisma.Decimal(0);

  for (const row of excelRows) {
    const match = chooseCustomer(row, normalized, byId);
    if (!match.customer) {
      unmatched.push({
        sourceFile: row.sourceFile,
        section: row.section,
        rowNum: row.rowNum,
        name: row.name,
        date: row.date,
        debt: row.debt.toFixed(2),
        reason: match.note,
        candidates: match.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type, division: c.division })),
      });
      continue;
    }
    if (CUSTOMER_FILTER && match.customer.id !== CUSTOMER_FILTER) continue;
    const key = `${match.customer.id}|${row.date}`;
    const current = excelByCustomerDay.get(key) ?? {
      customerId: match.customer.id,
      customerName: match.customer.name,
      date: row.date,
      excelDebt: new Prisma.Decimal(0),
      rows: [],
      matchNote: match.note,
    };
    current.excelDebt = current.excelDebt.add(row.debt);
    current.rows.push(row);
    excelByCustomerDay.set(key, current);
    excelTotal = excelTotal.add(row.debt);
  }

  const invoiceWhere: Prisma.SalesInvoiceWhereInput = {
    createdAt: DATE_FILTER
      ? { gte: dayRange(DATE_FILTER).gte, lt: dayRange(DATE_FILTER).lt }
      : { gte: new Date('2026-04-01T00:00:00.000Z'), lt: new Date('2026-05-01T00:00:00.000Z') },
    paymentConfirmationStatus: { not: 'REJECTED' },
    NOT: { invoiceNumber: { startsWith: 'PRE-SYS-' } },
    ...(CUSTOMER_FILTER ? { customerId: CUSTOMER_FILTER } : {}),
  };

  const invoices = await prisma.salesInvoice.findMany({
    where: invoiceWhere,
    select: {
      id: true,
      invoiceNumber: true,
      createdAt: true,
      total: true,
      customerId: true,
      customer: { select: { id: true, name: true } },
    },
  });

  const dbByCustomerDay = new Map<
    string,
    { customerId: string | null; customerName: string; date: string; dbTotal: Prisma.Decimal; invoiceCount: number; invoices: string[] }
  >();
  let dbTotal = new Prisma.Decimal(0);

  for (const inv of invoices) {
    if (!inv.customerId) continue;
    const date = ymd(inv.createdAt);
    const key = `${inv.customerId}|${date}`;
    const current = dbByCustomerDay.get(key) ?? {
      customerId: inv.customerId,
      customerName: inv.customer?.name ?? '(no customer)',
      date,
      dbTotal: new Prisma.Decimal(0),
      invoiceCount: 0,
      invoices: [],
    };
    current.dbTotal = current.dbTotal.add(inv.total);
    current.invoiceCount++;
    current.invoices.push(inv.invoiceNumber);
    dbByCustomerDay.set(key, current);
    dbTotal = dbTotal.add(inv.total);
  }

  const mismatches: any[] = [];
  const missingInDb: any[] = [];
  for (const [key, expected] of excelByCustomerDay) {
    const actual = dbByCustomerDay.get(key);
    const actualTotal = actual?.dbTotal ?? new Prisma.Decimal(0);
    const diff = actualTotal.sub(expected.excelDebt);
    if (diff.abs().greaterThan(TOLERANCE)) {
      const row = {
        customerId: expected.customerId,
        customerName: expected.customerName,
        date: expected.date,
        excelDebt: expected.excelDebt.toFixed(2),
        dbInvoiceTotal: actualTotal.toFixed(2),
        differenceDbMinusExcel: diff.toFixed(2),
        excelRows: expected.rows.map((r) => ({ sourceFile: r.sourceFile, section: r.section, rowNum: r.rowNum, name: r.name, debt: r.debt.toFixed(2) })),
        dbInvoiceCount: actual?.invoiceCount ?? 0,
        invoices: actual?.invoices ?? [],
        matchNote: expected.matchNote,
      };
      mismatches.push(row);
      if (!actual) missingInDb.push(row);
    }
  }

  const dbExtras = Array.from(dbByCustomerDay.entries())
    .filter(([key]) => !excelByCustomerDay.has(key))
    .map(([, actual]) => ({
      customerId: actual.customerId,
      customerName: actual.customerName,
      date: actual.date,
      dbInvoiceTotal: actual.dbTotal.toFixed(2),
      dbInvoiceCount: actual.invoiceCount,
      invoices: actual.invoices,
    }));

  mismatches.sort((a, b) => Math.abs(parseFloat(b.differenceDbMinusExcel)) - Math.abs(parseFloat(a.differenceDbMinusExcel)));
  dbExtras.sort((a, b) => parseFloat(b.dbInvoiceTotal) - parseFloat(a.dbInvoiceTotal));

  const customerAgg = new Map<string, { customerId: string; customerName: string; excelDebt: Prisma.Decimal; dbTotal: Prisma.Decimal }>();
  for (const row of excelByCustomerDay.values()) {
    const current = customerAgg.get(row.customerId) ?? {
      customerId: row.customerId,
      customerName: row.customerName,
      excelDebt: new Prisma.Decimal(0),
      dbTotal: new Prisma.Decimal(0),
    };
    current.excelDebt = current.excelDebt.add(row.excelDebt);
    current.dbTotal = current.dbTotal.add(dbByCustomerDay.get(`${row.customerId}|${row.date}`)?.dbTotal ?? 0);
    customerAgg.set(row.customerId, current);
  }
  const customerMismatches = Array.from(customerAgg.values())
    .map((row) => ({
      customerId: row.customerId,
      customerName: row.customerName,
      excelDebt: row.excelDebt.toFixed(2),
      dbInvoiceTotal: row.dbTotal.toFixed(2),
      differenceDbMinusExcel: row.dbTotal.sub(row.excelDebt).toFixed(2),
    }))
    .filter((row) => new Prisma.Decimal(row.differenceDbMinusExcel).abs().greaterThan(TOLERANCE))
    .sort((a, b) => Math.abs(parseFloat(b.differenceDbMinusExcel)) - Math.abs(parseFloat(a.differenceDbMinusExcel)));

  const payload = {
    json: JSON_FILE,
    filters: { customer: CUSTOMER_FILTER, date: DATE_FILTER, section: SECTION_FILTER },
    tolerance: TOLERANCE.toFixed(2),
    summary: {
      excelDebtRows: excelRows.length,
      matchedCustomerDays: excelByCustomerDay.size,
      unmatchedRows: unmatched.length,
      excelDebtTotal: excelTotal.toFixed(2),
      dbNewDebtTotal: dbTotal.toFixed(2),
      totalDifferenceDbMinusExcel: dbTotal.sub(excelTotal).toFixed(2),
      mismatchedCustomerDays: mismatches.length,
      missingInDb: missingInDb.length,
      dbExtraCustomerDays: dbExtras.length,
      customerAggregateMismatches: customerMismatches.length,
    },
    topMismatches: mismatches.slice(0, 25),
    customerMismatches,
    dbExtras,
    unmatched,
    mismatches,
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log('-'.repeat(78));
  console.log(`Excel debt total:        ${payload.summary.excelDebtTotal} SDG`);
  console.log(`DB new-debt total:       ${payload.summary.dbNewDebtTotal} SDG`);
  console.log(`DB - Excel difference:   ${payload.summary.totalDifferenceDbMinusExcel} SDG`);
  console.log(`Unmatched Excel rows:    ${payload.summary.unmatchedRows}`);
  console.log(`Mismatched days:         ${payload.summary.mismatchedCustomerDays}`);
  console.log(`Customer mismatches:     ${payload.summary.customerAggregateMismatches}`);
  console.log(`DB-side extras:          ${payload.summary.dbExtraCustomerDays}`);

  if (mismatches.length > 0) {
    console.log('\nTop mismatches:');
    for (const row of mismatches.slice(0, 25)) {
      console.log(`  ${row.date} ${row.customerName}: Excel ${row.excelDebt} / DB ${row.dbInvoiceTotal} / Diff ${row.differenceDbMinusExcel}`);
    }
  }

  if (dbExtras.length > 0) {
    console.log('\nDB-side extras:');
    for (const row of dbExtras.slice(0, 25)) {
      console.log(`  ${row.date} ${row.customerName}: ${row.dbInvoiceTotal} (${row.dbInvoiceCount} invoices)`);
    }
  }

  console.log(`\nReport written: ${REPORT_FILE}`);
  console.log('='.repeat(78));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
