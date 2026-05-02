/**
 * extract-april-2026-debts-to-json.ts
 *
 * Reads latest.xlsx (grocery, 3 sub-sections) and latest2.xlsx (bakery, 2 sub-sections)
 * and writes a single canonical april-2026-debts.json.
 *
 * Sub-section map (verified by direct file inspection):
 *
 *   latest2.xlsx — bakery:
 *     1a  BAKERY / WHOLESALE        rows 4-120   (boundary: 1st "الرقم" in col A)
 *     1b  BAKERY / AGENT_WHOLESALE  rows 127-244 (boundary: 2nd "الرقم" in col A)
 *
 *   latest.xlsx — grocery:
 *     2a  GROCERY / WHOLESALE  rows 4-38    (default; title "مديونية منتجات الجملة")
 *     2b  GROCERY / RETAIL     rows 45-125  (title col-B contains "القطاعي")
 *     2b  GROCERY / RETAIL     rows ~157-184 nonMoving=true (title col-B "غير متحركة")
 *
 * Per-day cell layout (both files, day d 0-based, April 1 + d):
 *   v[3+6d+0]  رصيد افتتاحي  opening
 *   v[3+6d+1]  البيان         description
 *   v[3+6d+2]  المديونية      debt added that day
 *   v[3+6d+3]  سداد كاش       cash payment
 *   v[3+6d+4]  سداد بنكك      bank payment
 *   v[3+6d+5]  رصيد ختامي    closing balance
 *
 * Usage (from apps/api):
 *   node ./node_modules/tsx/dist/cli.mjs scripts/extract-april-2026-debts-to-json.ts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/extract-april-2026-debts-to-json.ts \
 *     --file1=scripts/data/april-2026-debts/latest.xlsx   \
 *     --file2=scripts/data/april-2026-debts/latest2.xlsx  \
 *     --out=scripts/data/april-2026-debts/april-2026-debts.json
 *   --no-assert   skip subtotal sanity check
 */

import ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

// ─── CLI ─────────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const DATA_DIR = path.join(__dirname, 'data', 'april-2026-debts');

const FILE_GROCERY =
  ARGS.find((a) => a.startsWith('--file1='))?.slice('--file1='.length) ??
  path.join(DATA_DIR, 'latest.xlsx');
const FILE_BAKERY =
  ARGS.find((a) => a.startsWith('--file2='))?.slice('--file2='.length) ??
  path.join(DATA_DIR, 'latest2.xlsx');
const OUT_FILE =
  ARGS.find((a) => a.startsWith('--out='))?.slice('--out='.length) ??
  path.join(DATA_DIR, 'april-2026-debts.json');
const NO_ASSERT = ARGS.includes('--no-assert');

// ─── TYPES ───────────────────────────────────────────────────────────────────
type SectionTag = '1a' | '1b' | '2a' | '2b';

export interface DayData {
  date: string;           // "YYYY-MM-DD"
  opening: number;
  description: string | null;
  debt: number;
  cash: number;
  bank: number;
  closing: number;
}

export interface CustomerData {
  sourceFile: string;
  section: SectionTag;
  rowNum: number | null;
  name: string;
  openingBalanceApril1: number;
  nonMoving: boolean;
  daily: DayData[];
}

export interface AprilDebtsJson {
  extractedAt: string;
  sources: {
    file: string;
    subsections: {
      section: SectionTag;
      title: string;
      customers: number;
      subtotal: number;
      nonMoving?: boolean;
    }[];
  }[];
  customers: CustomerData[];
}

// ─── CELL HELPERS ─────────────────────────────────────────────────────────────
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

function cellDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v as string);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && v !== null && 'result' in (v as any)) {
    const r = (v as any).result;
    if (r instanceof Date) return r;
  }
  return null;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

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

// Normalised forms of header strings we must never treat as customer names.
const SKIP_B_NORMS = new Set([
  normalizeArabic('الأسماء'),
  normalizeArabic('الاسماء'),
  normalizeArabic('الرقم'),
  normalizeArabic('الاسم'),
  normalizeArabic('البيان'),
]);

// ─── DAY SLOT MAP ─────────────────────────────────────────────────────────────
interface DaySlot {
  idx: number;
  dateStr: string;
}

