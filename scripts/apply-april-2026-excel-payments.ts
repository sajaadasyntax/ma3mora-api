/**
 * apply-april-2026-excel-payments.ts
 *
 * Two-phase script:
 *
 *   1. Pre-April invoice cleanup (no cash effect)
 *      For every SalesInvoice with createdAt < 2026-04-01 that is NOT a
 *      PRE-SYS-* invoice, set paidAmount = total and paymentStatus = PAID.
 *      No SalesPayment, no aggregate update, no treasury entry.
 *
 *   2. Excel daily payment replay (real cash effect)
 *      Walk both April Excel workbooks day by day, per row. For each
 *      (customer, day, method) where سداد كاش or سداد بنكك > 0, allocate that
 *      amount FIFO across the customer's currently-unpaid invoices (oldest
 *      first), creating real SalesPayment rows and updating the daily
 *      financial aggregate and customer cumulative aggregate exactly like
 *      the /sales/invoices/:id/payments route does.
 *
 * Idempotent: previously-applied EXCEL-APR2026:* payments are reversed
 * before re-applying, so the script can be re-run safely.
 *
 * Usage from apps/api:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/apply-april-2026-excel-payments.ts            # dry-run
 *   node ./node_modules/tsx/dist/cli.mjs scripts/apply-april-2026-excel-payments.ts --confirm  # write
 *
 * CLI flags:
 *   --confirm                  Actually write to the database
 *   --skip-cleanup             Skip Phase 1
 *   --skip-payments            Skip Phases 2-4
 *   --file1=<path>             Override workbook 1 (default: ديون المنتجات.xlsx)
 *   --file2=<path>             Override workbook 2 (default: مخزن رئيسي بقالات.xlsx)
 *   --start-date=YYYY-MM-DD    Earliest day column to process (default: 2026-04-01)
 *   --end-date=YYYY-MM-DD      Latest day column to process   (default: 2026-04-30)
 *   --user=<userId>            User id to use as recordedBy on SalesPayment
 *                              (default: first MANAGER, then any user)
 *   --recalc                   After writing, run aggregationService.recalculateDate
 *                              for each (date, inventory, section) touched
 *
 * Reports written to apps/api/scripts/:
 *   excel-payments-report.json     What was applied per (customer, day, method)
 *   excel-payments-overflow.json   Amounts that exceeded a customer's outstanding
 *   excel-payments-unmatched.json  Excel customer names with no DB match
 */

import ExcelJS from 'exceljs';
import {
  PrismaClient,
  Prisma,
  PaymentMethod,
  PaymentStatus,
  Section,
  CustomerType,
} from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';

import { aggregationService } from '../src/services/aggregationService';

// ═══════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════

const ARGS = process.argv.slice(2);
const CONFIRM = ARGS.includes('--confirm');
const DRY_RUN = !CONFIRM;
const SKIP_CLEANUP = ARGS.includes('--skip-cleanup');
const SKIP_PAYMENTS = ARGS.includes('--skip-payments');
const RUN_RECALC = ARGS.includes('--recalc');

const DEFAULT_DEBT_DATA_DIR = path.join(__dirname, 'data', 'april-2026-debts');
const DEFAULT_FILE1 = path.join(DEFAULT_DEBT_DATA_DIR, 'ديون المنتجات.xlsx');
const DEFAULT_FILE2 = path.join(DEFAULT_DEBT_DATA_DIR, 'مخزن رئيسي بقالات.xlsx');

const FILE1 =
  ARGS.find((a) => a.startsWith('--file1='))?.slice('--file1='.length) ?? DEFAULT_FILE1;
const FILE2 =
  ARGS.find((a) => a.startsWith('--file2='))?.slice('--file2='.length) ?? DEFAULT_FILE2;

const START_DATE = parseDateArg(
  ARGS.find((a) => a.startsWith('--start-date='))?.slice('--start-date='.length),
  new Date('2026-04-01T00:00:00.000Z'),
);
const END_DATE = parseDateArg(
  ARGS.find((a) => a.startsWith('--end-date='))?.slice('--end-date='.length),
  new Date('2026-04-30T23:59:59.999Z'),
);

const USER_ID_OVERRIDE =
  ARGS.find((a) => a.startsWith('--user='))?.slice('--user='.length) ?? null;

const APRIL_1 = new Date('2026-04-01T00:00:00.000Z');
const TAG = 'EXCEL-APR2026';

/**
 * Per-source-file customer defaults.
 *
 * Used in two places:
 *   1. Multiple-candidate disambiguation. When the fuzzy matcher returns >1 DB
 *      candidate for a row, we narrow by `customer.type === preferredType` for
 *      that source file. If exactly one candidate survives, we pick it.
 *   2. New-customer creation. When EXCEL_NAME_OVERRIDES has an entry whose value
 *      is the empty string `""` (or `{ create: true }`), the new Customer row
 *      is inserted with these defaults unless explicitly overridden in the entry.
 *
 * Mapping is keyed by the Excel file's basename:
 *   ديون المنتجات.xlsx       -> WHOLESALE / GROCERY  (products debts; wholesale)
 *   مخزن رئيسي بقالات.xlsx   -> RETAIL    / BAKERY   (main warehouse; bakery shops)
 */
const FILE_DEFAULTS: Record<string, { type: CustomerType; division: Section }> = {
  'ديون المنتجات.xlsx': { type: CustomerType.WHOLESALE, division: Section.GROCERY },
  'مخزن رئيسي بقالات.xlsx': { type: CustomerType.RETAIL, division: Section.BAKERY },
};

