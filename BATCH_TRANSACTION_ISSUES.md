# Batch Transaction Issues Analysis

## Summary
The diagnostic script found **2,427 total issues** across batch tracking, delivery tracking, and financial aggregates.

## Critical Issues Found

### 1. Missing Batch Creation on Receipt (66 items affected)

**Location**: `apps/api/src/routes/procurement.ts:592`

**Problem**: 
- Batches are **optional** when receiving procurement orders (`batches: z.array(batchItemSchema).optional()`)
- When batches are not provided, stock quantity is incremented but **no batches are created**
- This causes stock quantities to exist without corresponding batch records

**Evidence from diagnostic**:
```
معكرونة نوبو 300 جم * 20 (المخزن الرئيسي)
  Stock Qty: 65
  Batch Sum: 0
  Difference: -65
  Batches: 0
```

**Root Cause**: 
- Lines 640-670: Code only creates batches if `batches && batches.length > 0`
- If batches array is empty or not provided, stock is still incremented (line 736) but no batch records are created

**Impact**: 
- Cannot track expiry dates for items
- Cannot use FIFO batch tracking
- Stock quantities exist without batch history

---

### 2. Missing Delivery Batch Tracking Records (2,186 deliveries affected)

**Location**: `apps/api/src/routes/sales.ts:1078-1100`

**Problem**: 
- Batches are consumed (quantities updated) but **`InventoryDeliveryBatch` records are NEVER created**
- Delivery items are created (lines 1233-1242) but batch tracking is missing
- This breaks the audit trail linking deliveries to specific batches

**Evidence from diagnostic**:
```
Invoice: INV-000174 - الالي
  Delivery Qty: 102
  Batch Sum: 0
  Difference: -102
  [ERROR] DELIVERY_BATCH_MISMATCH: Delivery batch sum (0) does not match item quantity (102)
```

**Root Cause**:
- Lines 1078-1100: Batches are consumed (quantities decremented) but no `InventoryDeliveryBatch.create()` calls
- The `partial-deliver` endpoint (lines 1494-1500) DOES create batch tracking records, but the main `deliver` endpoint does not

**Impact**:
- Cannot trace which batches were used in deliveries
- Cannot audit batch consumption
- Delivery batch sum always shows 0

**Code Comparison**:
- ✅ `partial-deliver` endpoint (line 1494): Creates `InventoryDeliveryBatch` records
- ❌ `deliver` endpoint (lines 1078-1100): Does NOT create `InventoryDeliveryBatch` records

---

### 3. Financial Aggregate Mismatches (165 dates affected)

**Location**: `apps/api/src/services/aggregationService.ts`

**Problem**: 
- Sales received amounts don't match calculated values from source transactions
- Some aggregates show higher values than calculated, suggesting double-counting or incorrect incremental updates

**Evidence from diagnostic**:
```
Date: 2025-12-30
  [ERROR] SALES_RECEIVED_MISMATCH: Sales received mismatch: calculated 1435000, stored 2355000

Date: 2025-12-27
  [ERROR] SALES_TOTAL_MISMATCH: Sales total mismatch: calculated 41086000, stored 42111000
  [ERROR] SALES_RECEIVED_MISMATCH: Sales received mismatch: calculated 29812000, stored 52727250
```

**Root Cause**:
- Aggregates are updated incrementally (lines 76-108 in aggregationService.ts)
- If transactions are processed multiple times or aggregates are recalculated incorrectly, values can drift
- The `recalculateDate` method (line 911) deletes and recreates, but may not be called for all dates

**Impact**:
- Financial reports show incorrect totals
- Reconciliation issues
- Potential accounting errors

---

### 4. Batch Quantity Mismatches (75 items affected)

**Location**: Multiple locations

