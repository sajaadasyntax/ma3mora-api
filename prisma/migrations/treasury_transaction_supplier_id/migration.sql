-- Link treasury rows to supplier for payable balance updates
ALTER TABLE "treasury_transactions" ADD COLUMN "supplierId" TEXT;

ALTER TABLE "treasury_transactions"
  ADD CONSTRAINT "treasury_transactions_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "treasury_transactions_supplierId_idx" ON "treasury_transactions"("supplierId");
