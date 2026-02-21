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

router.get('/:id/stocks', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'PROCUREMENT', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY'), async (req: AuthRequest, res) => {
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
            prices: {
              where: {
                OR: [
                  { inventoryId: id }, // Inventory-specific prices
                  { inventoryId: null }, // Global prices
                ],
              },
              orderBy: [
                { inventoryId: 'desc' }, // Prefer inventory-specific over global
                { validFrom: 'desc' },
              ],
            },
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

        // Calculate total quantity from batches
        const totalQuantityFromBatches = batches.reduce((sum, b) => {
          try {
            return sum + parseFloat((b?.quantity || 0).toString());
          } catch {
            return sum;
          }
        }, 0);

        return {
          ...stock,
          // Always use quantity from batches if batches exist, otherwise use stock.quantity
          quantity: batches.length > 0 ? new Prisma.Decimal(totalQuantityFromBatches) : stock.quantity,
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
router.get('/transfers', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY'), async (req: AuthRequest, res) => {
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
router.post('/transfers', requireRole('INVENTORY', 'MANAGER', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY'), createAuditLog('InventoryTransfer'), async (req: AuthRequest, res) => {
  try {
    const data = transferSchema.parse(req.body);
    // SALES users must have access to the source inventory for the item's section
    if (req.user && (req.user.role === 'SALES_GROCERY' || req.user.role === 'SALES_BAKERY' || req.user.role === 'AGENT_GROCERY' || req.user.role === 'AGENT_BAKERY')) {
      const item = await prisma.item.findUnique({ where: { id: data.itemId } });
      if (!item) {
        return res.status(400).json({ error: 'الصنف غير موجود' });
      }
      const hasAccess = await prisma.userInventoryAccess.findUnique({
        where: {
          userId_inventoryId_section: {
            userId: req.user.id,
            inventoryId: data.fromInventoryId,
            section: item.section,
          },
        },
      });
      if (!hasAccess) {
        return res.status(403).json({ error: 'ليست لديك صلاحية نقل أصناف من هذا المخزن لهذا القسم' });
      }
    }


    if (data.fromInventoryId === data.toInventoryId) {
      return res.status(400).json({ error: 'لا يمكن نقل الأصناف من مخزن إلى نفسه' });
    }

    // Pre-check if source inventory has stock entry (fast path)
    const sourceStock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: data.fromInventoryId,
          itemId: data.itemId,
        },
      },
      select: { quantity: true },
    });

    if (!sourceStock) {
      return res.status(400).json({ 
        error: 'الكمية المتاحة غير كافية',
        available: '0',
      });
    }

    // Check if source stock quantity is sufficient
    const transferQty = new Prisma.Decimal(data.quantity);
    if (sourceStock.quantity.lt(transferQty)) {
      return res.status(400).json({ 
        error: 'الكمية المتاحة غير كافية',
        available: sourceStock.quantity.toString(),
      });
    }

    // Pre-check batches before transaction to ensure consistency
    // This helps catch data inconsistencies early
    const preCheckBatches = await prisma.stockBatch.findMany({
      where: {
        inventoryId: data.fromInventoryId,
        itemId: data.itemId,
        quantity: { gt: 0 },
      },
      select: { quantity: true },
    });

    const totalAvailableInBatchesPreCheck = preCheckBatches.reduce(
      (sum, b) => sum.add(b.quantity),
      new Prisma.Decimal(0)
    );

    // Use the minimum of stock quantity and batch totals for validation
    // This ensures we validate against what we can actually transfer
    const availableForTransfer = Prisma.Decimal.min(
      sourceStock.quantity,
      totalAvailableInBatchesPreCheck
    );

    if (availableForTransfer.lt(transferQty)) {
      return res.status(400).json({ 
        error: 'الكمية المتاحة غير كافية',
        available: availableForTransfer.toString(),
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

      // Get source batches sorted by FIFO (expiry date first, then received date)
      const sourceBatches = await tx.stockBatch.findMany({
        where: {
          inventoryId: data.fromInventoryId,
          itemId: data.itemId,
          quantity: { gt: 0 },
        },
        orderBy: [
          { receivedAt: 'asc' },
        ],
      });

      // Sort batches: expiry date (earliest first, nulls last), then received date
      sourceBatches.sort((a, b) => {
        if (a.expiryDate && b.expiryDate) {
          const dateDiff = a.expiryDate.getTime() - b.expiryDate.getTime();
          if (dateDiff !== 0) return dateDiff;
        }
        if (a.expiryDate && !b.expiryDate) return -1;
        if (!a.expiryDate && b.expiryDate) return 1;
        return a.receivedAt.getTime() - b.receivedAt.getTime();
      });

      // Calculate total available in batches
      const totalAvailableInBatches = sourceBatches.reduce(
        (sum, b) => sum.add(b.quantity),
        new Prisma.Decimal(0)
      );

      // Check if we have enough in batches
      if (totalAvailableInBatches.lt(transferQty)) {
        throw Object.assign(new Error('INSUFFICIENT_STOCK'), {
          code: 'INSUFFICIENT_STOCK',
        });
      }

      // Consume from source batches using FIFO and create destination batches
      let remainingQty = transferQty;
      const transferredBatches: Array<{ expiryDate: Date | null; quantity: Prisma.Decimal; notes: string | null }> = [];

      for (const batch of sourceBatches) {
        if (remainingQty.lte(0)) break;

        const batchQty = new Prisma.Decimal(batch.quantity);
        if (batchQty.lte(0)) continue;

        let consumeQty: Prisma.Decimal;
        if (remainingQty.gte(batchQty)) {
          // Consume entire batch
          consumeQty = batchQty;
          await tx.stockBatch.update({
            where: { id: batch.id },
            data: { quantity: 0 },
          });
        } else {
          // Consume partial batch
          consumeQty = remainingQty;
          await tx.stockBatch.update({
            where: { id: batch.id },
            data: { quantity: batchQty.sub(remainingQty) },
          });
        }

        // Track batch info for creating destination batches
        transferredBatches.push({
          expiryDate: batch.expiryDate,
          quantity: consumeQty,
          notes: batch.notes ? `نقل: ${batch.notes}` : 'نقل من مخزن آخر',
        });

        remainingQty = remainingQty.sub(consumeQty);
      }

      // Decrease source inventory stock
      await tx.inventoryStock.update({
        where: {
          inventoryId_itemId: {
            inventoryId: data.fromInventoryId,
            itemId: data.itemId,
          },
        },
        data: {
          quantity: { decrement: transferQty },
        },
      });

      // Ensure destination inventory stock exists
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
            quantity: { increment: transferQty },
          },
        });
      } else {
        await tx.inventoryStock.create({
          data: {
            inventoryId: data.toInventoryId,
            itemId: data.itemId,
            quantity: transferQty,
          },
        });
      }

      // Create destination batches with same expiry dates (preserving FIFO info)
      // Use a single timestamp for all batches to maintain correct FIFO ordering as a transfer group
      const transferTimestamp = new Date();
      for (const batchInfo of transferredBatches) {
        await tx.stockBatch.create({
          data: {
            inventoryId: data.toInventoryId,
            itemId: data.itemId,
            quantity: batchInfo.quantity,
            expiryDate: batchInfo.expiryDate,
            notes: batchInfo.notes,
            receivedAt: transferTimestamp,
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
    if ((error as any)?.code === 'INSUFFICIENT_STOCK') {
      return res.status(400).json({ error: 'الكمية المتاحة غير كافية' });
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
router.get('/stock-movements', requireRole('INVENTORY', 'SALES_GROCERY', 'SALES_BAKERY', 'AGENT_GROCERY', 'AGENT_BAKERY', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, itemId, date, startDate, endDate, dateFrom, dateTo, section, reportType } = req.query;
    
    if (!inventoryId) {
      return res.status(400).json({ error: 'المخزن مطلوب' });
    }

    // Support reportType: 'daily' (default), 'weekly', 'custom'
    let targetStartDate: Date, targetEndDate: Date;
    
    if (reportType === 'weekly') {
      // Weekly: calculate Saturday–Friday week from given date
      const givenDate = new Date((date || dateFrom || new Date().toISOString().split('T')[0]) as string);
      const dayOfWeek = givenDate.getDay(); // 0=Sun … 6=Sat
      const diff = (dayOfWeek + 1) % 7; // Days since Saturday (Arabic week start)
      targetStartDate = new Date(givenDate);
      targetStartDate.setDate(givenDate.getDate() - diff);
      targetEndDate = new Date(targetStartDate);
      targetEndDate.setDate(targetStartDate.getDate() + 6); // Friday
    } else if (reportType === 'custom') {
      // Custom: use dateFrom/dateTo (or startDate/endDate for backward compat)
      targetStartDate = new Date((dateFrom || startDate) as string);
      targetEndDate = new Date((dateTo || endDate || dateFrom || startDate) as string);
    } else {
      // 'daily' (default) — preserve existing behavior
      if (date) {
        // Single date
        targetStartDate = new Date(date as string);
        targetEndDate = new Date(date as string);
      } else if (startDate || dateFrom) {
        // Date range
        const start = (startDate || dateFrom) as string;
        const end = (endDate || dateTo) as string;
        targetStartDate = new Date(start);
        targetEndDate = end ? new Date(end) : new Date(start);
      } else {
        // Default to today
        targetStartDate = new Date();
        targetEndDate = new Date();
      }
    }
    
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
        // Use StockMovement records from database (NEW SYSTEM)
        const itemMovements = [];
        
        // Get stock movements for this item in the date range
        const stockMovements = await prisma.stockMovement.findMany({
          where: {
            inventoryId: inventoryId as string,
            itemId: stock.itemId,
            movementDate: {
              gte: targetStartDate,
              lte: targetEndDate,
            },
          },
          orderBy: { movementDate: 'asc' },
        });

        for (const date of dates) {
            const dateStart = new Date(date);
            dateStart.setHours(0, 0, 0, 0);

            // Find the stock movement for this date (NEW SYSTEM)
            const movement = stockMovements.find(m => 
              m.movementDate.getTime() === dateStart.getTime()
            );

            if (movement) {
              // Use stored stock movement data
              itemMovements.push({
                date: date.toISOString().split('T')[0],
                openingBalance: movement.openingBalance.toString(),
                incoming: movement.incoming.toString(),
                outgoing: movement.outgoing.toString(),
                pendingOutgoing: movement.pendingOutgoing.toString(),
                incomingGifts: movement.incomingGifts.toString(),
                outgoingGifts: movement.outgoingGifts.toString(),
                closingBalance: movement.closingBalance.toString(),
              });
            } else {
              // No movement record for this date - show zeros with opening = previous closing
              // Get previous day's closing or current stock
              let openingBalance = new Prisma.Decimal(0);
              
              if (itemMovements.length > 0) {
                // Use previous day's closing
                openingBalance = new Prisma.Decimal(itemMovements[itemMovements.length - 1].closingBalance);
              } else {
                // First day - try to get last movement before start date
                const lastMovementBefore = await prisma.stockMovement.findFirst({
              where: {
                  inventoryId: inventoryId as string,
                itemId: stock.itemId,
                    movementDate: { lt: dateStart },
                },
                  orderBy: { movementDate: 'desc' },
                });
                
                if (lastMovementBefore) {
                  openingBalance = lastMovementBefore.closingBalance;
                } else {
                  // Use current stock as fallback
                  openingBalance = stock.quantity;
                }
              }

            itemMovements.push({
              date: date.toISOString().split('T')[0],
              openingBalance: openingBalance.toString(),
                incoming: '0',
                outgoing: '0',
                pendingOutgoing: '0',
                incomingGifts: '0',
                outgoingGifts: '0',
                closingBalance: openingBalance.toString(), // No changes
            });
            }
          }

        // Calculate current stock: use closing balance from most recent StockMovement
        // This ensures consistency with the movement records (accounts for all gifts, etc.)
        const mostRecentMovement = await prisma.stockMovement.findFirst({
          where: {
            inventoryId: inventoryId as string,
            itemId: stock.itemId,
          },
          orderBy: { movementDate: 'desc' },
        });

        let currentStock: number;
        if (mostRecentMovement) {
          // Use closing balance from most recent movement (source of truth)
          currentStock = parseFloat(mostRecentMovement.closingBalance.toString());
        } else {
          // No movements exist - fall back to batches/InventoryStock.quantity
          const batches = await prisma.stockBatch.findMany({
            where: {
              inventoryId: inventoryId as string,
              itemId: stock.itemId,
              quantity: {
                gt: 0
              }
            }
          });
          
          const currentStockFromBatches = batches.reduce((sum, b) => {
            return sum + parseFloat(b.quantity.toString());
          }, 0);
          
          // Match dashboard logic: use batches if they exist, otherwise use stock.quantity
          currentStock = batches.length > 0 
            ? currentStockFromBatches 
            : parseFloat(stock.quantity.toString());
        }

        return {
          itemId: stock.itemId,
          itemName: stock.item.name,
          section: stock.item.section,
          currentStock: currentStock.toString(), // Use closing balance from most recent movement
          movements: itemMovements,
        };
      })
    );

    // Calculate grandTotal across all items and dates
    const grandTotal = {
      totalOpeningBalance: 0,
      totalIncoming: 0,
      totalOutgoing: 0,
      totalPendingOutgoing: 0,
      totalIncomingGifts: 0,
      totalOutgoingGifts: 0,
      totalClosingBalance: 0,
    };

    for (const item of movementsReport) {
      for (const m of item.movements) {
        grandTotal.totalOpeningBalance += parseFloat(m.openingBalance);
        grandTotal.totalIncoming += parseFloat(m.incoming);
        grandTotal.totalOutgoing += parseFloat(m.outgoing);
        grandTotal.totalPendingOutgoing += parseFloat(m.pendingOutgoing);
        grandTotal.totalIncomingGifts += parseFloat(m.incomingGifts);
        grandTotal.totalOutgoingGifts += parseFloat(m.outgoingGifts);
        grandTotal.totalClosingBalance += parseFloat(m.closingBalance);
      }
    }

    res.json({
      inventoryId: inventoryId as string,
      reportType: (reportType as string) || 'daily',
      startDate: targetStartDate.toISOString().split('T')[0],
      endDate: targetEndDate.toISOString().split('T')[0],
      items: movementsReport,
      grandTotal,
    });
  } catch (error) {
    console.error('Stock movements report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// === Module 1: Warehouse Management Endpoints ===

// Create new inventory
const createInventorySchema = z.object({
  name: z.string().min(1, 'اسم المخزن مطلوب'),
  isMain: z.boolean().optional().default(false),
  warehouseType: z.enum(['MAIN', 'ROAD', 'SIDE']).optional().default('MAIN'),
});

router.post('/', requireRole('MANAGER'), createAuditLog('Inventory'), async (req: AuthRequest, res) => {
  try {
    const data = createInventorySchema.parse(req.body);

    const inventory = await prisma.inventory.create({
      data: {
        name: data.name,
        isMain: data.isMain,
        warehouseType: data.warehouseType,
      },
    });

    res.status(201).json(inventory);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create inventory error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Gift-specific movement report
router.get('/gift-report', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { inventoryId, dateFrom, dateTo } = req.query;

    if (!inventoryId) {
      return res.status(400).json({ error: 'المخزن مطلوب' });
    }

    const where: any = {
      inventoryId: inventoryId as string,
    };

    if (dateFrom || dateTo) {
      where.movementDate = {};
      if (dateFrom) {
        const from = new Date(dateFrom as string);
        from.setHours(0, 0, 0, 0);
        where.movementDate.gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo as string);
        to.setHours(23, 59, 59, 999);
        where.movementDate.lte = to;
      }
    }

    const movements = await prisma.stockMovement.findMany({
      where,
      include: {
        item: { select: { id: true, name: true } },
      },
      orderBy: { movementDate: 'asc' },
    });

    // Group by item
    const groupedByItem: Record<string, { itemId: string; itemName: string; totalIncomingGifts: number; totalOutgoingGifts: number }> = {};

    for (const m of movements) {
      if (!groupedByItem[m.itemId]) {
        groupedByItem[m.itemId] = {
          itemId: m.itemId,
          itemName: m.item.name,
          totalIncomingGifts: 0,
          totalOutgoingGifts: 0,
        };
      }
      groupedByItem[m.itemId].totalIncomingGifts += parseFloat(m.incomingGifts.toString());
      groupedByItem[m.itemId].totalOutgoingGifts += parseFloat(m.outgoingGifts.toString());
    }

    const items = Object.values(groupedByItem);

    const grandTotal = {
      totalIncomingGifts: items.reduce((sum, i) => sum + i.totalIncomingGifts, 0),
      totalOutgoingGifts: items.reduce((sum, i) => sum + i.totalOutgoingGifts, 0),
    };

    res.json({ items, grandTotal });
  } catch (error) {
    console.error('Gift report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Warehouse balance report
router.get('/:id/balance-report', requireRole('INVENTORY', 'MANAGER', 'ACCOUNTANT', 'AUDITOR'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;

    const targetDate = date ? new Date(date as string) : new Date();
    const dateStart = new Date(targetDate);
    dateStart.setHours(0, 0, 0, 0);
    const dateEnd = new Date(targetDate);
    dateEnd.setHours(23, 59, 59, 999);

    // Get movements for this inventory on the specified date
    const movements = await prisma.stockMovement.findMany({
      where: {
        inventoryId: id,
        movementDate: {
          gte: dateStart,
          lte: dateEnd,
        },
      },
      include: {
        item: { select: { id: true, name: true, section: true } },
      },
      orderBy: { item: { name: 'asc' } },
    });

    const items = movements.map((m) => ({
      itemId: m.itemId,
      itemName: m.item.name,
      section: m.item.section,
      openingBalance: m.openingBalance.toString(),
      incoming: m.incoming.toString(),
      incomingGifts: m.incomingGifts.toString(),
      outgoing: m.outgoing.toString(),
      pendingOutgoing: m.pendingOutgoing.toString(),
      outgoingGifts: m.outgoingGifts.toString(),
      closingBalance: m.closingBalance.toString(),
    }));

    const grandTotal = {
      totalOpeningBalance: movements.reduce((sum, m) => sum + parseFloat(m.openingBalance.toString()), 0),
      totalIncoming: movements.reduce((sum, m) => sum + parseFloat(m.incoming.toString()), 0),
      totalIncomingGifts: movements.reduce((sum, m) => sum + parseFloat(m.incomingGifts.toString()), 0),
      totalOutgoing: movements.reduce((sum, m) => sum + parseFloat(m.outgoing.toString()), 0),
      totalPendingOutgoing: movements.reduce((sum, m) => sum + parseFloat(m.pendingOutgoing.toString()), 0),
      totalOutgoingGifts: movements.reduce((sum, m) => sum + parseFloat(m.outgoingGifts.toString()), 0),
      totalClosingBalance: movements.reduce((sum, m) => sum + parseFloat(m.closingBalance.toString()), 0),
    };

    res.json({
      inventoryId: id,
      date: targetDate.toISOString().split('T')[0],
      items,
      grandTotal,
    });
  } catch (error) {
    console.error('Balance report error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

