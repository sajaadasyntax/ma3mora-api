-- Increase Decimal precision for all financial and quantity fields
-- This migration updates Decimal(10,2) to Decimal(15,2) to support larger values
-- Decimal(10,2) can only store up to 99,999,999.99
-- Decimal(15,2) can store up to 999,999,999,999,999.99
-- This change is safe for production as it only increases the maximum allowed value
-- Existing data will remain unchanged

-- Step 1: Update sales_invoices table
ALTER TABLE "sales_invoices" 
  ALTER COLUMN "subtotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "discount" TYPE DECIMAL(15,2),
  ALTER COLUMN "total" TYPE DECIMAL(15,2),
  ALTER COLUMN "paidAmount" TYPE DECIMAL(15,2);

-- Step 2: Update sales_invoice_items table
ALTER TABLE "sales_invoice_items"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2),
  ALTER COLUMN "giftQty" TYPE DECIMAL(15,2),
  ALTER COLUMN "giftQuantity" TYPE DECIMAL(15,2),
  ALTER COLUMN "unitPrice" TYPE DECIMAL(15,2),
  ALTER COLUMN "lineTotal" TYPE DECIMAL(15,2);

-- Step 3: Update sales_payments table
ALTER TABLE "sales_payments"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 4: Update item_prices table
ALTER TABLE "item_prices"
  ALTER COLUMN "price" TYPE DECIMAL(15,2);

-- Step 5: Update item_offers table
ALTER TABLE "item_offers"
  ALTER COLUMN "offerPrice" TYPE DECIMAL(15,2);

-- Step 6: Update inventory_stocks table
ALTER TABLE "inventory_stocks"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2);

-- Step 7: Update stock_batches table
ALTER TABLE "stock_batches"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2);

-- Step 8: Update inventory_transfers table
ALTER TABLE "inventory_transfers"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2);

-- Step 9: Update stock_movements table
ALTER TABLE "stock_movements"
  ALTER COLUMN "openingBalance" TYPE DECIMAL(15,2),
  ALTER COLUMN "incoming" TYPE DECIMAL(15,2),
  ALTER COLUMN "outgoing" TYPE DECIMAL(15,2),
  ALTER COLUMN "pendingOutgoing" TYPE DECIMAL(15,2),
  ALTER COLUMN "incomingGifts" TYPE DECIMAL(15,2),
  ALTER COLUMN "outgoingGifts" TYPE DECIMAL(15,2),
  ALTER COLUMN "closingBalance" TYPE DECIMAL(15,2);

-- Step 10: Update proc_order_items table
ALTER TABLE "proc_order_items"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2),
  ALTER COLUMN "giftQty" TYPE DECIMAL(15,2),
  ALTER COLUMN "giftQuantity" TYPE DECIMAL(15,2);

-- Step 11: Update inventory_delivery_items table
ALTER TABLE "inventory_delivery_items"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2),
  ALTER COLUMN "giftQty" TYPE DECIMAL(15,2),
  ALTER COLUMN "giftQuantity" TYPE DECIMAL(15,2);

-- Step 12: Update inventory_delivery_batches table
ALTER TABLE "inventory_delivery_batches"
  ALTER COLUMN "quantity" TYPE DECIMAL(15,2);

-- Step 13: Update expenses table
ALTER TABLE "expenses"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 14: Update income table
ALTER TABLE "income"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 15: Update opening_balances table
ALTER TABLE "opening_balances"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 16: Update employees table
ALTER TABLE "employees"
  ALTER COLUMN "salary" TYPE DECIMAL(15,2);

-- Step 17: Update salaries table
ALTER TABLE "salaries"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 18: Update advances table
ALTER TABLE "advances"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 19: Update cash_exchanges table
ALTER TABLE "cash_exchanges"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

-- Step 20: Update daily_financial_aggregates table
ALTER TABLE "daily_financial_aggregates"
  ALTER COLUMN "salesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesReceived" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesDebt" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementPaid" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementDebt" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementCancelled" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "incomeTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "incomeCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "incomeBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "incomeBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "cashExchangesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "cashExchangesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "cashExchangesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "netCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "netBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "netBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "netTotal" TYPE DECIMAL(15,2);

-- Step 21: Update monthly_financial_aggregates table
ALTER TABLE "monthly_financial_aggregates"
  ALTER COLUMN "salesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesReceived" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesDebt" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementPaid" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementDebt" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementCancelled" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "procurementBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "expensesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "salariesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "advancesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "cashExchangesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "cashExchangesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "cashExchangesBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "netCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "netBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "netBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "netTotal" TYPE DECIMAL(15,2);

-- Step 22: Update daily_item_sales_aggregates table
ALTER TABLE "daily_item_sales_aggregates"
  ALTER COLUMN "totalQuantity" TYPE DECIMAL(15,2),
  ALTER COLUMN "totalGiftQty" TYPE DECIMAL(15,2),
  ALTER COLUMN "totalAmount" TYPE DECIMAL(15,2),
  ALTER COLUMN "averageUnitPrice" TYPE DECIMAL(15,2);

-- Step 23: Update customer_cumulative_aggregates table
ALTER TABLE "customer_cumulative_aggregates"
  ALTER COLUMN "totalSales" TYPE DECIMAL(15,2),
  ALTER COLUMN "totalPaid" TYPE DECIMAL(15,2),
  ALTER COLUMN "totalOutstanding" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "salesBankNile" TYPE DECIMAL(15,2);

-- Step 24: Update supplier_cumulative_aggregates table
ALTER TABLE "supplier_cumulative_aggregates"
  ALTER COLUMN "totalPurchases" TYPE DECIMAL(15,2),
  ALTER COLUMN "totalPaid" TYPE DECIMAL(15,2),
  ALTER COLUMN "totalOutstanding" TYPE DECIMAL(15,2),
  ALTER COLUMN "purchasesCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "purchasesBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "purchasesBankNile" TYPE DECIMAL(15,2);

-- Step 25: Update cumulative_balance_snapshots table
ALTER TABLE "cumulative_balance_snapshots"
  ALTER COLUMN "openingCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "openingBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "openingBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "closingCash" TYPE DECIMAL(15,2),
  ALTER COLUMN "closingBank" TYPE DECIMAL(15,2),
  ALTER COLUMN "closingBankNile" TYPE DECIMAL(15,2),
  ALTER COLUMN "receivablesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "payablesTotal" TYPE DECIMAL(15,2),
  ALTER COLUMN "payablesWithExpenses" TYPE DECIMAL(15,2);
