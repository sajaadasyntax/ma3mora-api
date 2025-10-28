import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(blockAuditorWrites); // Manager and Inventory can write, Auditor cannot

router.get('/', async (req: AuthRequest, res) => {
  try {
    const inventories = await prisma.inventory.findMany({
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    });
    res.json(inventories);
  } catch (error) {
    console.error('Get inventories error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/:id/stocks', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'PROCUREMENT', 'SALES_GROCERY', 'SALES_BAKERY'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { section } = req.query;

    const where: any = { inventoryId: id };
    if (section) {
      where.item = { section };
    }

    const stocks = await prisma.inventoryStock.findMany({
      where,
      include: {
        item: {
          include: {
            prices: true,
          },
        },
        batches: {
          where: {
            quantity: {
              gt: 0,
            },
          },
          include: {
            receipt: {
              include: {
                order: {
                  include: {
                    supplier: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
          // Ensure we get all batches even if receiptId is null
          orderBy: {
            receivedAt: 'asc',
          },
        },
      },
      orderBy: {
        item: { name: 'asc' },
      },
    });

    // Helper function to safely parse dates (defined once for reuse)
    const parseDate = (dateValue: any): Date | null => {
      if (!dateValue) return null;
      if (dateValue instanceof Date) return dateValue;
      try {
        const parsed = new Date(dateValue);
        return isNaN(parsed.getTime()) ? null : parsed;
      } catch (error) {
        console.error('Error parsing date:', dateValue, error);
        return null;
      }
    };

    // Add expiry information to each stock item
    const stocksWithExpiry = stocks.map((stock) => {
      try {
        let batches = stock.batches || [];
        
        // Sort batches: expiry date (earliest first, nulls last), then received date
        batches = [...batches].sort((a, b) => {
          try {
            const aExpiry = parseDate(a?.expiryDate);
            const bExpiry = parseDate(b?.expiryDate);
            if (aExpiry && bExpiry) {
              const dateDiff = aExpiry.getTime() - bExpiry.getTime();
              if (dateDiff !== 0) return dateDiff;
            }
            if (aExpiry && !bExpiry) return -1;
            if (!aExpiry && bExpiry) return 1;
            const aReceived = parseDate(a?.receivedAt);
            const bReceived = parseDate(b?.receivedAt);
            if (aReceived && bReceived) {
              return aReceived.getTime() - bReceived.getTime();
            }
            return 0;
          } catch (err) {
            console.error('Error sorting batches:', err);
            return 0;
          }
        });
        
        const now = new Date();
        const expiredBatches = batches.filter((batch) => {
          try {
            const expiryDate = parseDate(batch?.expiryDate);
            return expiryDate !== null && expiryDate < now;
          } catch (err) {
            console.error('Error checking expired batch:', err);
            return false;
          }
        });
        
        const expiringSoonBatches = batches.filter((batch) => {
          try {
            const expiryDate = parseDate(batch?.expiryDate);
            if (!expiryDate) return false;
            const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            return daysUntilExpiry > 0 && daysUntilExpiry <= 30; // Within 30 days
          } catch (err) {
            console.error('Error checking expiring soon batch:', err);
            return false;
          }
        });
        
        const earliestExpiry = batches
          .map((b) => {
            try {
              return parseDate(b?.expiryDate);
            } catch {
              return null;
            }
          })
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0] || null;

        return {
          ...stock,
          batches: batches.map((b: any) => {
            try {
              const expiryDate = parseDate(b?.expiryDate);
              const receivedAtDate = parseDate(b?.receivedAt);
              
              const batchData: any = {
                id: b?.id,
                inventoryId: b?.inventoryId,
                itemId: b?.itemId,
                quantity: b?.quantity || 0,
                expiryDate: expiryDate ? expiryDate.toISOString() : null,
                receivedAt: receivedAtDate ? receivedAtDate.toISOString() : new Date().toISOString(),
                receiptId: b?.receiptId || null,
                notes: b?.notes || null,
                item: b?.item || null,
              };
              
              // Safely handle receipt with null checks
              try {
                if (b?.receipt && b.receipt.order) {
                  batchData.receipt = {
                    id: b.receipt.id,
                    orderId: b.receipt.orderId,
                    receivedBy: b.receipt.receivedBy,
                    receivedAt: (() => {
                      try {
                        const receiptDate = parseDate(b.receipt?.receivedAt);
                        return receiptDate ? receiptDate.toISOString() : null;
                      } catch {
                        return null;
                      }
                    })(),
                    notes: b.receipt.notes || null,
                    order: {
                      orderNumber: b.receipt.order?.orderNumber || null,
                      supplier: b.receipt.order?.supplier || null,
                    },
                  };
                } else {
                  batchData.receipt = null;
                }
              } catch (err) {
                console.error('Error processing receipt for batch:', b?.id, err);
                batchData.receipt = null;
              }
              
              return batchData;
            } catch (err) {
              console.error('Error processing batch:', b?.id, err);
              // Return minimal batch data on error
              return {
                id: b?.id || 'unknown',
                inventoryId: b?.inventoryId,
                itemId: b?.itemId,
                quantity: b?.quantity || 0,
                expiryDate: null,
                receivedAt: new Date().toISOString(),
                receiptId: null,
                notes: null,
                item: null,
                receipt: null,
              };
            }
          }),
          expiryInfo: {
            hasExpired: expiredBatches.length > 0,
            expiringSoon: expiringSoonBatches.length > 0,
            earliestExpiry: earliestExpiry ? earliestExpiry.toISOString() : null,
            expiredQuantity: expiredBatches.reduce((sum, b) => {
              try {
                return sum + parseFloat((b?.quantity || 0).toString());
              } catch {
                return sum;
              }
            }, 0),
            expiringSoonQuantity: expiringSoonBatches.reduce((sum, b) => {
              try {
                return sum + parseFloat((b?.quantity || 0).toString());
              } catch {
                return sum;
              }
            }, 0),
          },
        };
      } catch (err) {
        console.error('Error processing stock:', stock?.inventoryId, stock?.itemId, err);
        // Return minimal stock data on error
        return {
          ...stock,
          batches: [],
          expiryInfo: {
            hasExpired: false,
            expiringSoon: false,
            earliestExpiry: null,
            expiredQuantity: 0,
            expiringSoonQuantity: 0,
          },
        };
      }
    });

    res.json(stocksWithExpiry);
  } catch (error) {
    console.error('Get stocks error:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      // Log more details for debugging
      if ('code' in error) {
        console.error('Error code:', (error as any).code);
      }
      if ('meta' in error) {
        console.error('Error meta:', (error as any).meta);
      }
    }
    res.status(500).json({ 
      error: 'خطأ في الخادم', 
      details: error instanceof Error ? error.message : String(error),
      stack: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined
    });
  }
});

// Get stock batches with expiry information
router.get('/:id/stocks/:itemId/batches', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { id, itemId } = req.params;

    const batches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: id,
        itemId: itemId,
        quantity: {
          gt: 0,
        },
      },
      include: {
        item: true,
        receipt: {
          include: {
            order: {
              include: {
                supplier: true,
              },
            },
          },
        },
      },
      orderBy: {
        receivedAt: 'asc',
      },
    });

    res.json(batches.map(batch => ({
      ...batch,
      expiryDate: batch.expiryDate ? new Date(batch.expiryDate).toISOString() : null,
      receivedAt: new Date(batch.receivedAt).toISOString(),
    })));
  } catch (error) {
    console.error('Get stock batches error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get expiry alerts
router.get('/expiry-alerts', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { days = 30 } = req.query;
    const daysThreshold = parseInt(days as string) || 30;

    const now = new Date();
    const thresholdDate = new Date();
    thresholdDate.setDate(now.getDate() + daysThreshold);

    // Get batches expiring soon or expired
    const batches = await prisma.stockBatch.findMany({
      where: {
        quantity: {
          gt: 0,
        },
        OR: [
          // Expired
          {
            expiryDate: {
              lt: now,
            },
          },
          // Expiring soon
          {
            expiryDate: {
              gte: now,
              lte: thresholdDate,
            },
          },
        ],
      },
      include: {
        item: true,
        inventory: true,
      },
      orderBy: {
        receivedAt: 'asc',
      },
    });

    // Sort batches by expiry date (earliest first)
    batches.sort((a, b) => {
      if (a.expiryDate && b.expiryDate) {
        return a.expiryDate.getTime() - b.expiryDate.getTime();
      }
      if (a.expiryDate && !b.expiryDate) return -1;
      if (!a.expiryDate && b.expiryDate) return 1;
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });

    const alerts = batches.map(batch => {
      const expiryDate = batch.expiryDate ? new Date(batch.expiryDate) : null;
      const daysUntilExpiry = expiryDate 
        ? Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const isExpired = expiryDate && expiryDate < now;

      return {
        ...batch,
        expiryDate: expiryDate ? expiryDate.toISOString() : null,
        receivedAt: new Date(batch.receivedAt).toISOString(),
        daysUntilExpiry,
        isExpired,
        status: isExpired ? 'expired' : (daysUntilExpiry && daysUntilExpiry <= 7 ? 'critical' : 'warning'),
      };
    });

    res.json({
      expired: alerts.filter(a => a.isExpired),
      expiringSoon: alerts.filter(a => !a.isExpired),
      total: alerts.length,
    });
  } catch (error) {
    console.error('Get expiry alerts error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

const transferSchema = z.object({
  fromInventoryId: z.string().min(1, 'المخزن المصدر مطلوب'),
  toInventoryId: z.string().min(1, 'المخزن الهدف مطلوب'),
  itemId: z.string().min(1, 'الصنف مطلوب'),
  quantity: z.number().positive('الكمية يجب أن تكون أكبر من صفر'),
  notes: z.string().optional(),
});

// Get all transfers
router.get('/transfers', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, itemId, startDate, endDate } = req.query;
    
    const where: any = {};
    if (inventoryId) {
      where.OR = [
        { fromInventoryId: inventoryId as string },
        { toInventoryId: inventoryId as string },
      ];
    }
    if (itemId) {
      where.itemId = itemId as string;
    }
    if (startDate || endDate) {
      where.transferredAt = {};
      if (startDate) {
        where.transferredAt.gte = new Date(startDate as string);
      }
      if (endDate) {
        where.transferredAt.lte = new Date(endDate as string);
      }
    }

    const transfers = await prisma.inventoryTransfer.findMany({
      where,
      include: {
        fromInventory: true,
        toInventory: true,
        item: true,
        transferredByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { transferredAt: 'desc' },
    });

    res.json(transfers);
  } catch (error) {
    console.error('Get transfers error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Create transfer
router.post('/transfers', requireRole('INVENTORY', 'MANAGER'), createAuditLog('InventoryTransfer'), async (req: AuthRequest, res) => {
  try {
    const data = transferSchema.parse(req.body);

    if (data.fromInventoryId === data.toInventoryId) {
      return res.status(400).json({ error: 'لا يمكن نقل الأصناف من مخزن إلى نفسه' });
    }

    // Check if source inventory has enough stock
    const sourceStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: data.fromInventoryId,
          itemId: data.itemId,
        },
      },
    });

    if (!sourceStock || sourceStock.quantity.lessThan(data.quantity)) {
      return res.status(400).json({ 
        error: 'الكمية المتاحة غير كافية',
        available: sourceStock ? sourceStock.quantity.toFixed(2) : '0',
      });
    }

    // Use a transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Create the transfer record
      const transfer = await tx.inventoryTransfer.create({
        data: {
          ...data,
          quantity: new Prisma.Decimal(data.quantity),
          transferredBy: req.user!.id,
        },
        include: {
          fromInventory: true,
          toInventory: true,
          item: true,
          transferredByUser: {
            select: { id: true, username: true },
          },
        },
      });

      // Decrease source inventory stock
      await tx.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: data.fromInventoryId,
            itemId: data.itemId,
          },
        },
        data: {
          quantity: {
            decrement: data.quantity,
          },
        },
      });

      // Increase destination inventory stock (create if doesn't exist)
      const destStock = await tx.inventoryStock.findUnique({
        where: {
          inventoryId_itemId: {
            inventoryId: data.toInventoryId,
            itemId: data.itemId,
          },
        },
      });

      if (destStock) {
        await tx.inventoryStock.update({
          where: {
            inventoryId_itemId: {
              inventoryId: data.toInventoryId,
              itemId: data.itemId,
            },
          },
          data: {
            quantity: {
              increment: data.quantity,
            },
          },
        });
      } else {
        await tx.inventoryStock.create({
          data: {
            inventoryId: data.toInventoryId,
            itemId: data.itemId,
            quantity: new Prisma.Decimal(data.quantity),
          },
        });
      }

      return transfer;
    });

    res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create transfer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get transfer by ID
router.get('/transfers/:id', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const transfer = await prisma.inventoryTransfer.findUnique({
      where: { id },
      include: {
        fromInventory: true,
        toInventory: true,
        item: true,
        transferredByUser: {
          select: { id: true, username: true },
        },
      },
    });

    if (!transfer) {
      return res.status(404).json({ error: 'نقل الأصناف غير موجود' });
    }

    res.json(transfer);
  } catch (error) {
    console.error('Get transfer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Stock Movement Report - Daily stock movements by item
// Calculates: openingBalance, incoming, outgoing, pendingOutgoing, incomingGifts, outgoingGifts, closingBalance
router.get('/stock-movements', requireRole('INVENTORY', 'SALES_GROCERY', 'SALES_BAKERY', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, itemId, startDate, endDate, section } = req.query;
    
    if (!inventoryId) {
      return res.status(400).json({ error: 'المخزن مطلوب' });
    }

    // Default to today if no date range provided
    const targetStartDate = startDate ? new Date(startDate as string) : new Date();
    const targetEndDate = endDate ? new Date(endDate as string) : new Date(startDate as string);
    
    targetStartDate.setHours(0, 0, 0, 0);
    targetEndDate.setHours(23, 59, 59, 999);

    // Get all items for the inventory (filtered by section if provided)
    const stocksWhere: any = { inventoryId: inventoryId as string };
    if (itemId) {
      stocksWhere.itemId = itemId as string;
    }
    if (section) {
      stocksWhere.item = { section };
    }

    const stocks = await prisma.inventoryStock.findMany({
      where: stocksWhere,
      include: {
        item: true,
      },
    });

    // Get dates range
    const dates: Date[] = [];
    const currentDate = new Date(targetStartDate);
    while (currentDate <= targetEndDate) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const movementsReport = await Promise.all(
      stocks.map(async (stock) => {
        // Calculate movements sequentially so each day can use previous day's closing balance
        const itemMovements = [];
        let previousClosingBalance: Prisma.Decimal | null = null;
        
        // Get initial opening balance for first day
        const firstDayMovement = await prisma.stockMovement.findFirst({
          where: {
            inventoryId: inventoryId as string,
            itemId: stock.itemId,
            movementDate: { lt: targetStartDate },
          },
          orderBy: { movementDate: 'desc' },
        });
        
        if (firstDayMovement) {
          previousClosingBalance = firstDayMovement.closingBalance;
        } else {
          // Calculate from current stock - all future movements
          const currentStock = stock.quantity;
          previousClosingBalance = currentStock;
        }

        for (const date of dates) {
            const dateStart = new Date(date);
            dateStart.setHours(0, 0, 0, 0);
            const dateEnd = new Date(date);
            dateEnd.setHours(23, 59, 59, 999);

            const openingBalance: Prisma.Decimal = previousClosingBalance || new Prisma.Decimal(0);

            // Get incoming from procurement receipts (InventoryReceipt) on this date
            const receipts = await prisma.inventoryReceipt.findMany({
              where: {
                order: {
                  inventoryId: inventoryId as string,
                },
                receivedAt: {
                  gte: dateStart,
                  lte: dateEnd,
                },
              },
              include: {
                order: {
                  include: {
                    items: {
                      where: { itemId: stock.itemId },
                    },
                  },
                },
              },
            });

            const incoming = receipts.reduce((sum, receipt) => {
              const itemTotal = receipt.order.items.reduce((itemSum, item) => 
                itemSum.add(item.quantity), new Prisma.Decimal(0));
              return sum.add(itemTotal);
            }, new Prisma.Decimal(0));

            // Get incoming from transfers TO this inventory
            const incomingTransfers = await prisma.inventoryTransfer.findMany({
              where: {
                toInventoryId: inventoryId as string,
                itemId: stock.itemId,
                transferredAt: {
                  gte: dateStart,
                  lte: dateEnd,
                },
              },
            });

            const incomingFromTransfers = incomingTransfers.reduce((sum, transfer) => 
              sum.add(transfer.quantity), new Prisma.Decimal(0));

            const totalIncoming = incoming.add(incomingFromTransfers);

            // Get outgoing from sales (delivered)
            const deliveredSales = await prisma.salesInvoiceItem.findMany({
              where: {
                itemId: stock.itemId,
                invoice: {
                  inventoryId: inventoryId as string,
                  deliveryStatus: 'DELIVERED',
                  createdAt: {
                    gte: dateStart,
                    lte: dateEnd,
                  },
                },
              },
            });

            const outgoing = deliveredSales.reduce((sum, item) => 
              sum.add(item.quantity), new Prisma.Decimal(0));

            const outgoingGifts = deliveredSales.reduce((sum, item) => 
              sum.add(item.giftQty || 0), new Prisma.Decimal(0));

            // Get pending outgoing (not delivered)
            const pendingSales = await prisma.salesInvoiceItem.findMany({
              where: {
                itemId: stock.itemId,
                invoice: {
                  inventoryId: inventoryId as string,
                  deliveryStatus: { not: 'DELIVERED' },
                  createdAt: {
                    gte: dateStart,
                    lte: dateEnd,
                  },
                },
              },
            });

            const pendingOutgoing = pendingSales.reduce((sum, item) => 
              sum.add(item.quantity), new Prisma.Decimal(0));

            // Get outgoing from transfers FROM this inventory
            const outgoingTransfers = await prisma.inventoryTransfer.findMany({
              where: {
                fromInventoryId: inventoryId as string,
                itemId: stock.itemId,
                transferredAt: {
                  gte: dateStart,
                  lte: dateEnd,
                },
              },
            });

            const outgoingFromTransfers = outgoingTransfers.reduce((sum, transfer) => 
              sum.add(transfer.quantity), new Prisma.Decimal(0));

            const totalOutgoing = outgoing.add(outgoingFromTransfers);
            const totalPendingOutgoing = pendingOutgoing;

            // Incoming gifts - from procurement (currently 0 as not tracked)
            const incomingGifts = new Prisma.Decimal(0);

            // Calculate closing balance
            const closingBalance: Prisma.Decimal = openingBalance
              .add(totalIncoming)
              .sub(totalOutgoing)
              .sub(totalPendingOutgoing)
              .add(incomingGifts)
              .sub(outgoingGifts);

            // Update previousClosingBalance for next iteration
            previousClosingBalance = closingBalance;

            itemMovements.push({
              date: date.toISOString().split('T')[0],
              openingBalance: openingBalance.toString(),
              incoming: totalIncoming.toString(),
              outgoing: totalOutgoing.toString(),
              pendingOutgoing: totalPendingOutgoing.toString(),
              incomingGifts: incomingGifts.toString(),
              outgoingGifts: outgoingGifts.toString(),
              closingBalance: closingBalance.toString(),
            });
          }

        return {
          itemId: stock.itemId,
          itemName: stock.item.name,
          section: stock.item.section,
          movements: itemMovements,
        };
      })
    );

    res.json({
      inventoryId: inventoryId as string,
      startDate: targetStartDate.toISOString().split('T')[0],
      endDate: targetEndDate.toISOString().split('T')[0],
      items: movementsReport,
    });
  } catch (error) {
    console.error('Stock movements report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

