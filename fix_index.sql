-- Fix for missing customers_isAgentCustomer_idx index
-- Run this on your main database before running migrations

-- Create the index if it doesn't exist
CREATE INDEX IF NOT EXISTS "customers_isAgentCustomer_idx" ON "customers"("isAgentCustomer");

