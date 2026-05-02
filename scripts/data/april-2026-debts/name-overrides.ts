/**
 * name-overrides.ts — single place to fix unmatched / ambiguous customer names.
 *
 * Imported by BOTH scripts:
 *   scripts/seed-april-2026-debts.ts
 *   scripts/apply-april-2026-excel-payments.ts
 *
 * Key:   Excel customer name EXACTLY as it appears in col B (trimmed).
 *
 * Value (any of these forms):
 *   '<cuid>'                                       -> use that existing customer
 *   ''                                              -> create a new customer; section/type/division
 *                                                     defaults come from the row's own section tag
 *                                                     in the JSON (1a→BAKERY/WHOLESALE, etc.)
 *   { customerId: '<cuid>' }                        -> use that existing customer
 *   { create: true }                               -> create with row's section defaults
 *   { create: true, name?, type?, division? }      -> create with explicit overrides
 *
 * WORKFLOW:
 *   1. Run `npm run script:seed-april-debts` (dry-run).
 *   2. Check `scripts/unmatched-debts-report.json` for names that could not be matched.
 *   3. Add an entry here for each unmatched name.
 *   4. Re-run dry-run and confirm, then run the apply script.
 *   5. For `''` entries: after the seed has created the customer, the apply script
 *      will fuzzy-match it automatically. You can remove the `''` entry or leave it
 *      (the apply script checks for an existing exact match first before creating).
 */

import type { CustomerType, Section } from '@prisma/client';

export type NameOverride =
  | string                                // non-empty = existing id; empty = create with defaults
  | { customerId: string }                // existing customer
  | {
      create: true;
      name?: string;
      type?: CustomerType;
      division?: Section;
    };

export const NAME_OVERRIDES: Record<string, NameOverride> = {
  // ── Use existing customer (ids from previous dry-run — verify still valid) ──
  'احمد المندوب':        'cmn4o77je003nb84wd7orx4uz',
  'مخبز  زكي- الكريمت': 'cmn5t6hpg004vtpdk0ihrkpb7',
  'مخبز ود عائس':       'cmn1zy7sj00gdm99srdrsxjrs',

  // ── Create new customers (section defaults used from their JSON row tag) ──
  //    مخبز اولاد ابراهيم  → section 1b → BAKERY / AGENT_WHOLESALE
  //    عبد اللطيف الجيلي  → section 2a → GROCERY / WHOLESALE
  //    جلال يوسف          → section 2a → GROCERY / WHOLESALE
  'مخبز اولاد ابراهيم': '',
  'عبد اللطيف الجيلي':  '',
  'جلال يوسف':           '',
};
