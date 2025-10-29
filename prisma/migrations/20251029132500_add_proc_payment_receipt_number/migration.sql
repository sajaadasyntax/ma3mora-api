-- Add receipt_number to procurement payments and enforce uniqueness
ALTER TABLE "proc_order_payments" ADD COLUMN "receipt_number" TEXT;

ALTER TABLE "proc_order_payments" ADD CONSTRAINT "proc_order_payments_receipt_number_key" UNIQUE ("receipt_number");
