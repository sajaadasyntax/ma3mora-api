import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';
import { stockMovementService } from '../services/stockMovementService';
import { aggregationService } from '../services/aggregationService';
import { journalService } from '../services/journalService';
import { prisma } from '../lib/prisma';

const router = Router();

router.use(requireAuth);
router.use(blockAuditorWrites);

async function checkBalanceOpen(req: AuthRequest, res: any, next: any) {
  try {
    const openBalance = await prisma.openingBalance.findFirst({
      where: { isClosed: false },
    });

    if (!openBalance) {
      return res.status(400).json({ 
        error: 'الحساب مغلق. يرجى فتح حساب جديد قبل إجراء أي معاملات.' 
      });
    }

    next();
  } catch (error) {
    console.error('Check balance error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const returnItemSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number().positive(),
});

const createReturnSchema = z.object({
  reason: z.string().min(1, 'سبب المرتجع مطلوب'),
  notes: z.string().optional(),
  items: z.array(returnItemSchema).min(1, 'يجب إضافة صنف واحد على الأقل'),
});

const editInvoiceSchema = z.object({
  items: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.number().positive(),
    unitPrice: z.number().positive(),
  })).optional(),
  discount: z.number().min(0).optional(),
  notes: z.string().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function calculatePaymentStatus(paidAmount: Prisma.Decimal, total: Prisma.Decimal): 'PAID' | 'PARTIAL' | 'CREDIT' {
  if (paidAmount.lessThanOrEqualTo(0)) {
    return 'CREDIT';
  } else if (paidAmount.greaterThanOrEqualTo(total)) {
    return 'PAID';
  } else {
    return 'PARTIAL';
  }
}

// ─── POST /sales/invoices/:id/return — Sales Return ─────────────────────────

