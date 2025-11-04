# Stock Movement System Implementation

## Overview
Implemented a database-backed stock movement tracking system where opening and closing balances are stored in the database instead of being calculated on-the-fly.

## Key Features

### 1. Stored Opening & Closing Balances
- **Opening Balance (الرصيد الافتتاحي)**: Stored in database for each day
- **Closing Balance (الرصيد النهائي)**: Calculated and stored: `Closing = Opening + Incoming - Outgoing`
- **Automatic Propagation**: Next day's opening = Previous day's closing

### 2. Automatic Updates
The system automatically creates/updates StockMovement records when:
- **Sales are delivered** → Updates `outgoing` and `outgoingGifts`
- **Procurement is received** → Updates `incoming` and `incomingGifts`

### 3. Chain Maintenance
When a day's closing balance changes, all future days' opening balances update automatically through the propagation system.

## Implementation Steps

### Step 1: Install & Initialize

```bash
# 1. Reseed database with fixed stock values (recommended)
cd api
npm run prisma:seed

# 2. Initialize StockMovement records for all existing stock
npx ts-node scripts/initialize-stock-movements.ts

# 3. Restart API server
npm run dev
```

### Step 2: Verify

After initialization, create a test sales order and deliver it:
1. Create a sales invoice for "رز" with 100 units
2. Confirm payment
3. Deliver the invoice
4. Check the sales report

**Expected behavior:**
- StockMovement record is automatically created/updated
- Opening balance comes from database (not calculated)
- Closing balance = Opening - Outgoing

## File Structure

```
api/
├── src/
│   ├── services/
│   │   └── stockMovementService.ts     ← NEW: Stock movement service
│   └── routes/
│       ├── sales.ts                    ← MODIFIED: Added StockMovement updates
│       └── procurement.ts              ← MODIFIED: Added StockMovement updates
├── scripts/
│   └── initialize-stock-movements.ts   ← NEW: Initialization script
└── prisma/
    └── seed.ts                         ← MODIFIED: Fixed stock quantities
```

## Database Schema

### StockMovement Table
```prisma
model StockMovement {
  id              String   @id @default(cuid())
  inventoryId     String
  itemId          String
  movementDate    DateTime @db.Date
  openingBalance  Decimal  @db.Decimal(10, 2)  // From previous day or initial
  incoming        Decimal  @default(0) @db.Decimal(10, 2)
  outgoing        Decimal  @default(0) @db.Decimal(10, 2)
  pendingOutgoing Decimal  @default(0) @db.Decimal(10, 2)
  incomingGifts   Decimal  @default(0) @db.Decimal(10, 2)
  outgoingGifts   Decimal  @default(0) @db.Decimal(10, 2)
  closingBalance  Decimal  @db.Decimal(10, 2)  // Calculated and stored
  
  @@unique([inventoryId, itemId, movementDate])
}
```

## How It Works

### Example: Daily Stock Flow

**Day 1 (Initial)**
```
Opening: 500 (from seed)
Incoming: 0
Outgoing: 0
Closing: 500
```

**Day 2 (Sales delivery of 200 units)**
```
Opening: 500 (= Day 1 closing)
Incoming: 0
Outgoing: 200
Closing: 300
```

**Day 3 (Procurement receipt of 150 units)**
```
Opening: 300 (= Day 2 closing)
Incoming: 150
Outgoing: 0
Closing: 450
```

### Automatic Propagation

If you change Day 2's data (e.g., add another delivery of 50 units):
```
Day 2:
Opening: 500
Incoming: 0
Outgoing: 250 (updated from 200)
Closing: 250 (updated from 300)

Day 3: (AUTOMATICALLY UPDATED)
Opening: 250 (updated from 300)
Incoming: 150
Outgoing: 0
Closing: 400 (updated from 450)
```

## API Integration

### Sales Delivery Endpoint
```typescript
POST /api/sales/invoices/:id/deliver

// Automatically creates/updates StockMovement after delivery
// Updates: outgoing, outgoingGifts
// Propagates changes to future days
```

### Procurement Receipt Endpoint
```typescript
POST /api/procurement/orders/:id/receive

// Automatically creates/updates StockMovement after receipt
// Updates: incoming, incomingGifts
// Propagates changes to future days
```

### Sales Report Endpoint
```typescript
GET /api/sales/reports?startDate=2025-11-01&endDate=2025-11-30&viewType=items

// Now reads directly from StockMovement table
// Returns stored opening/closing balances
// Fallback to calculation if StockMovement doesn't exist (backward compatibility)
```

## Benefits

1. **Performance**: No need to calculate opening balance from all historical transactions
2. **Accuracy**: Opening balance is stored and maintained, not derived
3. **Auditability**: Full history of daily opening/closing balances
4. **Consistency**: Next day's opening always equals previous day's closing
5. **Real-time**: Updates happen immediately when deliveries/receipts occur

## Migration Notes

### For Existing Deployments

1. **Backup database** before running initialization
2. Run `initialize-stock-movements.ts` script to create records for current stock
3. Future transactions will automatically maintain the system
4. Old invoices/orders won't have StockMovement records (system falls back to calculation)

### For Fresh Deployments

1. Run `npm run prisma:seed` to create initial data with fixed stock values
2. Run initialization script (optional - seed already creates proper stock)
3. System is ready to track stock movements

## Troubleshooting

### Opening balance doesn't match expected value
- Run the initialization script: `npx ts-node scripts/initialize-stock-movements.ts`
- Check if StockMovement records exist: Query `stock_movements` table
- Verify delivery/receipt dates match movement dates

### Future days not updating
- Check StockMovement service logs for errors
- Verify unique constraint on `(inventoryId, itemId, movementDate)`
- Ensure propagation function is running without errors

### Report shows calculated values instead of stored
- This is normal for dates before StockMovement records exist
- System falls back to calculation for backward compatibility
- Run initialization script to create records for today

## Testing

### Manual Test
```bash
# 1. Check current stock
curl http://localhost:3000/api/inventories/{id}/stocks

# 2. Create and deliver sales order
# (Use the web interface)

# 3. Check StockMovement records
# Query database: SELECT * FROM stock_movements WHERE item_id = '...' ORDER BY movement_date DESC

# 4. Verify sales report
curl "http://localhost:3000/api/sales/reports?startDate=2025-11-01&endDate=2025-11-30&viewType=items"
```

## Support

For issues or questions:
1. Check console logs for StockMovement errors
2. Verify database schema is up to date
3. Ensure transactions are completing successfully
4. Review `SALES_REPORT_FIX.md` for additional context

