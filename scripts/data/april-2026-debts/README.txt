April 2026 debts — JSON-first workflow
======================================

Source files in this folder:

  latest.xlsx   = grocery workbook
                 sections: 2a wholesale, 2b retail, 2b non-moving retail

  latest2.xlsx  = bakery workbook
                 sections: 1a wholesale, 1b agent-wholesale

Do not point the seed/apply scripts directly at Excel files. First regenerate the
canonical JSON:

  npm run script:extract-april-debts

This writes:

  scripts/data/april-2026-debts/april-2026-debts.json

The extractor asserts these opening-balance subtotals:

  latest.xlsx:
    2a wholesale      34,232,200
    2b retail         15,575,500
    2b non-moving     47,204,550

  latest2.xlsx:
    1a wholesale     412,445,065
    1b agent-whl     208,794,665

Recommended order
-----------------

1. Drop the latest Excel exports here as latest.xlsx and latest2.xlsx.

2. Extract:

     npm run script:extract-april-debts

3. Seed dry-run:

     npm run script:seed-april-debts

   Review these reports:

     scripts/unmatched-debts-report.json
     scripts/april-customers-from-excel.json
     scripts/april-customers-with-unpaid-in-db.json
     scripts/april-customers-overlap.json

4. Fix unmatched or ambiguous names in ONE file only:

     scripts/data/april-2026-debts/name-overrides.ts

   Re-run the seed dry-run until the reports look correct.

5. Seed opening balances:

     npm run script:seed-april-debts:apply

   The reset deletes only PRE-SYS-* script-generated invoices. Manual pre-April
   invoices are preserved.

6. Apply payments:

     npm run script:apply-april-payments
     npm run script:apply-april-payments:apply

   Phase 1 marks pre-April non-PRE-SYS invoices as PAID with no cash effect.
   Phase 2 reverses old EXCEL-APR2026:* payments, then phases 3-4 replay daily
   cash/bank payments from the JSON.

7. Reconcile:

     npm run script:reconcile-april-daily-debt
     npm run script:reconcile-pre-sys-excel

   The daily-debt reconciler compares the JSON المديونية column with DB
   SalesInvoice totals per customer per day.