**Problem**: 
- Stock quantities don't match sum of batch quantities
- Some items have batches but stock is lower (batches consumed but stock not decremented properly)
- Some items have stock but no batches (issue #1)

**Evidence from diagnostic**:
```
البلدي (المخزن الرئيسي)
  Stock Qty: 220
  Batch Sum: 900
  Difference: 680
  Batches: 7
```

**Root Cause**:
- Stock updates and batch updates can get out of sync
- Transfers, adjustments, or manual stock changes may not update batches
- Delivery code decrements stock separately from batches (lines 1103-1116)

**Impact**:
- Inventory accuracy issues
- Cannot rely on batch sums for stock validation

---

### 5. Expired Batches Still in Stock (6 batches, 3,289 quantity)

**Location**: `apps/api/src/routes/sales.ts` (FIFO sorting)

**Problem**: 
- Expired batches still have quantity remaining
- FIFO logic should consume expired batches first, but some remain

**Evidence from diagnostic**:
```
[WARNING] EXPIRED_BATCHES_SUMMARY
  Found 6 expired batch(es) with 3289 total quantity
  One batch expired 11,617 days ago (1994-03-11)
```

**Root Cause**:
- FIFO logic prioritizes expiry dates but may skip batches with issues
- Some batches may have been created with incorrect expiry dates
- No automatic cleanup of expired batches

**Impact**:
- Risk of selling expired products
- Inventory management issues

---

## Recommended Fixes

### Fix 1: Always Create Batches on Receipt

**File**: `apps/api/src/routes/procurement.ts`

**Change**: Make batches mandatory or create default batches when not provided

```typescript
// Option A: Create default batch if none provided
if (!batches || batches.length === 0) {
  // Create default batches for all order items
  for (const orderItem of order.items) {
    await tx.stockBatch.create({
      data: {
        inventoryId: order.inventoryId,
        itemId: orderItem.itemId,
        quantity: orderItem.quantity,
        receiptId: receipt.id,
      },
    });
  }
}
```

### Fix 2: Create Delivery Batch Tracking Records

**File**: `apps/api/src/routes/sales.ts`

**Change**: Add `InventoryDeliveryBatch` record creation in the deliver endpoint

```typescript
// After line 1100, before creating delivery record
const deliveryItem = await tx.inventoryDeliveryItem.create({
  data: {
    deliveryId: delivery.id,
    itemId: item.itemId,
    quantity: remainingToDeliver,
    // ... other fields
  },
});

// Track which batches were consumed
let trackedQty = remainingToDeliver;
for (const batch of batches) {
  if (trackedQty.lte(0)) break;
  
  const consumedQty = Prisma.Decimal.min(batch.quantity, trackedQty);
  
  await tx.inventoryDeliveryBatch.create({
    data: {
      deliveryItemId: deliveryItem.id,
      batchId: batch.id,
      quantity: consumedQty,
    },
  });
  
  trackedQty = trackedQty.sub(consumedQty);
}
```

### Fix 3: Recalculate All Financial Aggregates

**File**: `apps/api/src/services/aggregationService.ts`

**Action**: Run recalculation for all affected dates

```typescript
// Create a script to recalculate all aggregates
const affectedDates = [/* dates from diagnostic */];
for (const date of affectedDates) {
  await aggregationService.recalculateDate(date, inventoryId, section);
}
```

### Fix 4: Sync Stock and Batch Quantities

**Action**: Create a repair script to fix mismatches

```typescript
// Option A: Update stock to match batch sum
await tx.inventoryStock.update({
  where: { inventoryId_itemId: { inventoryId, itemId } },
  data: { quantity: batchSum },
});

// Option B: Create missing batches for stock without batches
if (stock.quantity.gt(0) && batches.length === 0) {
  await tx.stockBatch.create({
    data: {
      inventoryId,
      itemId,
      quantity: stock.quantity,
      notes: 'Repaired: Created batch for existing stock',
    },
  });
}
```

### Fix 5: Handle Expired Batches

**Action**: Add validation and cleanup

```typescript
// Add expiry check in delivery logic
const expiredBatches = batches.filter(b => 
  b.expiryDate && b.expiryDate < new Date() && b.quantity.gt(0)
);

if (expiredBatches.length > 0) {
  // Log warning or prevent delivery
  console.warn('Warning: Delivering expired batches', expiredBatches);
}
```

---

## Priority Order

1. **HIGH**: Fix delivery batch tracking (Fix 2) - Breaks audit trail
2. **HIGH**: Fix financial aggregates (Fix 3) - Affects reporting accuracy
3. **MEDIUM**: Always create batches on receipt (Fix 1) - Prevents future issues
4. **MEDIUM**: Sync stock and batch quantities (Fix 4) - Data integrity
5. **LOW**: Handle expired batches (Fix 5) - Operational improvement

---

## Testing Checklist

After fixes are applied:

- [ ] Run diagnostic script again: `npm run script:check-batch-transactions`
- [ ] Verify delivery batch tracking shows correct batch sums
- [ ] Verify financial aggregates match calculated values
- [ ] Test receiving order without batches (should create default batches)
- [ ] Test delivery creates batch tracking records
- [ ] Verify stock quantities match batch sums
- [ ] Check expired batch handling

---

## Notes

- The `partial-deliver` endpoint already has correct batch tracking implementation
- Use it as a reference for fixing the main `deliver` endpoint
- Consider making batches mandatory in the API schema to prevent future issues
- Add database constraints to ensure batch sums match stock quantities

