-- Fix: refId was FK to both customers and suppliers, causing inserts to fail
-- Split into separate customerId and supplierId columns with proper FKs

-- Step 1: Drop the broken dual FK constraints
ALTER TABLE "opening_balances" DROP CONSTRAINT IF EXISTS "opening_balance_customer_fkey";
ALTER TABLE "opening_balances" DROP CONSTRAINT IF EXISTS "opening_balance_supplier_fkey";

-- Step 2: Add new dedicated columns
ALTER TABLE "opening_balances" ADD COLUMN IF NOT EXISTS "customerId" TEXT;
ALTER TABLE "opening_balances" ADD COLUMN IF NOT EXISTS "supplierId" TEXT;

-- Step 3: Migrate existing data from refId to the correct column
UPDATE "opening_balances" SET "customerId" = "refId" WHERE scope = 'CUSTOMER' AND "refId" IS NOT NULL;
UPDATE "opening_balances" SET "supplierId" = "refId" WHERE scope = 'SUPPLIER' AND "refId" IS NOT NULL;

-- Step 4: Add proper FK constraints (each column references only its own table)
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balance_customer_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balance_supplier_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Step 5: Drop the old refId column
ALTER TABLE "opening_balances" DROP COLUMN IF EXISTS "refId";
