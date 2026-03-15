-- VOID added in full_system_enhancement; this migration is a no-op for compatibility
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JournalEntryType') THEN
    ALTER TYPE "JournalEntryType" ADD VALUE IF NOT EXISTS 'VOID';
  END IF;
END $$;