/** Build an ordered list of day slots from the date header row (row 2). */
function buildDayMap(ws: ExcelJS.Worksheet, dateRowNum: number): DaySlot[] {
  const dateRow = ws.getRow(dateRowNum);
  const dv = dateRow.values as ExcelJS.CellValue[];
  const slots: DaySlot[] = [];
  for (let idx = 3; idx < (dv.length ?? 0); idx += 6) {
    const d = cellDate(dv[idx]);
    if (!d) break;
    slots.push({ idx, dateStr: ymd(d) });
  }
  return slots;
}

// ─── DAILY DATA EXTRACTOR ─────────────────────────────────────────────────────
/**
 * For each day slot, reads the 6-cell block from a customer row.
 * Drops days where every numeric field is zero (no balance, no activity).
 * Computes closing from components when the formula cell is unresolved (=0).
 */
function extractDailyData(v: ExcelJS.CellValue[], daySlots: DaySlot[]): DayData[] {
  const days: DayData[] = [];
  for (const slot of daySlots) {
    const opening     = cellNum(v[slot.idx + 0]) ?? 0;
    const description = cellStr(v[slot.idx + 1]);
    const debt        = cellNum(v[slot.idx + 2]) ?? 0;
    const cash        = cellNum(v[slot.idx + 3]) ?? 0;
    const bank        = cellNum(v[slot.idx + 4]) ?? 0;
    const rawClosing  = cellNum(v[slot.idx + 5]) ?? 0;

    if (opening === 0 && debt === 0 && cash === 0 && bank === 0 && rawClosing === 0) continue;

    // Shared formula cells may not have a cached result (rawClosing=0 even though
    // balance is non-zero). Compute from components as fallback.
    const closing = rawClosing !== 0 ? rawClosing : opening + debt - cash - bank;

    days.push({ date: slot.dateStr, opening, description, debt, cash, bank, closing });
  }
  return days;
}

// ─── PARSE BAKERY (latest2.xlsx) ──────────────────────────────────────────────
/**
 * latest2.xlsx has two sections separated by repeated "الرقم" headers in col A.
 * Section 1a starts at row 4; section 1b starts after the second "الرقم" header.
 * Data rows: col A = positive integer row number, col B = customer name.
 */
function parseBakery(wb: ExcelJS.Workbook, fileName: string): CustomerData[] {
  const ws = wb.worksheets[0];
  const daySlots = buildDayMap(ws, 2);
  const customers: CustomerData[] = [];
  let section: SectionTag = '1a';
  let headerCount = 0;

  ws.eachRow({ includeEmpty: false }, (row) => {
    const v = row.values as ExcelJS.CellValue[];
    const colAStr = cellStr(v[1]);
    const colBStr = cellStr(v[2]);

    // Section boundary: col A = "الرقم"
    if (colAStr !== null && normalizeArabic(colAStr) === normalizeArabic('الرقم')) {
      headerCount++;
      if (headerCount >= 2) section = '1b';
      return;
    }

    // Data row: col A = positive integer, col B = non-empty name
    const aNum = cellNum(v[1]);
    if (aNum === null || !Number.isInteger(aNum) || aNum <= 0 || !colBStr) return;

    const daily = extractDailyData(v, daySlots);
    const opening = daily.length > 0 ? daily[0].opening : (cellNum(v[3]) ?? 0);
    if (opening <= 0) return;

    customers.push({
      sourceFile: fileName,
      section,
      rowNum: aNum,
      name: colBStr,
      openingBalanceApril1: opening,
      nonMoving: false,
      daily,
    });
  });

  return customers;
}

// ─── PARSE GROCERY (latest.xlsx) ──────────────────────────────────────────────
/**
 * latest.xlsx has three sub-sections detected by col-B title rows:
 *   2a: default at file start; title contains "منتجات الجملة"
 *   2b: title col-B contains "القطاعي"
 *   2b+nonMoving: title col-B contains "غير متحركة"
 *
 * Regular data rows (2a/2b): col A = positive integer, col B = name.
 * Non-moving data rows: col A = empty, col B = name, col C = opening balance.
 */
