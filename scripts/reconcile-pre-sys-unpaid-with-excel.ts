/**
 * Read-only reconciliation: compare April-1 Excel debt balances with current
 * unpaid PRE-SYS sales invoices in the database.
 *
 * The Excel parser intentionally matches seed-april-2026-debts.ts:
 *   - reads only column C ("رصيد افتتاحي")
 *   - parses both files into the same four source sections
 *   - matches Arabic customer names to current Customer rows
 *
 * Usage from apps/api:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/reconcile-pre-sys-unpaid-with-excel.ts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/reconcile-pre-sys-unpaid-with-excel.ts --file1=... --file2=...
 *   node ./node_modules/tsx/dist/cli.mjs scripts/reconcile-pre-sys-unpaid-with-excel.ts --json
 */

import ExcelJS from 'exceljs';
import { Prisma, PrismaClient, Section } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

type SectionTag = '1a' | '1b' | '2a' | '2b';

interface DebtRow {
  rowNum: number | null;
  name: string;
  openingBalance: number;
  sectionTag: SectionTag;
  sourceFile: string;
}

interface CustomerMatch {
  id: string | null;
  name: string | null;
  note: string;
  candidates: string[];
}

const ARGS = process.argv.slice(2);
const DEFAULT_DIR = path.join(__dirname, 'data', 'april-2026-debts');
const FILE1 =
  ARGS.find((a) => a.startsWith('--file1='))?.slice('--file1='.length) ??
  path.join(DEFAULT_DIR, 'debts-25kg-april-2026.xlsx');
const FILE2 =
  ARGS.find((a) => a.startsWith('--file2='))?.slice('--file2='.length) ??
  path.join(DEFAULT_DIR, 'debts-products-april-2026.xlsx');
const PREFIX = ARGS.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length) ?? 'PRE-SYS';
const JSON_OUTPUT = ARGS.includes('--json');
const INCLUDE_REJECTED = ARGS.includes('--include-rejected');
const TOLERANCE = new Prisma.Decimal(
  ARGS.find((a) => a.startsWith('--tolerance='))?.slice('--tolerance='.length) ?? '0.01',
);

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

function cellNum(v: ExcelJS.CellValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in (v as any)) {
    const r = (v as any).result;
    if (typeof r === 'number') return r;
  }
  return null;
}

function cellStr(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && 'text' in (v as any)) {
    const t = (v as any).text;
    return typeof t === 'string' ? t.trim() || null : null;
  }
  return null;
}

async function parseFile1(filePath: string): Promise<DebtRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows: DebtRow[] = [];
  let currentSection: SectionTag = '1a';
  let headerCount = 0;

  ws.eachRow({ includeEmpty: false }, (row) => {
    const v = row.values as ExcelJS.CellValue[];
    const colA = v[1];
    const colB = v[2];
    const colC = v[3];
    const aStr = cellStr(colA);

    if (aStr === 'الرقم') {
      headerCount++;
      currentSection = headerCount <= 1 ? '1a' : '1b';
      return;
    }

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
          sourceFile: path.basename(filePath),
        });
      }
    }
  });

  return rows;
}

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

    if (bStr && bStr.includes('قطاعي')) {
      currentSection = '2b';
      return;
    }

    const aNum = cellNum(colA);
    if (aNum !== null && Number.isInteger(aNum) && bStr) {
      const opening = cellNum(colC) ?? 0;
      if (opening > 0) {
        rows.push({
          rowNum: aNum,
          name: bStr,
          openingBalance: opening,
          sectionTag: currentSection,
          sourceFile: path.basename(filePath),
        });
      }
    }
  });

  return rows;
}

function sectionToDivision(tag: SectionTag): Section {
  return tag === '1a' ? Section.BAKERY : Section.GROCERY;
}

