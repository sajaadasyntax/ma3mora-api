-- Full System Enhancement Migration
-- Covers: enum changes, new models, model modifications, aggregate updates

-- ============================================================
-- STEP 1: Enum Changes
-- ============================================================

-- 1a. Rename BANK to BANKAK in PaymentMethod (PostgreSQL 10+)
ALTER TYPE "PaymentMethod" RENAME VALUE 'BANK' TO 'BANKAK';

-- 1b. Add new payment methods
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'DEBT';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'OTHERS';

-- 1c. Add BAKERY_CUSTOMER to CustomerType
ALTER TYPE "CustomerType" ADD VALUE IF NOT EXISTS 'BAKERY_CUSTOMER';

-- 1d. Create new enum types
CREATE TYPE "MovementType" AS ENUM ('INBOUND', 'INBOUND_GIFT', 'OUTBOUND', 'OUTBOUND_GIFT');
CREATE TYPE "WarehouseType" AS ENUM ('MAIN', 'ROAD', 'SIDE');
CREATE TYPE "JournalEntryType" AS ENUM ('SALE', 'PURCHASE', 'EXPENSE', 'INCOME', 'SALARY', 'ADVANCE', 'CASH_EXCHANGE', 'RETURN', 'TREASURY', 'OTHER');
CREATE TYPE "TransactionDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "TreasuryType" AS ENUM ('CASH_IN', 'CASH_OUT');
CREATE TYPE "BankakDirection" AS ENUM ('IN', 'OUT');
CREATE TYPE "LoanEntityType" AS ENUM ('PERSONAL', 'BUSINESS');

-- ============================================================
-- STEP 2: Modify Existing Tables
-- ============================================================

-- 2a. Inventory: Add warehouseType
ALTER TABLE "inventories" ADD COLUMN IF NOT EXISTS "warehouseType" "WarehouseType" NOT NULL DEFAULT 'MAIN';

-- 2b. StockMovement: Add movementType
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "movementType" "MovementType";

-- 2c. ProcOrderItem: Add isGiftCompensation
ALTER TABLE "proc_order_items" ADD COLUMN IF NOT EXISTS "isGiftCompensation" BOOLEAN NOT NULL DEFAULT false;

-- 2d. Expense: Add expenseHeadId
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "expenseHeadId" TEXT;
CREATE INDEX IF NOT EXISTS "expenses_expenseHeadId_idx" ON "expenses"("expenseHeadId");

-- 2e. Salary: Add deductions, netAmount, openingLoanBalance, closingLoanBalance
ALTER TABLE "salaries" ADD COLUMN IF NOT EXISTS "deductions" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "salaries" ADD COLUMN IF NOT EXISTS "netAmount" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "salaries" ADD COLUMN IF NOT EXISTS "openingLoanBalance" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "salaries" ADD COLUMN IF NOT EXISTS "closingLoanBalance" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 2f. Advance: Add remainingBalance, isFullyPaid
ALTER TABLE "advances" ADD COLUMN IF NOT EXISTS "remainingBalance" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "advances" ADD COLUMN IF NOT EXISTS "isFullyPaid" BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- STEP 3: Create New Tables
-- ============================================================

-- 3a. ExpenseGroup
CREATE TABLE IF NOT EXISTS "expense_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expense_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "expense_groups_name_key" ON "expense_groups"("name");

-- 3b. ExpenseHead
CREATE TABLE IF NOT EXISTS "expense_heads" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expense_heads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "expense_heads_groupId_name_key" ON "expense_heads"("groupId", "name");
ALTER TABLE "expense_heads" ADD CONSTRAINT "expense_heads_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "expense_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3c. Add FK for expenses.expenseHeadId
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expenseHeadId_fkey" FOREIGN KEY ("expenseHeadId") REFERENCES "expense_heads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3d. CustomerPayment
CREATE TABLE IF NOT EXISTS "customer_payments" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "referenceNumber" TEXT,
    "receiptUrl" TEXT,
    "notes" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "customer_payments_customerId_idx" ON "customer_payments"("customerId");
