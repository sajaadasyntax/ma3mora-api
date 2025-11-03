# Sales Report Opening Balance Fix

## Issue Description
The sales report was showing incorrect opening balance (رصيد افتتاحي) values. For example:
- Expected opening balance: 226
- Actual shown: 26
- This caused incorrect closing balance calculations

## Root Cause
There was an inconsistency in how the system queried inventory deliveries when calculating stock for the sales report:

1. **For stockInfo calculation** (lines 1534-1542): Deliveries were queried by `deliveredAt` (delivery date)
2. **For synthetic movements creation** (lines 1692-1698): Deliveries were queried by `invoice.createdAt` (invoice creation date)

This mismatch caused the system to:
- Include/exclude different deliveries in opening vs. closing calculations
- Result in incorrect opening balance when invoices were created on different dates than they were delivered

## Solution Applied
Changed the deliveries query in the synthetic movements section to filter by `deliveredAt` instead of `invoice.createdAt`, making it consistent with the stockInfo calculation.

### Changed Code (api/src/routes/sales.ts, lines 1692-1701):
```typescript
// Before:
const deliveriesWhere: any = {
  invoice: {
    inventoryId: invId,
    deliveryStatus: 'DELIVERED',
    createdAt: {  // INCORRECT - using invoice creation date
      gte: start,
      lte: end,
    },
  },
};

// After:
const deliveriesWhere: any = {
  invoice: {
    inventoryId: invId,
    deliveryStatus: 'DELIVERED',
  },
  deliveredAt: {  // CORRECT - using actual delivery date
    gte: start,
    lte: end,
  },
};
```

## How to Apply the Fix

### Option 1: Restart the API Server
If you're running the API server in development mode:
```bash
cd api
npm run dev
```

### Option 2: Rebuild and Restart (Production)
```bash
cd api
npm run build
# Then restart your API server
```

**Note:** There are pre-existing TypeScript compilation errors in the codebase related to Prisma schema definitions (ItemPrice and InventoryStock models). These don't affect the runtime since the compiled JavaScript is working correctly, but they should be fixed separately.

## Testing the Fix
1. Navigate to the Sales Reports page
2. Select a date range that includes your sales orders
3. Select the inventory and item
4. Verify that:
   - رصيد افتتاحي (opening balance) now shows 226 (correct value)
   - منصرف (dispatched) shows 270 (200 + 70)
   - رصيد ختامي (closing balance) shows -44 (226 - 270)

## Additional Notes
- The fix ensures that all stock calculations use the actual delivery date (`deliveredAt`) rather than the invoice creation date
- This is important because invoices can be created days before actual delivery happens
- The report now accurately reflects stock movement on the dates when items were physically delivered