const FALLBACK_DEFAULTS = { type: CustomerType.WHOLESALE, division: Section.GROCERY };

/**
 * Manual overrides for Excel customer names that the fuzzy matcher cannot resolve
 * automatically. The dry-run prints every unmatched name with its daily totals so
 * you can decide per-name whether to: (a) point it at an existing Customer.id, or
 * (b) ask the script to create a brand-new Customer row.
 *
 * Key:   Excel customer name EXACTLY as it appears in the workbook (cell B in
 *        the data row). Leading/trailing whitespace is trimmed automatically;
 *        otherwise the string is used verbatim.
 *
 * Value (any of these forms):
 *   '<cuid>'                                       -> use that existing customer
 *   ''                                              -> create a new customer with file
 *                                                     defaults (FILE_DEFAULTS)
 *   { customerId: '<cuid>' }                       -> use that existing customer
 *   { create: true }                               -> create with file defaults
 *   { create: true, type, division, name }         -> create with explicit fields
 *
 * Disambiguation note: if the SAME Excel name appears in BOTH workbooks and the
 * fuzzy matcher returns multiple DB candidates, you usually do NOT need an entry
 * here. The file-type rule (FILE_DEFAULTS above) splits them automatically:
 *   ديون المنتجات row     -> picks the WHOLESALE candidate
 *   مخزن رئيسي بقالات row -> picks the RETAIL    candidate
 */
type ExcelOverride =
  | string
  | { customerId: string }
  | {
      create: true;
      name?: string;
      type?: CustomerType;
      division?: Section;
    };

const EXCEL_NAME_OVERRIDES: Record<string, ExcelOverride> = {
  // ── Use existing customer (id supplied from dry-run output) ──────────────
  'احمد المندوب': 'cmn4o77je003nb84wd7orx4uz',
  'مخبز  زكي- الكريمت': 'cmn5t6hpg004vtpdk0ihrkpb7',
  'مخبز ود عائس': 'cmn1zy7sj00gdm99srdrsxjrs',

  // ── Create new customer (no id supplied; file defaults will be used) ────
  'مخبز اولاد ابراهيم': '', // مخزن رئيسي بقالات => BAKERY/RETAIL
  'عبد اللطيف الجيلي': '', // ديون المنتجات    => GROCERY/WHOLESALE
  'جلال يوسف': '', // ديون المنتجات    => GROCERY/WHOLESALE

  // The remaining `multiple_candidates` rows from the dry-run dump are resolved
  // automatically by the FILE_DEFAULTS file-type rule and do NOT need entries here:
  //   التوم حميدان معتوق  [مخزن رئيسي بقالات]   -> picks RETAIL candidate
  //   محمد مهدي           [مخزن رئيسي بقالات]   -> picks RETAIL candidate
  //   محمد مهدي           [ديون المنتجات]       -> picks WHOLESALE candidate
  //   مهدى المستشفى       [ديون المنتجات]       -> picks WHOLESALE candidate
  //   خالد مدرسة المجد    [ديون المنتجات]       -> picks WHOLESALE candidate
  //   خالد - مدرسة المجد  [مخزن رئيسي بقالات]   -> picks RETAIL candidate
};

const REPORTS_DIR = __dirname;
const REPORT_APPLIED = path.join(REPORTS_DIR, 'excel-payments-report.json');
const REPORT_OVERFLOW = path.join(REPORTS_DIR, 'excel-payments-overflow.json');
const REPORT_UNMATCHED = path.join(REPORTS_DIR, 'excel-payments-unmatched.json');

const prisma = new PrismaClient();

function parseDateArg(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date argument: ${s}`);
  }
  return d;
}

// ═══════════════════════════════════════════════════════════
// CELL VALUE HELPERS
// ═══════════════════════════════════════════════════════════

function cellNum(v: ExcelJS.CellValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in (v as any)) {
    const r = (v as any).result;
    if (typeof r === 'number') return r;
  }
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
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
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && v !== null && 'result' in (v as any)) {
    const r = (v as any).result;
    if (r instanceof Date) return r;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// ARABIC NORMALIZATION & FUZZY MATCH (copy from seed script)
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
// EXCEL PARSING
// ═══════════════════════════════════════════════════════════

interface DayPayment {
  date: Date;
  cash: Prisma.Decimal;
  bank: Prisma.Decimal;
}

interface ExcelCustomerRow {
  sourceFile: string;
  rowNum: number;
  name: string;
  daily: DayPayment[]; // only days with any non-zero cash/bank
}

/**
 * Both workbooks share the same layout:
 *   row 1: top title
 *   row 2: per-day repeated date in row[2 .. 2 + 6*d], starting at col C (idx 3)
 *   row 3: sub-headers ("رصيد افتتاحي" | "البيان" | "المديونية" | "سداد كاش" | "سداد بنكك" | "رصيد ختامي")
 *   row 4..end: data rows where col A is the row number and col B is the customer name.
 *
 * Day d (0-based) cells:
 *   idx (3 + d*6) + 0  -> رصيد افتتاحي
 *   idx (3 + d*6) + 1  -> البيان
 *   idx (3 + d*6) + 2  -> المديونية
 *   idx (3 + d*6) + 3  -> سداد كاش      (PaymentMethod.CASH)
 *   idx (3 + d*6) + 4  -> سداد بنكك     (PaymentMethod.BANKAK)
 *   idx (3 + d*6) + 5  -> رصيد ختامي
 */
async function parseWorkbookPayments(filePath: string): Promise<ExcelCustomerRow[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No worksheet in ${filePath}`);

  // Build day -> column index map by walking row 2 left to right.
  const dateRow = ws.getRow(2);
  const dateValues = dateRow.values as ExcelJS.CellValue[];
  const dayByCol: { idx: number; date: Date }[] = [];
  for (let idx = 3; idx < dateValues.length; idx += 6) {
    const d = cellDate(dateValues[idx]);
    if (!d) break;
    if (d.getTime() < START_DATE.getTime() || d.getTime() > END_DATE.getTime()) continue;
    dayByCol.push({ idx, date: d });
  }

  const out: ExcelCustomerRow[] = [];

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < 4) return; // skip headers

    const v = row.values as ExcelJS.CellValue[];
    const colA = v[1];
    const colB = v[2];

    const aNum = cellNum(colA);
    const bStr = cellStr(colB);

    // Data row: integer in col A, non-empty string in col B.
    if (!(aNum !== null && Number.isInteger(aNum) && bStr)) return;

    const daily: DayPayment[] = [];
    for (const day of dayByCol) {
      const cashRaw = cellNum(v[day.idx + 3]) ?? 0;
      const bankRaw = cellNum(v[day.idx + 4]) ?? 0;
      if (cashRaw <= 0 && bankRaw <= 0) continue;
      daily.push({
        date: day.date,
        cash: new Prisma.Decimal(cashRaw > 0 ? cashRaw : 0),
        bank: new Prisma.Decimal(bankRaw > 0 ? bankRaw : 0),
      });
    }

    if (daily.length === 0) return;

    out.push({
      sourceFile: path.basename(filePath),
      rowNum: aNum,
      name: bStr,
      daily,
    });
  });

  return out;
}