async function loadExcelRows(): Promise<DebtRow[]> {
  for (const file of [FILE1, FILE2]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Excel file not found: ${file}`);
    }
  }

  const [rows1, rows2] = await Promise.all([parseFile1(FILE1), parseFile2(FILE2)]);
  return [...rows1, ...rows2];
}

async function buildMatcher() {
  const customers = await prisma.customer.findMany({
    select: { id: true, name: true, division: true },
  });
  const normalized = customers.map((c) => ({
    ...c,
    normalized: normalizeArabic(c.name),
  }));

  return (row: DebtRow): CustomerMatch => {
    const query = normalizeArabic(row.name);
    const targetDivision = sectionToDivision(row.sectionTag);
    let candidates = normalized.filter((c) => c.normalized === query);
    let note = 'exact';

    if (candidates.length === 0) {
      candidates = normalized.filter((c) => levenshtein(c.normalized, query) <= 2);
      note = 'levenshtein<=2';
    }

    if (candidates.length === 0 && query.length >= 8) {
      candidates = normalized.filter(
        (c) =>
          c.normalized.length >= 8 &&
          (c.normalized.includes(query) || query.includes(c.normalized)),
      );
      note = 'substring';
    }

    const sameDivision = candidates.filter((c) => c.division === targetDivision);
    if (sameDivision.length > 0) candidates = sameDivision;

    if (candidates.length === 1) {
      return {
        id: candidates[0].id,
        name: candidates[0].name,
        note,
        candidates: [],
      };
    }

    return {
      id: null,
      name: null,
      note: candidates.length > 1 ? 'multiple-candidates' : 'no-match',
      candidates: candidates.map((c) => `${c.name} (${c.division})`),
    };
  };
}

async function loadPreSysOutstandingByCustomer() {
  const invoices = await prisma.salesInvoice.findMany({
    where: {
      invoiceNumber: { startsWith: PREFIX },
      ...(INCLUDE_REJECTED ? {} : { paymentConfirmationStatus: { not: 'REJECTED' } }),
    },
    select: {
      total: true,
      paidAmount: true,
      customerId: true,
      customer: { select: { name: true } },
      invoiceNumber: true,
    },
  });

  const byCustomer = new Map<string, { customerId: string | null; name: string; amount: Prisma.Decimal; invoiceCount: number }>();
  let total = new Prisma.Decimal(0);

  for (const inv of invoices) {
    const outstanding = new Prisma.Decimal(inv.total).sub(inv.paidAmount ?? 0);
    if (outstanding.lessThanOrEqualTo(0)) continue;

    const key = inv.customerId ?? `invoice:${inv.invoiceNumber}`;
    const current = byCustomer.get(key) ?? {
      customerId: inv.customerId,
      name: inv.customer?.name ?? '(no customer)',
      amount: new Prisma.Decimal(0),
      invoiceCount: 0,
    };
    current.amount = current.amount.add(outstanding);
    current.invoiceCount += 1;
    byCustomer.set(key, current);
    total = total.add(outstanding);
  }

  return { byCustomer, total };
}

async function main() {
  const rows = await loadExcelRows();
  const match = await buildMatcher();
  const db = await loadPreSysOutstandingByCustomer();

  const expectedByCustomer = new Map<
    string,
    { customerId: string | null; customerName: string; excelName: string; amount: Prisma.Decimal; rows: number; matchNote: string }
  >();
  const unmatchedExcelRows: any[] = [];
  let excelTotal = new Prisma.Decimal(0);

  for (const row of rows) {
    excelTotal = excelTotal.add(row.openingBalance);
    const m = match(row);

    if (!m.id) {
      unmatchedExcelRows.push({
        sourceFile: row.sourceFile,
        rowNum: row.rowNum,
        name: row.name,
        openingBalance: row.openingBalance,
        section: row.sectionTag,
        reason: m.note,
        candidates: m.candidates,
      });
      continue;
    }

    const current = expectedByCustomer.get(m.id) ?? {
      customerId: m.id,
      customerName: m.name ?? row.name,
      excelName: row.name,
      amount: new Prisma.Decimal(0),
      rows: 0,
      matchNote: m.note,
    };
    current.amount = current.amount.add(row.openingBalance);
    current.rows += 1;
    expectedByCustomer.set(m.id, current);
  }

  const mismatches: any[] = [];
  const missingInDb: any[] = [];
  const extraInDb: any[] = [];

  for (const [customerId, expected] of expectedByCustomer) {
    const actual = db.byCustomer.get(customerId);
    const actualAmount = actual?.amount ?? new Prisma.Decimal(0);
    const diff = actualAmount.sub(expected.amount);

    if (diff.abs().greaterThan(TOLERANCE)) {
      const row = {
        customerId,
        customerName: expected.customerName,
        excelName: expected.excelName,
        excelExpected: expected.amount.toFixed(2),
        dbPreSysUnpaid: actualAmount.toFixed(2),
        differenceDbMinusExcel: diff.toFixed(2),
        excelRows: expected.rows,
        dbInvoiceCount: actual?.invoiceCount ?? 0,
        matchNote: expected.matchNote,
      };
      mismatches.push(row);
      if (!actual) missingInDb.push(row);
    }
  }

  for (const [key, actual] of db.byCustomer) {
    if (actual.customerId && expectedByCustomer.has(actual.customerId)) continue;
    extraInDb.push({
      customerKey: key,
      customerId: actual.customerId,
      customerName: actual.name,
      dbPreSysUnpaid: actual.amount.toFixed(2),
      dbInvoiceCount: actual.invoiceCount,
    });
  }

  mismatches.sort(
    (a, b) => Math.abs(parseFloat(b.differenceDbMinusExcel)) - Math.abs(parseFloat(a.differenceDbMinusExcel)),
  );
  extraInDb.sort((a, b) => parseFloat(b.dbPreSysUnpaid) - parseFloat(a.dbPreSysUnpaid));

  const payload = {
    prefix: PREFIX,
    files: [FILE1, FILE2],
    excludeRejected: !INCLUDE_REJECTED,
    tolerance: TOLERANCE.toFixed(2),
    summary: {
      excelRows: rows.length,
      excelMatchedCustomers: expectedByCustomer.size,
      excelUnmatchedRows: unmatchedExcelRows.length,
      excelTotal: excelTotal.toFixed(2),
      dbPreSysUnpaidTotal: db.total.toFixed(2),
      totalDifferenceDbMinusExcel: db.total.sub(excelTotal).toFixed(2),
      mismatchedCustomers: mismatches.length,
      missingInDb: missingInDb.length,
      extraInDbCustomers: extraInDb.length,
    },
    mismatches,
    missingInDb,
    extraInDb,
    unmatchedExcelRows,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('\nPRE-SYS vs EXCEL UNPAID RECONCILIATION (read-only)');
  console.log('='.repeat(78));
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Rejected invoices: ${INCLUDE_REJECTED ? 'included' : 'excluded'}`);
  console.log(`File 1: ${FILE1}`);
  console.log(`File 2: ${FILE2}`);
  console.log('-'.repeat(78));
  console.log(`Excel rows parsed:              ${payload.summary.excelRows}`);
  console.log(`Excel matched customers:        ${payload.summary.excelMatchedCustomers}`);
  console.log(`Excel unmatched rows:           ${payload.summary.excelUnmatchedRows}`);
  console.log(`Excel total:                    ${payload.summary.excelTotal} SDG`);
  console.log(`DB PRE-SYS unpaid total:        ${payload.summary.dbPreSysUnpaidTotal} SDG`);
  console.log(`DB - Excel difference:          ${payload.summary.totalDifferenceDbMinusExcel} SDG`);
  console.log(`Mismatched customers:           ${payload.summary.mismatchedCustomers}`);
  console.log(`Missing in DB:                  ${payload.summary.missingInDb}`);
  console.log(`Extra PRE-SYS unpaid in DB:     ${payload.summary.extraInDbCustomers}`);
  console.log('-'.repeat(78));

  if (mismatches.length > 0) {
    console.log('Top mismatches:');
    for (const row of mismatches.slice(0, 25)) {
      console.log(
        `  ${row.customerName}: Excel ${row.excelExpected} / DB ${row.dbPreSysUnpaid} / Diff ${row.differenceDbMinusExcel}`,
      );
    }
  }

  if (extraInDb.length > 0) {
    console.log('\nExtra DB PRE-SYS unpaid not matched to Excel:');
    for (const row of extraInDb.slice(0, 25)) {
      console.log(`  ${row.customerName}: ${row.dbPreSysUnpaid} (${row.dbInvoiceCount} invoices)`);
    }
  }

  if (unmatchedExcelRows.length > 0) {
    console.log('\nExcel rows not matched to a customer:');
    for (const row of unmatchedExcelRows.slice(0, 25)) {
      console.log(`  ${row.name}: ${row.openingBalance} (${row.reason})`);
    }
  }

  console.log('='.repeat(78) + '\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
