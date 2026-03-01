-- Add updatedAt to ProcOrderPayment and InventoryReceipt; add unique (orderId, itemId) on ProcOrderItem

-- AlterTable
ALTER TABLE "proc_order_payments" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "inventory_receipts" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex (skip if duplicates exist - run: SELECT "orderId", "itemId", COUNT(*) FROM proc_order_items GROUP BY "orderId", "itemId" HAVING COUNT(*) > 1; to check)
CREATE UNIQUE INDEX IF NOT EXISTS "proc_order_items_orderId_itemId_key" ON "proc_order_items"("orderId", "itemId");