// ═══════════════════════════════════════════════════════════
// CUSTOMER MATCHING
// ═══════════════════════════════════════════════════════════

interface MatchedExcelCustomer extends ExcelCustomerRow {
  /** Empty string when this row is a pendingCreate that has not been written yet. */
  customerId: string;
  customerName: string;
  matchNote: string;
  /** Set when the override map asked us to create a brand-new Customer row. */
  pendingCreate?: { name: string; type: CustomerType; division: Section };
}

interface UnmatchedExcelCustomer extends ExcelCustomerRow {
  reason: 'no_match' | 'multiple_candidates';
  candidates: { id: string; name: string }[];
}

/**
 * Read an EXCEL_NAME_OVERRIDES value into a normalised shape:
 *   { kind: 'use'; id }                                  - existing customer
 *   { kind: 'create'; name, type, division }             - create new customer
 *   null                                                  - no override / falls through to fuzzy
 */
function resolveOverride(
  raw: ExcelOverride | undefined,
  excelName: string,
  sourceFile: string,
):
  | { kind: 'use'; id: string }
  | { kind: 'create'; name: string; type: CustomerType; division: Section }
  | null {
  if (raw === undefined) return null;
  const fileDefaults = FILE_DEFAULTS[sourceFile] ?? FALLBACK_DEFAULTS;

  if (typeof raw === 'string') {
    if (raw.length === 0) {
      return {
        kind: 'create',
        name: excelName,
        type: fileDefaults.type,
        division: fileDefaults.division,
      };
    }
    return { kind: 'use', id: raw };
  }

  if ('customerId' in raw) {
    return { kind: 'use', id: raw.customerId };
  }

  return {
    kind: 'create',
    name: raw.name ?? excelName,
    type: raw.type ?? fileDefaults.type,
    division: raw.division ?? fileDefaults.division,
  };
}