router.post(
  '/sales/invoices/:id/return',
  requireRole('ACCOUNTANT', 'MANAGER'),
  checkBalanceOpen,
  createAuditLog('SalesReturn'),
  async (req: AuthRequest, res) => {
    try {
      const { id: invoiceId } = req.params;
      const data = createReturnSchema.parse(req.body);

      // Fetch the invoice with its items and inventory
      const invoice = await prisma.salesInvoice.findUnique({
        where: { id: invoiceId },
        include: {
          items: true,
          inventory: true,
        },
      });

      if (!invoice) {
        return res.status(404).json({ error: 'الفاتورة غير موجودة' });
      }

      if (invoice.paymentConfirmationStatus === 'REJECTED') {
        return res.status(400).json({ error: 'لا يمكن عمل مرتجع لفاتورة ملغية' });
      }

      // Query previously returned quantities for this invoice
      const previousReturns = await prisma.salesReturnItem.groupBy({
        by: ['itemId'],
        where: { salesReturn: { invoiceId } },
        _sum: { quantity: true },
      });
      const returnedByItem: Record<string, Prisma.Decimal> = {};
      for (const pr of previousReturns) {
        returnedByItem[pr.itemId] = pr._sum.quantity || new Prisma.Decimal(0);
      }

      // Validate that return items exist in the invoice
      for (const returnItem of data.items) {
        const invoiceItem = invoice.items.find(i => i.itemId === returnItem.itemId);
        if (!invoiceItem) {
          return res.status(400).json({
            error: `الصنف ${returnItem.itemId} غير موجود في الفاتورة`,
          });
        }
        const alreadyReturned = returnedByItem[returnItem.itemId] || new Prisma.Decimal(0);
        const maxReturnable = invoiceItem.quantity.sub(alreadyReturned);
        if (new Prisma.Decimal(returnItem.quantity).greaterThan(maxReturnable)) {
          return res.status(400).json({
            error: `كمية المرتجع للصنف ${returnItem.itemId} أكبر من الكمية المتبقية (${maxReturnable})`,
          });
        }
      }

      // Calculate total return amount
      const returnTotal = data.items.reduce((sum, item) => {
        return sum.add(new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice)));
      }, new Prisma.Decimal(0));

      // Create the sales return with items in a transaction
      const salesReturn = await prisma.$transaction(async (tx) => {
        // 1. Create SalesReturn record
        const salesReturn = await tx.salesReturn.create({
          data: {
            invoiceId,
            reason: data.reason,
            returnedBy: req.user!.id,
            notes: data.notes,
            items: {
              create: data.items.map(item => ({
                itemId: item.itemId,
                quantity: new Prisma.Decimal(item.quantity),
                unitPrice: new Prisma.Decimal(item.unitPrice),
                lineTotal: new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice)),
              })),
            },
          },
          include: {
            items: {
              include: {
                item: true,
              },
            },
            invoice: {
              include: {
                customer: true,
              },
            },
            returnedByUser: {
              select: {
                id: true,
                username: true,
                role: true,
              },
            },
          },
        });

        // 2. For each returned item: restore stock and record movement
        for (const returnItem of data.items) {
          // Add quantity back to InventoryStock
          const stockRecord = await tx.inventoryStock.update({
            where: {
              inventoryId_itemId: {
                inventoryId: invoice.inventoryId,
                itemId: returnItem.itemId,
              },
            },
            data: {
              quantity: {
                increment: new Prisma.Decimal(returnItem.quantity),
              },
            },
          });

          await tx.stockBatch.create({
            data: {
              inventoryId: invoice.inventoryId,
              itemId: returnItem.itemId,
              quantity: new Prisma.Decimal(returnItem.quantity),
              receivedAt: new Date(),
              notes: `مرتجع مبيعات - فاتورة ${invoice.invoiceNumber}`,
            },
          });

          // Record stock movement (incoming for returned items)
          await stockMovementService.updateStockMovement(
            invoice.inventoryId,
            returnItem.itemId,
            new Date(),
            { incoming: returnItem.quantity }
          );
        }

        // 3. Adjust invoice: reduce paidAmount and update paymentStatus
        const newPaidAmount = Prisma.Decimal.max(
          invoice.paidAmount.sub(returnTotal),
          new Prisma.Decimal(0)
        );
        const newPaymentStatus = calculatePaymentStatus(newPaidAmount, invoice.total);

        await tx.salesInvoice.update({
          where: { id: invoiceId },
          data: {
            paidAmount: newPaidAmount,
            paymentStatus: newPaymentStatus,
          },
        });

        // 4. Adjust CustomerCumulativeAggregate if customer exists
        if (invoice.customerId) {
          // Reduce totalSales and totalPaid by the return amount
          const latestAggregate = await tx.customerCumulativeAggregate.findFirst({
            where: { customerId: invoice.customerId },
            orderBy: { date: 'desc' },
          });

          if (latestAggregate) {
            const dateOnly = new Date();
            dateOnly.setHours(0, 0, 0, 0);

            await tx.customerCumulativeAggregate.upsert({
              where: {
                customerId_date: {
                  customerId: invoice.customerId,
                  date: dateOnly,
                },
              },
              update: {
                totalSales: latestAggregate.totalSales.sub(returnTotal),
                totalPaid: latestAggregate.totalPaid.sub(returnTotal),
                totalOutstanding: latestAggregate.totalOutstanding,
              },
              create: {
                customerId: invoice.customerId,
                date: dateOnly,
                totalInvoices: latestAggregate.totalInvoices,
                totalSales: latestAggregate.totalSales.sub(returnTotal),
                totalPaid: latestAggregate.totalPaid.sub(returnTotal),
                totalOutstanding: latestAggregate.totalOutstanding,
                salesCash: latestAggregate.salesCash,
                salesBank: latestAggregate.salesBank,
                salesBankNile: latestAggregate.salesBankNile,
              },
            });
          }
        }

        // 5. Create journal entry for the return
        await journalService.createJournalEntry({
          date: new Date(),
          entryType: 'RETURN',
          referenceId: salesReturn.id,
          referenceType: 'SalesReturn',
          direction: 'DEBIT',
          amount: returnTotal,
          method: invoice.paymentMethod,
          description: `مرتجع مبيعات - فاتورة ${invoice.invoiceNumber} - ${data.reason}`,
          createdBy: req.user!.id,
        });

        // 6. Create audit log entry
        await tx.auditLog.create({
          data: {
            userId: req.user!.id,
            action: 'SALES_RETURN',
            entity: 'SalesReturn',
            entityId: salesReturn.id,
            before: JSON.stringify({ invoiceId, paidAmount: invoice.paidAmount }),
            after: JSON.stringify({ returnTotal: returnTotal.toString(), newPaidAmount: newPaidAmount.toString() }),
          },
        });

        return salesReturn;
      });

      try {
        await aggregationService.updateDailyFinancialAggregate(new Date(), {
          salesReturnsTotal: returnTotal,
          salesReturnsCount: 1,
        });
      } catch (aggError) {
        console.error('Aggregation update error (sales return):', aggError);
      }

      res.status(201).json(salesReturn);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Sales return error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء معالجة المرتجع' });
    }
  }
);

