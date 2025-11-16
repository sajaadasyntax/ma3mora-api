-- Increase Decimal precision for procurement order fields
-- This migration updates Decimal(10,2) to Decimal(15,2) to support larger order totals
-- Decimal(10,2) can only store up to 99,999,999.99
-- Decimal(15,2) can store up to 999,999,999,999,999.99

-- Step 1: Update proc_orders table
ALTER TABLE "proc_orders" 
  ALTER COLUMN "total" TYPE DECIMAL(15,2),
  ALTER COLUMN "paidAmount" TYPE DECIMAL(15,2),
  ALTER COLUMN "refundAmount" TYPE DECIMAL(15,2);

-- Step 2: Update proc_order_items table
ALTER TABLE "proc_order_items"
  ALTER COLUMN "unitCost" TYPE DECIMAL(15,2),
  ALTER COLUMN "lineTotal" TYPE DECIMAL(15,2);

-- Step 3: Update proc_order_payments table
ALTER TABLE "proc_order_payments"
  ALTER COLUMN "amount" TYPE DECIMAL(15,2);