async function matchCustomers(
  rows: ExcelCustomerRow[],
): Promise<{ matched: MatchedExcelCustomer[]; unmatched: UnmatchedExcelCustomer[] }> {
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

  // Validate the manual overrides up front so typos surface fast.
  for (const [excelName, raw] of Object.entries(EXCEL_NAME_OVERRIDES)) {
    const id =
      typeof raw === 'string' && raw.length > 0
        ? raw
        : typeof raw === 'object' && 'customerId' in raw
          ? raw.customerId
          : null;
    if (id && !byId.has(id)) {
      console.warn(
        `  WARNING: EXCEL_NAME_OVERRIDES["${excelName}"] -> ${id} is not a known Customer.id; the entry will be IGNORED.`,
      );
    }
  }

  const matched: MatchedExcelCustomer[] = [];
  const unmatched: UnmatchedExcelCustomer[] = [];

  // First-come-first-served: every Excel row uses an independent search across
  // all customers; if multiple Excel rows match the same DB customer, all of
  // their daily payments are merged into that customer's payment plan.
  for (const row of rows) {
    const trimmedName = row.name.trim();

    // 1) Exact-name override map wins over fuzzy matching.
    const override = resolveOverride(
      EXCEL_NAME_OVERRIDES[trimmedName],
      trimmedName,
      row.sourceFile,
    );

    if (override?.kind === 'use' && byId.has(override.id)) {
      const c = byId.get(override.id)!;
      matched.push({
        ...row,
        customerId: c.id,
        customerName: c.name,
        matchNote: 'override:use',
      });
      continue;
    }

    if (override?.kind === 'create') {
      matched.push({
        ...row,
        customerId: '',
        customerName: override.name,
        matchNote: 'override:create',
        pendingCreate: {
          name: override.name,
          type: override.type,
          division: override.division,
        },
      });
      continue;
    }

    // 2) Fuzzy match (no override or override pointed at unknown id).
    const norm = normalizeArabic(trimmedName);
    let candidates = normalized.filter((c) => c.norm === norm);
    let note = 'exact';

    if (candidates.length === 0) {
      candidates = normalized.filter((c) => levenshtein(c.norm, norm) <= 2);
      note = 'levenshtein<=2';
    }

    if (candidates.length === 0 && norm.length >= 8) {
      candidates = normalized.filter(
        (c) =>
          c.norm.length >= 8 && (c.norm.includes(norm) || norm.includes(c.norm)),
      );
      note = 'substring';
    }

    // 3) If multiple candidates, narrow by file -> preferred customer.type.
    //    e.g. "محمد مهدي" appears in both files; the row from ديون المنتجات
    //    picks the WHOLESALE candidate, the row from مخزن رئيسي بقالات picks
    //    the RETAIL candidate.
    if (candidates.length > 1) {
      const preferredType = FILE_DEFAULTS[row.sourceFile]?.type;
      if (preferredType) {
        const filtered = candidates.filter((c) => c.type === preferredType);
        if (filtered.length === 1) {
          candidates = filtered;
          note = `${note}+file-type=${preferredType}`;
        } else if (filtered.length > 0 && filtered.length < candidates.length) {
          // Still ambiguous, but at least narrow down the candidate list shown
          // in the unmatched output so the user can pick faster.
          candidates = filtered;
        }
      }
    }

    if (candidates.length === 1) {
      matched.push({
        ...row,
        customerId: candidates[0].id,
        customerName: candidates[0].name,
        matchNote: note,
      });
      continue;
    }

    unmatched.push({
      ...row,
      reason: candidates.length === 0 ? 'no_match' : 'multiple_candidates',
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  return { matched, unmatched };
}

/**
 * Print the unmatched Excel rows in a console-readable table so the user can
 * pick them up and supply customer ids for EXCEL_NAME_OVERRIDES.
 */
function printUnmatched(unmatched: UnmatchedExcelCustomer[]): void {
  if (unmatched.length === 0) {
    console.log('\n  All Excel rows matched a DB customer — no manual overrides needed.');
    return;
  }

  console.log('\n══════════════════════════════════');
  console.log(`UNMATCHED EXCEL CUSTOMER NAMES (${unmatched.length})`);
  console.log('══════════════════════════════════');
  console.log(
    '  These rows will be SKIPPED until you add an entry to EXCEL_NAME_OVERRIDES at',
  );
  console.log('  the top of this script. Pick one of these two formats per name:');
  console.log('     "Excel name": "<customer-id>",   // use existing customer');
  console.log('     "Excel name": "",                // create a NEW customer');
  console.log(
    '                                         (file defaults: ديون المنتجات => GROCERY/WHOLESALE,',
  );
  console.log(
    '                                                         مخزن رئيسي بقالات => BAKERY/RETAIL)',
  );
  console.log('  ----------------------------------------');

  // Sort by total Excel cash+bank descending so the highest-impact names are first.
  const enriched = unmatched
    .map((u) => {
      const cash = u.daily.reduce((s, d) => s.add(d.cash), new Prisma.Decimal(0));
      const bank = u.daily.reduce((s, d) => s.add(d.bank), new Prisma.Decimal(0));
      const total = cash.add(bank);
      return { u, cash, bank, total };
    })
    .sort((a, b) => b.total.comparedTo(a.total));

  let idx = 1;
  for (const { u, cash, bank, total } of enriched) {
    const candidateNote =
      u.reason === 'multiple_candidates'
        ? ` (multiple matches: ${u.candidates
            .slice(0, 3)
            .map((c) => `"${c.name}" [${c.id.slice(0, 8)}…]`)
            .join(', ')}${u.candidates.length > 3 ? ', …' : ''})`
        : '';
    console.log(
      `  ${String(idx).padStart(3, ' ')}. "${u.name}"  [${u.sourceFile} row ${u.rowNum}]`,
    );
    console.log(
      `       cash=${cash.toFixed(2)}  bank=${bank.toFixed(2)}  total=${total.toFixed(2)} SDG  reason=${u.reason}${candidateNote}`,
    );
    idx++;
  }

  const aggCash = enriched.reduce((s, e) => s.add(e.cash), new Prisma.Decimal(0));
  const aggBank = enriched.reduce((s, e) => s.add(e.bank), new Prisma.Decimal(0));
  console.log('  ----------------------------------------');
  console.log(
    `  unmatched totals:  cash=${aggCash.toFixed(2)}  bank=${aggBank.toFixed(2)}  total=${aggCash.add(aggBank).toFixed(2)} SDG`,
  );
  console.log(
    `  full details (with all candidates) also written to ${REPORT_UNMATCHED} when the run finishes.`,
  );
}

// ═══════════════════════════════════════════════════════════
// USER LOOKUP
// ═══════════════════════════════════════════════════════════

async function resolveSystemUserId(): Promise<string> {
  if (USER_ID_OVERRIDE) {
    const u = await prisma.user.findUnique({ where: { id: USER_ID_OVERRIDE } });
    if (!u) throw new Error(`--user=${USER_ID_OVERRIDE} not found`);
    return u.id;
  }
  const manager = await prisma.user.findFirst({ where: { role: 'MANAGER' } });
  if (manager) return manager.id;
  const any = await prisma.user.findFirst();
  if (!any) throw new Error('No users in database; cannot record SalesPayment.recordedBy');
  return any.id;
}

// ═══════════════════════════════════════════════════════════
// PHASE 1 — pre-April non-PRE-SYS cleanup (no cash effect)
// ═══════════════════════════════════════════════════════════

interface CleanupResult {
  scanned: number;
  alreadyPaid: number;
  zeroed: number;
  zeroedTotal: Prisma.Decimal;
}

async function phase1Cleanup(): Promise<CleanupResult> {
  console.log('\n══════════════════════════════════');
  console.log('PHASE 1 — pre-April non-PRE-SYS cleanup');
  console.log('══════════════════════════════════');

  const targets = await prisma.salesInvoice.findMany({
    where: {
      createdAt: { lt: APRIL_1 },
      paymentConfirmationStatus: { not: 'REJECTED' },
      NOT: { invoiceNumber: { startsWith: 'PRE-SYS' } },
    },
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      paidAmount: true,
      paymentStatus: true,
    },
  });

  let alreadyPaid = 0;
  const toZero: { id: string; total: Prisma.Decimal }[] = [];
  let zeroedTotal = new Prisma.Decimal(0);

  for (const inv of targets) {
    const due = new Prisma.Decimal(inv.total).sub(inv.paidAmount);
    if (due.lessThanOrEqualTo(0)) {
      alreadyPaid++;
      continue;
    }
    toZero.push({ id: inv.id, total: new Prisma.Decimal(inv.total) });
    zeroedTotal = zeroedTotal.add(due);
  }

  console.log(`  scanned (pre-April, non-PRE-SYS, not REJECTED): ${targets.length}`);
  console.log(`  already paid (skipped):                         ${alreadyPaid}`);
  console.log(`  unpaid to be marked PAID:                       ${toZero.length}`);
  console.log(`  outstanding to be zeroed (no cash effect):       ${zeroedTotal.toFixed(2)} SDG`);

  if (DRY_RUN) {
    console.log('  (dry-run — no writes)');
  } else if (toZero.length > 0) {
    // Per-row to keep paidAmount = total exactly (UpdateMany cannot reference total column).
    const BATCH = 500;
    for (let i = 0; i < toZero.length; i += BATCH) {
      const slice = toZero.slice(i, i + BATCH);
      await prisma.$transaction(
        slice.map((row) =>
          prisma.salesInvoice.update({
            where: { id: row.id },
            data: {
              paidAmount: row.total,
              paymentStatus: PaymentStatus.PAID,
            },
          }),
        ),
      );
      console.log(`  ...wrote ${Math.min(i + BATCH, toZero.length)} / ${toZero.length}`);
    }
  }

  return {
    scanned: targets.length,
    alreadyPaid,
    zeroed: toZero.length,
    zeroedTotal,
  };
}

// ═══════════════════════════════════════════════════════════
// PHASE 2 — reverse prior EXCEL-APR2026 payments
// ═══════════════════════════════════════════════════════════

interface ReversalResult {
  paymentsReversed: number;
  totalReversed: Prisma.Decimal;
}

async function phase2ReverseOld(): Promise<ReversalResult> {
  console.log('\n══════════════════════════════════');
  console.log('PHASE 2 — reverse prior EXCEL-APR2026 payments');
  console.log('══════════════════════════════════');

  const old = await prisma.salesPayment.findMany({
    where: { notes: { startsWith: `${TAG}:` } },
    include: {
      invoice: {
        select: {
          id: true,
          total: true,
          paidAmount: true,
          customerId: true,
          inventoryId: true,
          section: true,
        },
      },
    },
    orderBy: { paidAt: 'asc' },
  });

  let totalReversed = new Prisma.Decimal(0);
  console.log(`  prior EXCEL-APR2026 payments found: ${old.length}`);

  if (old.length === 0) {
    return { paymentsReversed: 0, totalReversed };
  }

  if (DRY_RUN) {
    for (const p of old) totalReversed = totalReversed.add(p.amount);
    console.log(`  total to reverse: ${totalReversed.toFixed(2)} SDG (dry-run, no writes)`);
    return { paymentsReversed: old.length, totalReversed };
  }

  for (const p of old) {
    const inv = p.invoice;
    const newPaid = new Prisma.Decimal(inv.paidAmount).sub(p.amount);
    const newPaidClamped = newPaid.lessThan(0) ? new Prisma.Decimal(0) : newPaid;
    const newStatus =
      newPaidClamped.lessThanOrEqualTo(0)
        ? PaymentStatus.CREDIT
        : newPaidClamped.greaterThanOrEqualTo(inv.total)
          ? PaymentStatus.PAID
          : PaymentStatus.PARTIAL;

    await prisma.$transaction([
      prisma.salesInvoice.update({
        where: { id: inv.id },
        data: { paidAmount: newPaidClamped, paymentStatus: newStatus },
      }),
      prisma.salesPayment.delete({ where: { id: p.id } }),
    ]);

    // Reverse the daily aggregate effect (mirror what was added).
    const amt = new Prisma.Decimal(p.amount);
    const methodFieldUpdate = makeMethodAggUpdate(p.method as PaymentMethod, amt.neg());
    await aggregationService.updateDailyFinancialAggregate(
      p.paidAt,
      {
        salesReceived: amt.neg(),
        salesDebt: amt,
        ...methodFieldUpdate,
      },
      inv.inventoryId,
      inv.section,
    );

    if (inv.customerId) {
      await aggregationService.updateCustomerCumulativeAggregate(
        inv.customerId,
        p.paidAt,
        { totalPaid: amt.neg(), ...makeMethodCustomerUpdate(p.method as PaymentMethod, amt.neg()) },
      );
    }

    totalReversed = totalReversed.add(p.amount);
  }

  console.log(`  reversed:        ${old.length}`);
  console.log(`  total reversed:  ${totalReversed.toFixed(2)} SDG`);

  return { paymentsReversed: old.length, totalReversed };
}

// ═══════════════════════════════════════════════════════════
// PHASE 2.5 — create new customers requested by EXCEL_NAME_OVERRIDES
// ═══════════════════════════════════════════════════════════

interface CreateResult {
  pending: number;
  created: number;
  skipped: number;
}

/**
 * For every matched row that came from an EXCEL_NAME_OVERRIDES entry without an
 * id (i.e. `pendingCreate` is set), insert a Customer row and rewrite the row's
 * customerId/customerName so phases 3-4 treat them like any other matched row.
 *
 * Dry-run prints the planned creates but writes nothing; in that case the rows
 * keep customerId='' and phase 3-4 reports their daily totals as overflow with
 * reason='pending-create' so the user can see the impact ahead of time.
 */
async function phaseCreateCustomers(
  matched: MatchedExcelCustomer[],
): Promise<CreateResult> {
  const pending = matched.filter((m) => m.pendingCreate);

  if (pending.length === 0) {
    return { pending: 0, created: 0, skipped: 0 };
  }

  console.log('\n══════════════════════════════════');
  console.log(`PHASE 2.5 — create new customers (${pending.length})`);
  console.log('══════════════════════════════════');
  console.log(
    '  These names exist in EXCEL_NAME_OVERRIDES with NO customer id, so a new',
  );
  console.log('  Customer row will be inserted using FILE_DEFAULTS for type/division.');
  console.log('  ----------------------------------------');

  for (const m of pending) {
    const total = m.daily.reduce(
      (s, d) => s.add(d.cash).add(d.bank),
      new Prisma.Decimal(0),
    );
    console.log(
      `  + "${m.pendingCreate!.name}"  ${m.pendingCreate!.division}/${m.pendingCreate!.type}   total=${total.toFixed(2)} SDG  [${m.sourceFile} row ${m.rowNum}]`,
    );
  }

  if (DRY_RUN) {
    console.log('  (dry-run — no Customer rows created)');
    console.log(
      '  Note: dry-run cannot allocate payments to a not-yet-created customer;',
    );
    console.log(
      '  their daily totals will appear as overflow with reason="pending-create".',
    );
    return { pending: pending.length, created: 0, skipped: pending.length };
  }

  let created = 0;
  for (const m of pending) {
    const newCustomer = await prisma.customer.create({
      data: {
        name: m.pendingCreate!.name,
        type: m.pendingCreate!.type,
        division: m.pendingCreate!.division,
      },
      select: { id: true, name: true },
    });
    m.customerId = newCustomer.id;
    m.customerName = newCustomer.name;
    delete m.pendingCreate;
    created++;
  }

  console.log(`  created ${created} customer row(s)`);
  return { pending: pending.length, created, skipped: 0 };
}

// ═══════════════════════════════════════════════════════════
// PHASE 3 + 4 — apply Excel payments FIFO
// ═══════════════════════════════════════════════════════════

interface AppliedRecord {
  customerId: string;
  customerName: string;
  date: string;
  method: PaymentMethod;
  amount: string;
  invoices: { invoiceId: string; invoiceNumber: string; applied: string }[];
}

interface OverflowRecord {
  customerId: string;
  customerName: string;
  date: string;
  method: PaymentMethod;
  amountUnapplied: string;
  reason: string;
}

interface ApplyResult {
  payments: AppliedRecord[];
  overflows: OverflowRecord[];
  touched: Set<string>; // `${YYYY-MM-DD}|${inventoryId}|${section}`
}

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function makeMethodAggUpdate(method: PaymentMethod, amount: Prisma.Decimal) {
  const o: any = {};
  switch (method) {
    case 'CASH':
      o.salesCash = amount;
      break;
    case 'BANKAK':
      o.salesBank = amount;
      break;
    case 'BANK_NILE':
      o.salesBankNile = amount;
      break;
    case 'DEBT':
      o.salesDebtMethod = amount;
      break;
    default:
      o.salesOthers = amount;
  }
  return o;
}

function makeMethodCustomerUpdate(method: PaymentMethod, amount: Prisma.Decimal) {
  const o: any = {};
  switch (method) {
    case 'CASH':
      o.salesCash = amount;
      break;
    case 'BANKAK':
      o.salesBank = amount;
      break;
    case 'BANK_NILE':
      o.salesBankNile = amount;
      break;
    case 'DEBT':
      o.salesDebtMethod = amount;
      break;
    default:
      o.salesOthers = amount;
  }
  return o;
}

async function phase34ApplyPayments(
  matched: MatchedExcelCustomer[],
  systemUserId: string,
): Promise<ApplyResult> {
  console.log('\n══════════════════════════════════');
  console.log('PHASES 3-4 — replay Excel payments FIFO');
  console.log('══════════════════════════════════');

  // Aggregate per (customerId, date, method) so multiple Excel rows for the same
  // DB customer are summed.
  const planMap = new Map<
    string,
    { customerId: string; customerName: string; date: Date; method: PaymentMethod; amount: Prisma.Decimal }
  >();

  const applied: AppliedRecord[] = [];
  const overflows: OverflowRecord[] = [];
  const touched = new Set<string>();

  for (const m of matched) {
    // Pending-create rows in dry-run: no customerId means there's no DB customer
    // to allocate against (and creating one in dry-run is forbidden). Surface
    // every day's totals as overflow so the user sees the impact.
    if (!m.customerId) {
      for (const day of m.daily) {
        if (day.cash.greaterThan(0)) {
          overflows.push({
            customerId: '',
            customerName: m.customerName,
            date: ymd(day.date),
            method: PaymentMethod.CASH,
            amountUnapplied: day.cash.toFixed(2),
            reason: 'pending-create (dry-run customer not inserted)',
          });
        }
        if (day.bank.greaterThan(0)) {
          overflows.push({
            customerId: '',
            customerName: m.customerName,
            date: ymd(day.date),
            method: PaymentMethod.BANKAK,
            amountUnapplied: day.bank.toFixed(2),
            reason: 'pending-create (dry-run customer not inserted)',
          });
        }
      }
      continue;
    }

    for (const day of m.daily) {
      if (day.cash.greaterThan(0)) {
        const key = `${m.customerId}|${ymd(day.date)}|CASH`;
        const cur = planMap.get(key);
        if (cur) cur.amount = cur.amount.add(day.cash);
        else
          planMap.set(key, {
            customerId: m.customerId,
            customerName: m.customerName,
            date: day.date,
            method: PaymentMethod.CASH,
            amount: day.cash,
          });
      }
      if (day.bank.greaterThan(0)) {
        const key = `${m.customerId}|${ymd(day.date)}|BANKAK`;
        const cur = planMap.get(key);
        if (cur) cur.amount = cur.amount.add(day.bank);
        else
          planMap.set(key, {
            customerId: m.customerId,
            customerName: m.customerName,
            date: day.date,
            method: PaymentMethod.BANKAK,
            amount: day.bank,
          });
      }
    }
  }

  const ops = Array.from(planMap.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.customerName.localeCompare(b.customerName),
  );

  console.log(`  customer/day/method allocations to apply: ${ops.length}`);
  const planTotal = ops.reduce((s, o) => s.add(o.amount), new Prisma.Decimal(0));
  console.log(`  total amount to allocate:                 ${planTotal.toFixed(2)} SDG`);

  for (const op of ops) {
    const invoices = await prisma.salesInvoice.findMany({
      where: {
        customerId: op.customerId,
        paymentConfirmationStatus: { not: 'REJECTED' },
        // unpaid: paidAmount < total
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        paidAmount: true,
        inventoryId: true,
        section: true,
      },
    });

    let remaining = op.amount;
    const invoiceHits: AppliedRecord['invoices'] = [];

    for (const inv of invoices) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const due = new Prisma.Decimal(inv.total).sub(inv.paidAmount);
      if (due.lessThanOrEqualTo(0)) continue;
      const slice = Prisma.Decimal.min(remaining, due);

      if (!DRY_RUN) {
        const receiptNumber = `${TAG}-${ymd(op.date)}-${op.method}-${inv.id.slice(-8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const noteString = `${TAG}:${op.customerId}:${ymd(op.date)}:${op.method}`;

        await prisma.$transaction([
          prisma.salesPayment.create({
            data: {
              invoiceId: inv.id,
              amount: slice,
              method: op.method,
              paidAt: op.date,
              recordedBy: systemUserId,
              notes: noteString,
              receiptNumber,
            },
          }),
          prisma.salesInvoice.update({
            where: { id: inv.id },
            data: {
              paidAmount: new Prisma.Decimal(inv.paidAmount).add(slice),
              paymentStatus: new Prisma.Decimal(inv.paidAmount).add(slice).gte(inv.total)
                ? PaymentStatus.PAID
                : PaymentStatus.PARTIAL,
            },
          }),
        ]);

        await aggregationService.updateDailyFinancialAggregate(
          op.date,
          {
            salesReceived: slice,
            salesDebt: slice.neg(),
            ...makeMethodAggUpdate(op.method, slice),
          },
          inv.inventoryId,
          inv.section,
        );

        await aggregationService.updateCustomerCumulativeAggregate(
          op.customerId,
          op.date,
          { totalPaid: slice, ...makeMethodCustomerUpdate(op.method, slice) },
        );

        touched.add(`${ymd(op.date)}|${inv.inventoryId}|${inv.section}`);
      }

      invoiceHits.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        applied: slice.toFixed(2),
      });
      remaining = remaining.sub(slice);
    }

    applied.push({
      customerId: op.customerId,
      customerName: op.customerName,
      date: ymd(op.date),
      method: op.method,
      amount: op.amount.toFixed(2),
      invoices: invoiceHits,
    });

    if (remaining.greaterThan(0)) {
      overflows.push({
        customerId: op.customerId,
        customerName: op.customerName,
        date: ymd(op.date),
        method: op.method,
        amountUnapplied: remaining.toFixed(2),
        reason:
          invoices.length === 0
            ? 'customer has no unpaid invoices'
            : 'all unpaid invoices fully consumed; payment exceeds outstanding',
      });
    }
  }

  const totalApplied = applied.reduce(
    (s, r) =>
      s.add(r.invoices.reduce((ss, h) => ss.add(new Prisma.Decimal(h.applied)), new Prisma.Decimal(0))),
    new Prisma.Decimal(0),
  );
  const totalOverflow = overflows.reduce(
    (s, r) => s.add(new Prisma.Decimal(r.amountUnapplied)),
    new Prisma.Decimal(0),
  );

  console.log(`  applied:           ${totalApplied.toFixed(2)} SDG`);
  console.log(`  overflow:          ${totalOverflow.toFixed(2)} SDG`);
  console.log(
    `  ${DRY_RUN ? '(dry-run — no writes)' : `touched (date,inv,section): ${touched.size}`}`,
  );

  return { payments: applied, overflows, touched };
}

// ═══════════════════════════════════════════════════════════
// PHASE 5 — optional recalc
// ═══════════════════════════════════════════════════════════

async function phase5Recalc(touched: Set<string>): Promise<void> {
  if (!RUN_RECALC) {
    console.log('\nPHASE 5 skipped (pass --recalc to run)');
    return;
  }
  console.log('\n══════════════════════════════════');
  console.log('PHASE 5 — recalculateDate sweep');
  console.log('══════════════════════════════════');
  console.log(`  buckets: ${touched.size}`);

  if (DRY_RUN) {
    console.log('  (dry-run — no writes)');
    return;
  }

  let n = 0;
  for (const key of touched) {
    const [d, inventoryId, section] = key.split('|');
    await aggregationService.recalculateDate(
      new Date(d),
      inventoryId || undefined,
      (section as Section) || undefined,
    );
    n++;
    if (n % 25 === 0) console.log(`  ...recalculated ${n}/${touched.size}`);
  }
  console.log(`  recalculated ${n} buckets`);
}

// ═══════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════

function writeReports(
  applied: AppliedRecord[],
  overflows: OverflowRecord[],
  unmatched: UnmatchedExcelCustomer[],
): void {
  fs.writeFileSync(REPORT_APPLIED, JSON.stringify(applied, null, 2));
  fs.writeFileSync(REPORT_OVERFLOW, JSON.stringify(overflows, null, 2));
  fs.writeFileSync(REPORT_UNMATCHED, JSON.stringify(unmatched, null, 2));
  console.log('\nReports written:');
  console.log(`  ${REPORT_APPLIED}`);
  console.log(`  ${REPORT_OVERFLOW}`);
  console.log(`  ${REPORT_UNMATCHED}`);
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('================================================================');
  console.log(' apply-april-2026-excel-payments');
  console.log('================================================================');
  console.log(`mode:           ${DRY_RUN ? 'DRY RUN' : 'WRITE (--confirm)'}`);
  console.log(`skip-cleanup:   ${SKIP_CLEANUP}`);
  console.log(`skip-payments:  ${SKIP_PAYMENTS}`);
  console.log(`run-recalc:     ${RUN_RECALC}`);
  console.log(`file 1:         ${FILE1}`);
  console.log(`file 2:         ${FILE2}`);
  console.log(`start date:     ${ymd(START_DATE)}`);
  console.log(`end date:       ${ymd(END_DATE)}`);

  // Phase 1
  if (!SKIP_CLEANUP) {
    await phase1Cleanup();
  } else {
    console.log('\nPHASE 1 skipped');
  }

  if (SKIP_PAYMENTS) {
    console.log('\nPHASES 2-4 skipped');
    if (DRY_RUN) console.log('\nDRY RUN COMPLETE — no DB writes were performed.');
    return;
  }

  // Parse Excel
  console.log('\nReading Excel files...');
  const [rows1, rows2] = await Promise.all([
    parseWorkbookPayments(FILE1),
    parseWorkbookPayments(FILE2),
  ]);
  const allRows = [...rows1, ...rows2];
  console.log(`  ${path.basename(FILE1)}: ${rows1.length} customer rows with payments`);
  console.log(`  ${path.basename(FILE2)}: ${rows2.length} customer rows with payments`);
  console.log(`  total rows with non-zero cash/bank payments: ${allRows.length}`);

  const totalCashPlanned = allRows.reduce(
    (s, r) => s.add(r.daily.reduce((ss, d) => ss.add(d.cash), new Prisma.Decimal(0))),
    new Prisma.Decimal(0),
  );
  const totalBankPlanned = allRows.reduce(
    (s, r) => s.add(r.daily.reduce((ss, d) => ss.add(d.bank), new Prisma.Decimal(0))),
    new Prisma.Decimal(0),
  );
  console.log(`  total cash in Excel:  ${totalCashPlanned.toFixed(2)} SDG`);
  console.log(`  total bank in Excel:  ${totalBankPlanned.toFixed(2)} SDG`);

  // Match
  const { matched, unmatched } = await matchCustomers(allRows);
  console.log(`  matched customers:   ${matched.length}`);
  console.log(`  unmatched rows:      ${unmatched.length}`);

  // Always print unmatched names so you can supply ids for EXCEL_NAME_OVERRIDES.
  printUnmatched(unmatched);

  // Persist the unmatched JSON immediately (even before the rest of the run finishes)
  // so the user can react to it during a long dry-run.
  fs.writeFileSync(REPORT_UNMATCHED, JSON.stringify(unmatched, null, 2));

  // Resolve user
  const systemUserId = await resolveSystemUserId();
  console.log(`  recordedBy user:     ${systemUserId}`);

  // Phase 2 (reverse old)
  await phase2ReverseOld();

  // Phase 2.5 (create new customers requested via EXCEL_NAME_OVERRIDES)
  await phaseCreateCustomers(matched);

  // Phase 3-4 (apply new)
  const applyResult = await phase34ApplyPayments(matched, systemUserId);

  // Phase 5
  await phase5Recalc(applyResult.touched);

  // Reports
  writeReports(applyResult.payments, applyResult.overflows, unmatched);

  if (DRY_RUN) {
    console.log('\nDRY RUN COMPLETE — no DB writes were performed.');
    console.log('Re-run with --confirm to actually write the changes.');
  } else {
    console.log('\nDONE — changes committed.');
  }
}

main()
  .catch((e) => {
    console.error('Script error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