// ─── GET /sales/returns — List sales returns ────────────────────────────────

router.get(
  '/sales/returns',
  async (req: AuthRequest, res) => {
    try {
      const { dateFrom, dateTo, invoiceId } = req.query;

      const where: any = {};

      if (dateFrom || dateTo) {
        where.returnedAt = {};
        if (dateFrom) {
          where.returnedAt.gte = new Date(dateFrom as string);
        }
        if (dateTo) {
          const endDate = new Date(dateTo as string);
          endDate.setHours(23, 59, 59, 999);
          where.returnedAt.lte = endDate;
        }
      }

      if (invoiceId) {
        where.invoiceId = invoiceId as string;
      }

      const returns = await prisma.salesReturn.findMany({
        where,
        include: {
          invoice: {
            include: {
              customer: true,
            },
          },
          items: {
            include: {
              item: true,
            },
          },
          returnedByUser: {
            select: {
              id: true,
              username: true,
              role: true,
            },
          },
        },
        orderBy: {
          returnedAt: 'desc',
        },
      });

      res.json(returns);
    } catch (error) {
      console.error('List returns error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء جلب المرتجعات' });
    }
  }
);

// ─── PUT /sales/invoices/:id — Invoice Editing (post-confirmation) ──────────

router.put(
  '/sales/invoices/:id',
  requireRole('MANAGER'),
  checkBalanceOpen,
  createAuditLog('SalesInvoice'),
  async (req: AuthRequest, res) => {
    try {
      const { id: invoiceId } = req.params;
      const data = editInvoiceSchema.parse(req.body);

      // Fetch current invoice
      const invoice = await prisma.salesInvoice.findUnique({
        where: { id: invoiceId },
        include: {
          items: true,
        },
      });

      if (!invoice) {
        return res.status(404).json({ error: 'الفاتورة غير موجودة' });
      }

      // Cannot edit after delivery
      if (invoice.deliveryStatus === 'DELIVERED') {
        return res.status(400).json({
          error: 'لا يمكن تعديل الفاتورة بعد التسليم',
        });
      }

      // Store before state for audit
      const beforeState = {
        items: invoice.items,
        discount: invoice.discount,
        subtotal: invoice.subtotal,
        total: invoice.total,
        notes: invoice.notes,
      };

      const updatedInvoice = await prisma.$transaction(async (tx) => {
        let newSubtotal = invoice.subtotal;
        let newDiscount = data.discount !== undefined
          ? new Prisma.Decimal(data.discount)
          : invoice.discount;

        // Update items if provided
        if (data.items && data.items.length > 0) {
          // Delete existing items
          await tx.salesInvoiceItem.deleteMany({
            where: { invoiceId },
          });

          // Recalculate subtotal from new items
          newSubtotal = new Prisma.Decimal(0);

          for (const item of data.items) {
            const lineTotal = new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice));
            newSubtotal = newSubtotal.add(lineTotal);

            await tx.salesInvoiceItem.create({
              data: {
                invoiceId,
                itemId: item.itemId,
                quantity: new Prisma.Decimal(item.quantity),
                unitPrice: new Prisma.Decimal(item.unitPrice),
                lineTotal,
              },
            });
          }
        }

        // Calculate new total
        const newTotal = newSubtotal.sub(newDiscount);
        const newPaymentStatus = calculatePaymentStatus(invoice.paidAmount, newTotal);

        // Update the invoice
        const updated = await tx.salesInvoice.update({
          where: { id: invoiceId },
          data: {
            subtotal: newSubtotal,
            discount: newDiscount,
            total: newTotal,
            paymentStatus: newPaymentStatus,
            ...(data.notes !== undefined ? { notes: data.notes } : {}),
          },
          include: {
            items: {
              include: {
                item: true,
              },
            },
            customer: true,
            payments: true,
            salesUser: {
              select: {
                id: true,
                username: true,
                role: true,
              },
            },
          },
        });

        // Log before/after in AuditLog
        await tx.auditLog.create({
          data: {
            userId: req.user!.id,
            action: 'INVOICE_EDIT',
            entity: 'SalesInvoice',
            entityId: invoiceId,
            before: JSON.stringify(beforeState),
            after: JSON.stringify({
              items: (updated as any).items,
              discount: updated.discount,
              subtotal: updated.subtotal,
              total: updated.total,
              notes: updated.notes,
            }),
          },
        });

        return updated;
      });

      // Update aggregates to reflect total change
      try {
        const oldTotal = parseFloat(invoice.total.toString());
        const newTotal = parseFloat(updatedInvoice.total.toString());
        const diff = newTotal - oldTotal;
        if (diff !== 0) {
          await aggregationService.updateDailyFinancialAggregate(invoice.createdAt, {
            salesTotal: new Prisma.Decimal(diff),
          });
          if (invoice.customerId) {
            await aggregationService.updateCustomerCumulativeAggregate(
              invoice.customerId,
              invoice.createdAt,
              { totalSales: new Prisma.Decimal(diff) }
            );
          }
        }
      } catch (aggError) {
        console.error('Aggregation update error (invoice edit):', aggError);
      }

      res.json(updatedInvoice);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
      }
      console.error('Invoice edit error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء تعديل الفاتورة' });
    }
  }
);

