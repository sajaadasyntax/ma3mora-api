-- Fix for missing indexes
-- Run this on your main database before running migrations

-- Create the indexes if they don't exist
CREATE INDEX IF NOT EXISTS "customers_isAgentCustomer_idx" ON "customers"("isAgentCustomer");
CREATE INDEX IF NOT EXISTS "expenses_isDebt_idx" ON "expenses"("isDebt");
CREATE INDEX IF NOT EXISTS "income_isDebt_idx" ON "income"("isDebt");

