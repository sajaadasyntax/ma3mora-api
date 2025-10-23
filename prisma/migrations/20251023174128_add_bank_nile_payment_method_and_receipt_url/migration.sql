-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'BANK_NILE';

-- AlterTable
ALTER TABLE "sales_payments" ADD COLUMN     "receiptUrl" TEXT;
