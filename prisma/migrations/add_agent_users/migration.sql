-- CreateEnum: Add AGENT_GROCERY and AGENT_BAKERY to Role enum
-- Note: This is manual migration SQL for when you run the migration

-- Step 1: Add new roles to the Role enum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'AGENT_GROCERY';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'AGENT_BAKERY';

-- Step 2: Add new customer type to CustomerType enum
ALTER TYPE "CustomerType" ADD VALUE IF NOT EXISTS 'AGENT';

-- Step 3: Add isAgentCustomer column to customers table
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "isAgentCustomer" BOOLEAN NOT NULL DEFAULT false;

-- Step 4: Create index on isAgentCustomer for faster queries
CREATE INDEX IF NOT EXISTS "customers_isAgentCustomer_idx" ON "customers"("isAgentCustomer");