function parseGrocery(wb: ExcelJS.Workbook, fileName: string): CustomerData[] {
  const ws = wb.worksheets[0];
  const daySlots = buildDayMap(ws, 2);
  const customers: CustomerData[] = [];
  let section: SectionTag = '2a';
  let nonMoving = false;

  ws.eachRow({ includeEmpty: false }, (row) => {
    const v = row.values as ExcelJS.CellValue[];
    const colBStr = cellStr(v[2]);
    const colBNorm = colBStr ? normalizeArabic(colBStr) : '';

    const aNum = cellNum(v[1]);
    const aIsDataNum = aNum !== null && Number.isInteger(aNum) && aNum > 0;

    // ── Non-integer col A: detect section boundaries or non-moving data ──
    if (!aIsDataNum) {
      // Section title detection (done first to avoid false-positives on customer names)
      if (colBNorm.includes(normalizeArabic('غير متحركه')) ||
          colBNorm.includes(normalizeArabic('غير متحركة'))) {
        section = '2b';
        nonMoving = true;
        return;
      }
      if (colBNorm.includes(normalizeArabic('القطاعي'))) {
        section = '2b';
        nonMoving = false;
        return;
      }
      if (colBNorm.includes(normalizeArabic('منتجات الجمله')) ||
          colBNorm.includes(normalizeArabic('منتجات الجملة'))) {
        section = '2a';
        nonMoving = false;
        return;
      }

      // Known header strings: skip
      if (colBStr && SKIP_B_NORMS.has(colBNorm)) return;

      // Outside non-moving: skip non-data rows (subtotals, separators, etc.)
      if (!nonMoving) return;

      // Non-moving data row: col A empty, col B = customer name, col C = opening
      if (!colBStr || SKIP_B_NORMS.has(colBNorm)) return;
      const c3 = cellNum(v[3]);
      if (c3 === null || c3 <= 0) return;

      const daily = extractDailyData(v, daySlots);
      const opening = daily.length > 0 ? daily[0].opening : c3;
      if (opening <= 0) return;

      customers.push({
        sourceFile: fileName,
        section,
        rowNum: null,
        name: colBStr,
        openingBalanceApril1: opening,
        nonMoving: true,
        daily,
      });
      return;
    }

    // ── Integer col A: data row in whichever section is current ──
    // Non-moving section has BOTH numbered rows (A=integer) and unnumbered rows (A=empty).
    if (!colBStr || SKIP_B_NORMS.has(colBNorm)) return;

    const daily = extractDailyData(v, daySlots);
    const opening = daily.length > 0 ? daily[0].opening : (cellNum(v[3]) ?? 0);
    if (opening <= 0) return;

    customers.push({
      sourceFile: fileName,
      section,
      rowNum: aNum!,
      name: colBStr,
      openingBalanceApril1: opening,
      nonMoving,
      daily,
    });
  });

  return customers;
}

// ─── SUBTOTAL HELPERS ─────────────────────────────────────────────────────────
function readSubtotalRow(ws: ExcelJS.Worksheet, rowNum: number): number | null {
  const row = ws.getRow(rowNum);
  const v = row.values as ExcelJS.CellValue[];
  return cellNum(v[3]) ?? cellNum(v[1]) ?? null;
}

