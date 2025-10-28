-- AlterTable: Add receiptNumber to sales_payments
ALTER TABLE "sales_payments" ADD COLUMN     "receiptNumber" TEXT;

-- CreateIndex: Make receiptNumber unique
CREATE UNIQUE INDEX "sales_payments_receiptNumber_key" ON "sales_payments"("receiptNumber");

-- CreateTable: Create cash_exchanges table
CREATE TABLE "cash_exchanges" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "fromMethod" "PaymentMethod" NOT NULL,
    "toMethod" "PaymentMethod" NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "receiptUrl" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_exchanges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Make receiptNumber unique
CREATE UNIQUE INDEX "cash_exchanges_receiptNumber_key" ON "cash_exchanges"("receiptNumber");

-- AddForeignKey
ALTER TABLE "cash_exchanges" ADD CONSTRAINT "cash_exchanges_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