CREATE INDEX IF NOT EXISTS "customer_payments_createdAt_idx" ON "customer_payments"("createdAt");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_recordedBy_fkey" FOREIGN KEY ("recordedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3e. TreasuryTransaction
CREATE TABLE IF NOT EXISTS "treasury_transactions" (
    "id" TEXT NOT NULL,
    "type" "TreasuryType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "customerId" TEXT,
    "description" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "treasury_transactions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "treasury_transactions_customerId_idx" ON "treasury_transactions"("customerId");
CREATE INDEX IF NOT EXISTS "treasury_transactions_createdAt_idx" ON "treasury_transactions"("createdAt");
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3f. BankakTransaction
CREATE TABLE IF NOT EXISTS "bankak_transactions" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "direction" "BankakDirection" NOT NULL,
    "referenceNumber" TEXT,
    "customerId" TEXT,
    "description" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bankak_transactions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "bankak_transactions_referenceNumber_idx" ON "bankak_transactions"("referenceNumber");
CREATE INDEX IF NOT EXISTS "bankak_transactions_customerId_idx" ON "bankak_transactions"("customerId");
CREATE INDEX IF NOT EXISTS "bankak_transactions_createdAt_idx" ON "bankak_transactions"("createdAt");
ALTER TABLE "bankak_transactions" ADD CONSTRAINT "bankak_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bankak_transactions" ADD CONSTRAINT "bankak_transactions_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3g. SalesDeposit
CREATE TABLE IF NOT EXISTS "sales_deposits" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sales_deposits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sales_deposits_customerId_idx" ON "sales_deposits"("customerId");
CREATE INDEX IF NOT EXISTS "sales_deposits_createdAt_idx" ON "sales_deposits"("createdAt");
ALTER TABLE "sales_deposits" ADD CONSTRAINT "sales_deposits_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_deposits" ADD CONSTRAINT "sales_deposits_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3h. RecoveredLoan
CREATE TABLE IF NOT EXISTS "recovered_loans" (
    "id" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityType" "LoanEntityType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recovered_loans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "recovered_loans_createdAt_idx" ON "recovered_loans"("createdAt");
ALTER TABLE "recovered_loans" ADD CONSTRAINT "recovered_loans_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3i. SalesReturn
CREATE TABLE IF NOT EXISTS "sales_returns" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "returnedBy" TEXT NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sales_returns_invoiceId_idx" ON "sales_returns"("invoiceId");
CREATE INDEX IF NOT EXISTS "sales_returns_returnedAt_idx" ON "sales_returns"("returnedAt");
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_returnedBy_fkey" FOREIGN KEY ("returnedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3j. SalesReturnItem
CREATE TABLE IF NOT EXISTS "sales_return_items" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(15,2) NOT NULL,
    "unitPrice" DECIMAL(15,2) NOT NULL,
    "lineTotal" DECIMAL(15,2) NOT NULL,
    CONSTRAINT "sales_return_items_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3k. JournalEntry
CREATE TABLE IF NOT EXISTS "journal_entries" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "entryType" "JournalEntryType" NOT NULL,
    "referenceId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "method" "PaymentMethod",
    "description" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "journal_entries_date_idx" ON "journal_entries"("date");
CREATE INDEX IF NOT EXISTS "journal_entries_entryType_date_idx" ON "journal_entries"("entryType", "date");
CREATE INDEX IF NOT EXISTS "journal_entries_referenceId_referenceType_idx" ON "journal_entries"("referenceId", "referenceType");
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3l. EmployeeLoanBalance
CREATE TABLE IF NOT EXISTS "employee_loan_balances" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "openingBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "advancesTaken" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "closingBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    CONSTRAINT "employee_loan_balances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "employee_loan_balances_employeeId_month_year_key" ON "employee_loan_balances"("employeeId", "month", "year");
CREATE INDEX IF NOT EXISTS "employee_loan_balances_employeeId_idx" ON "employee_loan_balances"("employeeId");
ALTER TABLE "employee_loan_balances" ADD CONSTRAINT "employee_loan_balances_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- STEP 4: Add new columns to Aggregate Tables
-- ============================================================

-- 4a. DailyFinancialAggregate: new payment method columns + treasury/customer/returns
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "procurementDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "procurementOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "expensesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "expensesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "salariesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "salariesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "advancesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "advancesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "cashExchangesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "cashExchangesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "treasuryInflow" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "treasuryOutflow" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "customerPaymentsTotal" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "customerPaymentsCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesReturnsTotal" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesReturnsCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "netDebt" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_financial_aggregates" ADD COLUMN IF NOT EXISTS "netOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 4b. MonthlyFinancialAggregate: same new columns + income fields that were missing
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeTotal" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeCash" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeBank" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeBankNile" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "procurementDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "procurementOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "expensesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "expensesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "incomeOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "salariesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "salariesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "advancesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "advancesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "cashExchangesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "cashExchangesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "treasuryInflow" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "treasuryOutflow" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "customerPaymentsTotal" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "customerPaymentsCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesReturnsTotal" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "salesReturnsCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "netDebt" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_financial_aggregates" ADD COLUMN IF NOT EXISTS "netOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 4c. DailyItemSalesAggregate: per-method breakdown
ALTER TABLE "daily_item_sales_aggregates" ADD COLUMN IF NOT EXISTS "totalCash" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_item_sales_aggregates" ADD COLUMN IF NOT EXISTS "totalBankak" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_item_sales_aggregates" ADD COLUMN IF NOT EXISTS "totalBankNile" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_item_sales_aggregates" ADD COLUMN IF NOT EXISTS "totalDebt" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "daily_item_sales_aggregates" ADD COLUMN IF NOT EXISTS "totalOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 4d. CustomerCumulativeAggregate: new payment methods + account payments
ALTER TABLE "customer_cumulative_aggregates" ADD COLUMN IF NOT EXISTS "salesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "customer_cumulative_aggregates" ADD COLUMN IF NOT EXISTS "salesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "customer_cumulative_aggregates" ADD COLUMN IF NOT EXISTS "totalAccountPayments" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- 4e. SupplierCumulativeAggregate: new payment methods
ALTER TABLE "supplier_cumulative_aggregates" ADD COLUMN IF NOT EXISTS "purchasesDebtMethod" DECIMAL(15,2) NOT NULL DEFAULT 0;
ALTER TABLE "supplier_cumulative_aggregates" ADD COLUMN IF NOT EXISTS "purchasesOthers" DECIMAL(15,2) NOT NULL DEFAULT 0;