// ─── GET /journal/daily — Daily journal entries ─────────────────────────────

router.get(
  '/journal/daily',
  async (req: AuthRequest, res) => {
    try {
      const { date } = req.query;

      if (!date) {
        return res.status(400).json({ error: 'التاريخ مطلوب' });
      }

      const targetDate = new Date(date as string);
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ error: 'صيغة التاريخ غير صالحة' });
      }

      const entries = await journalService.getDailyJournal(targetDate);

      // Group entries by entryType
      const grouped: Record<string, typeof entries> = {};
      let totalDebits = new Prisma.Decimal(0);
      let totalCredits = new Prisma.Decimal(0);

      for (const entry of entries) {
        if (!grouped[entry.entryType]) {
          grouped[entry.entryType] = [];
        }
        grouped[entry.entryType].push(entry);

        if (entry.direction === 'DEBIT') {
          totalDebits = totalDebits.add(entry.amount);
        } else {
          totalCredits = totalCredits.add(entry.amount);
        }
      }

      res.json({
        date: date,
        entries: grouped,
        grandTotal: {
          totalDebits,
          totalCredits,
          net: totalDebits.sub(totalCredits),
        },
        totalEntries: entries.length,
      });
    } catch (error) {
      console.error('Daily journal error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء جلب دفتر اليومية' });
    }
  }
);

// ─── POST /sales/invoices/:id/void — Void an invoice ────────────────────────

