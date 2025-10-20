-- AlterTable
ALTER TABLE "proc_orders" ADD COLUMN     "paymentConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "paymentConfirmedBy" TEXT;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "paymentConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "paymentConfirmedBy" TEXT;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_paymentConfirmedBy_fkey" FOREIGN KEY ("paymentConfirmedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proc_orders" ADD CONSTRAINT "proc_orders_paymentConfirmedBy_fkey" FOREIGN KEY ("paymentConfirmedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
