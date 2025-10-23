-- AlterTable
ALTER TABLE "opening_balances" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "isClosed" BOOLEAN NOT NULL DEFAULT false;
