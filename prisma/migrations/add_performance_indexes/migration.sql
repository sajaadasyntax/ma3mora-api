-- Performance indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS "idx_inventory_transfers_from" ON "inventory_transfers"("fromInventoryId");
CREATE INDEX IF NOT EXISTS "idx_inventory_transfers_to" ON "inventory_transfers"("toInventoryId");
CREATE INDEX IF NOT EXISTS "idx_inventory_transfers_item" ON "inventory_transfers"("itemId");
CREATE INDEX IF NOT EXISTS "idx_inventory_transfers_date" ON "inventory_transfers"("transferredAt");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_payment_confirmation" ON "sales_invoices"("paymentConfirmationStatus");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_delivery_status" ON "sales_invoices"("deliveryStatus");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_inventory_section" ON "sales_invoices"("inventoryId", "section");
