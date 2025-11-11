-- Fix agent customers: Set isAgentCustomer = true for customers that have invoices created by agent users
-- This updates customers that were created by the seed script but didn't have isAgentCustomer set

-- Update all customers that have invoices created by agent users
-- This is the most reliable approach as it finds customers based on actual usage
UPDATE "customers" c
SET "isAgentCustomer" = true
FROM "sales_invoices" si
INNER JOIN "users" u ON si."salesUserId" = u.id
WHERE c.id = si."customerId"
  AND u.role IN ('AGENT_GROCERY', 'AGENT_BAKERY')
  AND c."isAgentCustomer" = false;

-- Show how many customers were updated
SELECT COUNT(*) as "customers_updated"
FROM "customers" c
INNER JOIN "sales_invoices" si ON c.id = si."customerId"
INNER JOIN "users" u ON si."salesUserId" = u.id
WHERE u.role IN ('AGENT_GROCERY', 'AGENT_BAKERY')
  AND c."isAgentCustomer" = true;

