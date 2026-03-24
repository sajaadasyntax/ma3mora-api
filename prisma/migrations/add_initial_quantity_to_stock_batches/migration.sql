-- Add initialQuantity column to stock_batches to preserve original received quantity
-- (quantity is mutable and decremented by sales/transfers; initialQuantity stays constant)
-- Data backfill is handled separately via: scripts/backfill-initial-quantity.ts
ALTER TABLE "stock_batches" ADD COLUMN "initialQuantity" DECIMAL(15,2);
