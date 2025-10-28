-- AlterTable
ALTER TABLE "users" ADD COLUMN "sessionToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_sessionToken_key" ON "users"("sessionToken") WHERE "sessionToken" IS NOT NULL;