router.post(
  '/sales/invoices/:id/void',
  requireRole('MANAGER'),
  checkBalanceOpen,
  createAuditLog('SalesInvoice'),
  async (req: AuthRequest, res) => {
    try {
      const { id: invoiceId } = req.params;

      const invoice = await prisma.salesInvoice.findUnique({
        where: { id: invoiceId },
        include: {
          items: { include: { item: true } },
          customer: true,
        },
      });

      if (!invoice) {
        return res.status(404).json({ error: 'الفاتورة غير موجودة' });
      }

      if (invoice.paymentConfirmationStatus === 'REJECTED') {
        return res.status(400).json({ error: 'الفاتورة ملغية بالفعل' });
      }

      const voidedInvoice = await prisma.$transaction(async (tx) => {
        // a) Mark invoice as voided
        const updated = await tx.salesInvoice.update({
          where: { id: invoiceId },
          data: {
            paymentConfirmationStatus: 'REJECTED',
            notes: invoice.notes
              ? `${invoice.notes} | ملغية`
              : 'ملغية',
          },
          include: {
            items: { include: { item: true } },
            customer: true,
            payments: true,
            salesUser: {
              select: { id: true, username: true, role: true },
            },
          },
        });

        // b) Restore stock for each delivered item, minus already-returned quantities
        if (invoice.deliveryStatus === 'DELIVERED') {
          const existingReturnItems = await tx.salesReturnItem.groupBy({
            by: ['itemId'],
            where: { salesReturn: { invoiceId } },
            _sum: { quantity: true },
          });
          const returnedMap: Record<string, number> = {};
          for (const ri of existingReturnItems) {
            returnedMap[ri.itemId] = parseFloat((ri._sum.quantity || new Prisma.Decimal(0)).toString());
          }

          for (const invItem of invoice.items) {
            const alreadyReturned = returnedMap[invItem.itemId] || 0;
            const restoreQty = parseFloat(invItem.quantity.toString()) - alreadyReturned;

            if (restoreQty > 0) {
              const stockRecord = await tx.inventoryStock.update({
                where: {
                  inventoryId_itemId: {
                    inventoryId: invoice.inventoryId,
                    itemId: invItem.itemId,
                  },
                },
                data: {
                  quantity: { increment: new Prisma.Decimal(restoreQty) },
                },
              });

              await tx.stockBatch.create({
                data: {
                  inventoryId: invoice.inventoryId,
                  itemId: invItem.itemId,
                  quantity: new Prisma.Decimal(restoreQty),
                  receivedAt: new Date(),
                  notes: `إلغاء فاتورة ${invoice.invoiceNumber}`,
                },
              });

              await stockMovementService.updateStockMovement(
                invoice.inventoryId,
                invItem.itemId,
                new Date(),
                { incoming: restoreQty }
              );
            }
          }
        }

        // d) Update customer aggregate if customer exists
        if (invoice.customerId) {
          const latestAggregate = await tx.customerCumulativeAggregate.findFirst({
            where: { customerId: invoice.customerId },
            orderBy: { date: 'desc' },
          });

          if (latestAggregate) {
            const dateOnly = new Date();
            dateOnly.setHours(0, 0, 0, 0);

            await tx.customerCumulativeAggregate.upsert({
              where: {
                customerId_date: {
                  customerId: invoice.customerId,
                  date: dateOnly,
                },
              },
              update: {
                totalSales: latestAggregate.totalSales.sub(invoice.total),
                totalPaid: latestAggregate.totalPaid.sub(invoice.paidAmount),
                totalOutstanding: latestAggregate.totalOutstanding.sub(
                  invoice.total.sub(invoice.paidAmount)
                ),
              },
              create: {
                customerId: invoice.customerId,
                date: dateOnly,
                totalInvoices: Math.max(latestAggregate.totalInvoices - 1, 0),
                totalSales: latestAggregate.totalSales.sub(invoice.total),
                totalPaid: latestAggregate.totalPaid.sub(invoice.paidAmount),
                totalOutstanding: latestAggregate.totalOutstanding.sub(
                  invoice.total.sub(invoice.paidAmount)
                ),
                salesCash: latestAggregate.salesCash,
                salesBank: latestAggregate.salesBank,
                salesBankNile: latestAggregate.salesBankNile,
              },
            });
          }
        }

        // e) Audit log
        await tx.auditLog.create({
          data: {
            userId: req.user!.id,
            action: 'INVOICE_VOID',
            entity: 'SalesInvoice',
            entityId: invoiceId,
            before: JSON.stringify({
              paymentConfirmationStatus: invoice.paymentConfirmationStatus,
              total: invoice.total.toString(),
              paidAmount: invoice.paidAmount.toString(),
            }),
            after: JSON.stringify({
              paymentConfirmationStatus: 'REJECTED',
              notes: 'ملغية',
            }),
          },
        });

        // f) Journal entry
        await journalService.createJournalEntry({
          date: new Date(),
          entryType: 'VOID',
          referenceId: invoiceId,
          referenceType: 'SalesInvoice',
          direction: 'CREDIT',
          amount: invoice.total,
          method: invoice.paymentMethod,
          description: `إلغاء فاتورة ${invoice.invoiceNumber}`,
          createdBy: req.user!.id,
        });

        return updated;
      });

      try {
        const invoiceTotal = parseFloat(invoice.total.toString());
        const invoicePaid = parseFloat(invoice.paidAmount.toString());

        await aggregationService.updateDailyFinancialAggregate(invoice.createdAt, {
          salesTotal: new Prisma.Decimal(-invoiceTotal),
          salesReceived: new Prisma.Decimal(-invoicePaid),
          salesDebt: new Prisma.Decimal(-(invoiceTotal - invoicePaid)),
          salesCount: -1,
        });
      } catch (aggError) {
        console.error('Aggregation reversal error (void):', aggError);
      }

      res.json(voidedInvoice);
    } catch (error) {
      console.error('Invoice void error:', error);
      res.status(500).json({ error: 'خطأ في الخادم أثناء إلغاء الفاتورة' });
    }
  }
);

export default router;
