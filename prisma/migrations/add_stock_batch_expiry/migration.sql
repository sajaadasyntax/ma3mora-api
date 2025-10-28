-- CreateTable
CREATE TABLE "stock_batches" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptId" TEXT,
    "notes" TEXT,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_batches_inventoryId_itemId_idx" ON "stock_batches"("inventoryId", "itemId");

-- CreateIndex
CREATE INDEX "stock_batches_expiryDate_idx" ON "stock_batches"("expiryDate");

-- CreateIndex
CREATE INDEX "stock_batches_receiptId_idx" ON "stock_batches"("receiptId");

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "inventories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "inventory_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing stock as batches (optional - can be skipped if starting fresh)
-- This creates batches from existing inventory stock
-- Note: This will create batches for all existing stock. If you want to skip this, comment out the INSERT statement below.
-- INSERT INTO "stock_batches" ("id", "inventoryId", "itemId", "quantity", "expiryDate", "receivedAt", "receiptId", "notes")
-- SELECT 
--     gen_random_uuid(),
--     "inventoryId",
--     "itemId",
--     "quantity",
--     NULL,
--     CURRENT_TIMESTAMP,
--     NULL,
--     'Backfilled from existing stock'
-- FROM "inventory_stocks"
-- WHERE "quantity" > 0;

