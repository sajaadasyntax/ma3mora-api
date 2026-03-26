-- Add receiptNumber column to opening_balances
ALTER TABLE "opening_balances" ADD COLUMN IF NOT EXISTS "receiptNumber" TEXT;
