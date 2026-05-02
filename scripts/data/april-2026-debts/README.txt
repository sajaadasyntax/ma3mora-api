April 2026 debts — JSON-first workflow
======================================

Source files in this folder:

  latest.xlsx           = grocery workbook
                          sections: 2a wholesale, 2b retail, 2b non-moving retail
  latest2.xlsx          = bakery workbook
                          sections: 1a wholesale, 1b agent-wholesale
  ديون المنتجات.xlsx     = optional extra grocery file (older snapshot)

Recommended: do NOT seed daily payment details. Use the single-step "final
balances" script that simply forces every customer's outstanding to match the
الصافي column from the Excel sheets as of April 30.

Step 1 — Extract Excel into JSON
--------------------------------

  npm run script:extract-april-debts

This regenerates scripts/data/april-2026-debts/april-2026-debts.json. The
extractor asserts opening-balance subtotals and prints الصافي subtotals.

Step 2 — Apply final balances (the easy path)
---------------------------------------------

  npm run script:apply-april-final          # dry-run / preview
  npm run script:apply-april-final:apply    # write

What this does (cutoff: createdAt < 2026-05-01):

  1. Deletes all PRE-SYS-* invoices (script-generated; safe to recreate).
  2. Removes EXCEL-APR2026:* SalesPayments left over from older runs.
  3. Marks every pre-May real invoice as PAID with no cash effect.
     - Manual invoices stay in the DB as historical records.
     - Their outstanding goes to 0.
  4. Deletes pre-May customer cumulative aggregates (recompute from clean state).
  5. Creates new Customer rows for any name on the Excel list that has no DB
     match.
  6. Creates ONE PRE-SYS-APR2026-FINAL invoice per Excel customer dated
     2026-04-30 with total = الصافي.
     Customers whose الصافي is 0 are skipped (they're already paid off).
  7. Validates the resulting outstanding against the Excel total.

After this script:

  - Each Excel customer has outstanding == الصافي.
  - Customers in the DB but NOT on the Excel list have outstanding == 0
    (their pre-May invoices were marked PAID).
  - Customers existing only on the Excel list are now in the DB.
  - Total system pre-May outstanding == sum of الصافي across both Excel files.

Default behaviour skips the "غير متحركة" (non-moving) section because the
Excel grand total at row 186 also excludes it. Pass `--keep-non-moving` to
include those customers.

Fixing unmatched names
----------------------

If the script reports `multiple_candidates` rows, edit ONE file:

  scripts/data/april-2026-debts/name-overrides.ts

Add an entry that points the Excel name at a specific Customer.id, then re-run
the dry-run.

Step 3 — Optional reconciliation
--------------------------------

These scripts are read-only and useful if you want to compare daily activity:

  npm run script:reconcile-april-daily-debt
  npm run script:reconcile-pre-sys-excel

The legacy two-step flow (seed openings + replay daily payments) is still
available but is no longer the recommended path:

  npm run script:seed-april-debts
  npm run script:seed-april-debts:apply
  npm run script:apply-april-payments
  npm run script:apply-april-payments:apply
