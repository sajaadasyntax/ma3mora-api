-- Add isDebt column to expenses and income tables
-- This migration adds the isDebt boolean column that exists in the Prisma schema
-- but is missing from the database

-- Step 1: Add isDebt column to expenses table
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "isDebt" BOOLEAN NOT NULL DEFAULT false;

-- Step 2: Add isDebt column to income table
ALTER TABLE "income" ADD COLUMN IF NOT EXISTS "isDebt" BOOLEAN NOT NULL DEFAULT false;

-- Step 3: Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "expenses_isDebt_idx" ON "expenses"("isDebt");
CREATE INDEX IF NOT EXISTS "income_isDebt_idx" ON "income"("isDebt");

