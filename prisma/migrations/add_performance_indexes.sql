-- Add indexes for better query performance

-- Sales Invoices indexes
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_customer_id" ON "sales_invoices"("customerId");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_inventory_id" ON "sales_invoices"("inventoryId");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_sales_user_id" ON "sales_invoices"("salesUserId");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_section" ON "sales_invoices"("section");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_payment_status" ON "sales_invoices"("paymentStatus");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_delivery_status" ON "sales_invoices"("deliveryStatus");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_payment_confirmed" ON "sales_invoices"("paymentConfirmed");
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_created_at" ON "sales_invoices"("createdAt" DESC);

-- Procurement Orders indexes
CREATE INDEX IF NOT EXISTS "idx_proc_orders_supplier_id" ON "proc_orders"("supplierId");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_inventory_id" ON "proc_orders"("inventoryId");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_created_by" ON "proc_orders"("createdBy");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_section" ON "proc_orders"("section");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_status" ON "proc_orders"("status");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_payment_confirmed" ON "proc_orders"("paymentConfirmed");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_created_at" ON "proc_orders"("createdAt" DESC);

-- Items indexes
CREATE INDEX IF NOT EXISTS "idx_items_section" ON "items"("section");
CREATE INDEX IF NOT EXISTS "idx_items_name" ON "items"("name");

-- Customers indexes
CREATE INDEX IF NOT EXISTS "idx_customers_type" ON "customers"("type");
CREATE INDEX IF NOT EXISTS "idx_customers_division" ON "customers"("division");

-- Inventory Stock indexes
CREATE INDEX IF NOT EXISTS "idx_inventory_stock_item_id" ON "inventory_stock"("itemId");
CREATE INDEX IF NOT EXISTS "idx_inventory_stock_inventory_id" ON "inventory_stock"("inventoryId");

-- Sales Invoice Items indexes
CREATE INDEX IF NOT EXISTS "idx_sales_invoice_items_invoice_id" ON "sales_invoice_items"("invoiceId");
CREATE INDEX IF NOT EXISTS "idx_sales_invoice_items_item_id" ON "sales_invoice_items"("itemId");

-- Proc Order Items indexes
CREATE INDEX IF NOT EXISTS "idx_proc_order_items_order_id" ON "proc_order_items"("procOrderId");
CREATE INDEX IF NOT EXISTS "idx_proc_order_items_item_id" ON "proc_order_items"("itemId");

-- Expenses indexes
CREATE INDEX IF NOT EXISTS "idx_expenses_created_by" ON "expenses"("createdBy");
CREATE INDEX IF NOT EXISTS "idx_expenses_method" ON "expenses"("method");
CREATE INDEX IF NOT EXISTS "idx_expenses_created_at" ON "expenses"("createdAt" DESC);

-- Audit Logs indexes
CREATE INDEX IF NOT EXISTS "idx_audit_logs_user_id" ON "audit_logs"("userId");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_type" ON "audit_logs"("actionType");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_created_at" ON "audit_logs"("createdAt" DESC);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS "idx_sales_invoices_section_payment_status" ON "sales_invoices"("section", "paymentStatus");
CREATE INDEX IF NOT EXISTS "idx_proc_orders_section_status" ON "proc_orders"("section", "status");
CREATE INDEX IF NOT EXISTS "idx_inventory_stock_inventory_item" ON "inventory_stock"("inventoryId", "itemId");