function checkSubtotal(
  label: string,
  computed: number,
  expected: number | null,
): void {
  if (expected === null) {
    console.log(`  ${label}: ${computed.toLocaleString()} SDG  (subtotal row not found — skipped)`);
    return;
  }
  const diff = Math.abs(computed - expected);
  if (diff > 1) {
    const msg =
      `Subtotal mismatch [${label}]: computed=${computed.toLocaleString()} ` +
      `Excel=${expected.toLocaleString()} diff=${diff.toLocaleString()}`;
    if (NO_ASSERT) {
      console.warn(`  ⚠ WARNING: ${msg}`);
    } else {
      throw new Error(`\n${msg}\nUse --no-assert to skip this check.`);
    }
  } else {
    console.log(`  ✓ ${label}: ${computed.toLocaleString()} SDG`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  APRIL 2026 DEBTS — EXCEL → JSON EXTRACTOR  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Grocery (latest.xlsx):  ${FILE_GROCERY}`);
  console.log(`  Bakery  (latest2.xlsx): ${FILE_BAKERY}`);
  console.log(`  Output:                 ${OUT_FILE}`);
  console.log(`  Subtotal assert:        ${NO_ASSERT ? 'disabled (--no-assert)' : 'enabled'}`);
  console.log();

  for (const [label, fpath] of [['Grocery', FILE_GROCERY], ['Bakery', FILE_BAKERY]] as [string, string][]) {
    if (!fs.existsSync(fpath)) {
      console.error(`✗ ${label} file not found: ${fpath}`);
      console.error('  Use --file1= / --file2= to override paths.');
      process.exit(1);
    }
  }

  // Load workbooks once (used for both parsing and subtotal checks)
  console.log('Loading workbooks...');
  const groceryWb = new ExcelJS.Workbook();
  await groceryWb.xlsx.readFile(FILE_GROCERY);

  const bakeryWb = new ExcelJS.Workbook();
  await bakeryWb.xlsx.readFile(FILE_BAKERY);

  // Parse
  console.log('Parsing grocery workbook (latest.xlsx)...');
  const groceryCustomers = parseGrocery(groceryWb, path.basename(FILE_GROCERY));

  console.log('Parsing bakery workbook  (latest2.xlsx)...');
  const bakeryCustomers = parseBakery(bakeryWb, path.basename(FILE_BAKERY));

  const all = [...groceryCustomers, ...bakeryCustomers];

  // ── Per-section totals ────────────────────────────────────────────────────
  const sumOpening = (tag: SectionTag, nm?: boolean) =>
    all
      .filter((c) => c.section === tag && (nm === undefined || c.nonMoving === nm))
      .reduce((s, c) => s + c.openingBalanceApril1, 0);

  const t2a    = sumOpening('2a');
  const t2b    = sumOpening('2b', false);
  const t2b_nm = sumOpening('2b', true);
  const t1a    = sumOpening('1a');
  const t1b    = sumOpening('1b');

  const gWs = groceryWb.worksheets[0];
  const bWs = bakeryWb.worksheets[0];

  // Subtotal rows verified by direct inspection:
  //   latest.xlsx:  row 39=2a, row 126=2b, row 185=2b-nonmoving
  //   latest2.xlsx: row 121=1a, row 245=1b
  console.log('\nSubtotal check (latest.xlsx — grocery):');
  checkSubtotal('2a wholesale',      t2a,    readSubtotalRow(gWs, 39));
  checkSubtotal('2b retail',         t2b,    readSubtotalRow(gWs, 126));
  checkSubtotal('2b non-moving',     t2b_nm, readSubtotalRow(gWs, 185));
  console.log(`  Grand grocery: ${(t2a + t2b + t2b_nm).toLocaleString()} SDG`);

  console.log('\nSubtotal check (latest2.xlsx — bakery):');
  checkSubtotal('1a wholesale',      t1a,    readSubtotalRow(bWs, 121));
  checkSubtotal('1b agent-whl',      t1b,    readSubtotalRow(bWs, 245));
  console.log(`  Grand bakery:  ${(t1a + t1b).toLocaleString()} SDG`);

  // ── Customer count summary ─────────────────────────────────────────────────
  const count = (tag: SectionTag, nm?: boolean) =>
    all.filter((c) => c.section === tag && (nm === undefined || c.nonMoving === nm)).length;

  console.log('\nCustomer counts:');
  console.log(`  1a (bakery wholesale):          ${count('1a')}`);
  console.log(`  1b (bakery agent-wholesale):    ${count('1b')}`);
  console.log(`  2a (grocery wholesale):         ${count('2a')}`);
  console.log(`  2b regular (grocery retail):    ${count('2b', false)}`);
  console.log(`  2b non-moving (grocery retail): ${count('2b', true)}`);
  console.log(`  Total:                          ${all.length}`);

  // ── Build and write JSON ───────────────────────────────────────────────────
  const output: AprilDebtsJson = {
    extractedAt: new Date().toISOString(),
    sources: [
      {
        file: path.basename(FILE_GROCERY),
        subsections: [
          { section: '2a', title: 'مديونية منتجات الجملة',   customers: count('2a'),       subtotal: t2a    },
          { section: '2b', title: 'مديونية القطاعي- منتجات', customers: count('2b', false), subtotal: t2b    },
          { section: '2b', title: 'مديونية غير متحركة',      customers: count('2b', true),  subtotal: t2b_nm, nonMoving: true },
        ],
      },
      {
        file: path.basename(FILE_BAKERY),
        subsections: [
          { section: '1a', title: 'ديون 25 كيلو - مجموعة 1', customers: count('1a'), subtotal: t1a },
          { section: '1b', title: 'ديون 25 كيلو - مجموعة 2', customers: count('1b'), subtotal: t1b },
        ],
      },
    ],
    customers: all,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`\n✓ Wrote ${all.length} customers → ${OUT_FILE} (${sizeKb} KB)`);
}

main().catch((e) => {
  console.error('\n✗ Fatal error:', e.message ?? e);
  process.exit(1);
});
