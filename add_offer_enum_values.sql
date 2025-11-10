-- Add missing values to CustomerType enum
-- Run this on your database to fix the enum values
-- This script safely adds enum values only if they don't already exist

-- Add AGENT_WHOLESALE to CustomerType enum (if not exists)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'AGENT_WHOLESALE' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustomerType')
    ) THEN
        ALTER TYPE "CustomerType" ADD VALUE 'AGENT_WHOLESALE';
    END IF;
END $$;

-- Add AGENT_RETAIL to CustomerType enum (if not exists)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'AGENT_RETAIL' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustomerType')
    ) THEN
        ALTER TYPE "CustomerType" ADD VALUE 'AGENT_RETAIL';
    END IF;
END $$;

-- Add OFFER_1 to CustomerType enum (if not exists)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'OFFER_1' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustomerType')
    ) THEN
        ALTER TYPE "CustomerType" ADD VALUE 'OFFER_1';
    END IF;
END $$;

-- Add OFFER_2 to CustomerType enum (if not exists)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum 
        WHERE enumlabel = 'OFFER_2' 
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CustomerType')
    ) THEN
        ALTER TYPE "CustomerType" ADD VALUE 'OFFER_2';
    END IF;
END $$;

