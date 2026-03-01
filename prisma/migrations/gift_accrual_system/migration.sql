-- CreateEnum
CREATE TYPE "GiftLedgerEntryType" AS ENUM ('ACCRUAL', 'DEDUCTION', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "GiftAccrualRule" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "giftItemId" TEXT NOT NULL,
    "triggerQty" INTEGER NOT NULL,
    "giftQty" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GiftAccrualRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierGiftLedger" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "ruleId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryType" "GiftLedgerEntryType" NOT NULL,
    "description" TEXT,
    "itemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "referenceId" TEXT,
    "referenceType" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierGiftLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftAccrualRule_itemId_supplierId_key" ON "GiftAccrualRule"("itemId", "supplierId");
CREATE INDEX "SupplierGiftLedger_supplierId_idx" ON "SupplierGiftLedger"("supplierId");
CREATE INDEX "SupplierGiftLedger_date_idx" ON "SupplierGiftLedger"("date");

-- AddForeignKey (use actual table names from @@map: items, suppliers, users)
ALTER TABLE "GiftAccrualRule" ADD CONSTRAINT "GiftAccrualRule_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GiftAccrualRule" ADD CONSTRAINT "GiftAccrualRule_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GiftAccrualRule" ADD CONSTRAINT "GiftAccrualRule_giftItemId_fkey" FOREIGN KEY ("giftItemId") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierGiftLedger" ADD CONSTRAINT "SupplierGiftLedger_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierGiftLedger" ADD CONSTRAINT "SupplierGiftLedger_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "GiftAccrualRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierGiftLedger" ADD CONSTRAINT "SupplierGiftLedger_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierGiftLedger" ADD CONSTRAINT "SupplierGiftLedger_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
