-- Add CHECK constraints to prevent negative stock quantities
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "check_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "stock_batches" ADD CONSTRAINT "check_batch_quantity_non_negative" CHECK ("quantity" >= 0);
