-- Add CHECK constraints to prevent negative stock quantities
ALTER TABLE "InventoryStock" ADD CONSTRAINT "check_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "StockBatch" ADD CONSTRAINT "check_batch_quantity_non_negative" CHECK ("quantity" >= 0);
