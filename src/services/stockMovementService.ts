import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export class StockMovementService {
  /**
   * Update or create stock movement for a specific date
   * This ensures that opening balance = previous day's closing balance
   */
  async updateStockMovement(
    inventoryId: string,
    itemId: string,
    date: Date,
    changes: {
      incoming?: number;
      outgoing?: number;
      pendingOutgoing?: number;
      incomingGifts?: number;
      outgoingGifts?: number;
    }
  ): Promise<void> {
    // Normalize date to start of day
    const movementDate = new Date(date);
    movementDate.setHours(0, 0, 0, 0);

    // Get or create stock movement for this date
    const existing = await prisma.stockMovement.findUnique({
      where: {
        inventoryId_itemId_movementDate: {
          inventoryId,
          itemId,
          movementDate,
        },
      },
    });

    if (existing) {
      const incoming = changes.incoming || 0;
      const outgoing = changes.outgoing || 0;
      const pendingOutgoing = changes.pendingOutgoing || 0;
      const incomingGifts = changes.incomingGifts || 0;
      const outgoingGifts = changes.outgoingGifts || 0;
      const balanceDelta = incoming + incomingGifts - outgoing - pendingOutgoing - outgoingGifts;

      await prisma.stockMovement.update({
        where: { id: existing.id },
        data: {
          incoming: { increment: incoming },
          outgoing: { increment: outgoing },
          pendingOutgoing: { increment: pendingOutgoing },
          incomingGifts: { increment: incomingGifts },
          outgoingGifts: { increment: outgoingGifts },
          closingBalance: { increment: balanceDelta },
        },
      });

      await this.propagateClosingBalanceToFutureDays(inventoryId, itemId, movementDate, balanceDelta);
    } else {
      // Create new movement - get opening balance from previous day
      // If we're adding incoming stock, pass it to subtract from current stock
      const openingBalance = await this.getOpeningBalanceForDate(
        inventoryId, 
        itemId, 
        movementDate,
        changes.incoming,
        changes.incomingGifts
      );

      const incoming = new Prisma.Decimal(changes.incoming || 0);
      const outgoing = new Prisma.Decimal(changes.outgoing || 0);
      const pendingOutgoing = new Prisma.Decimal(changes.pendingOutgoing || 0);
      const incomingGifts = new Prisma.Decimal(changes.incomingGifts || 0);
      const outgoingGifts = new Prisma.Decimal(changes.outgoingGifts || 0);

      const closingBalance = openingBalance
        .add(incoming)
        .add(incomingGifts)
        .sub(outgoing)
        .sub(pendingOutgoing)
        .sub(outgoingGifts);

      await prisma.stockMovement.create({
        data: {
          inventoryId,
          itemId,
          movementDate,
          openingBalance,
          incoming,
          outgoing,
          pendingOutgoing,
          incomingGifts,
          outgoingGifts,
          closingBalance,
        },
      });

      const balanceDelta = (changes.incoming || 0) + (changes.incomingGifts || 0)
        - (changes.outgoing || 0) - (changes.pendingOutgoing || 0) - (changes.outgoingGifts || 0);
      await this.propagateClosingBalanceToFutureDays(inventoryId, itemId, movementDate, balanceDelta);
    }
  }

  /**
   * Get opening balance for a specific date
   * Opening balance = Previous day's closing balance
   * If no previous day exists, get from current InventoryStock
   * If there are movements on the same date, subtract them to get the true opening balance
   */
  private async getOpeningBalanceForDate(
    inventoryId: string,
    itemId: string,
    date: Date,
    incomingToSubtract?: number,
    incomingGiftsToSubtract?: number
  ): Promise<Prisma.Decimal> {
    // Get the previous day's movement
    const previousDay = new Date(date);
    previousDay.setDate(previousDay.getDate() - 1);
    previousDay.setHours(0, 0, 0, 0);

    const previousMovement = await prisma.stockMovement.findFirst({
      where: {
        inventoryId,
        itemId,
        movementDate: {
          lte: previousDay,
        },
      },
      orderBy: {
        movementDate: 'desc',
      },
    });

    if (previousMovement) {
      // Use previous day's closing balance
      return previousMovement.closingBalance;
    }

    // No previous movement - need to calculate from current stock
    // If we're adding incoming stock, we need to subtract it to get the opening balance
    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId,
          itemId,
        },
      },
    });

    if (!stock) {
      return new Prisma.Decimal(0);
    }

    // Check if there's already a movement for this date (might be created by another transaction)
    const movementDate = new Date(date);
    movementDate.setHours(0, 0, 0, 0);
    
    const sameDayMovement = await prisma.stockMovement.findUnique({
      where: {
        inventoryId_itemId_movementDate: {
          inventoryId,
          itemId,
          movementDate,
        },
      },
    });

    if (sameDayMovement) {
      // If movement already exists, use its opening balance
      return sameDayMovement.openingBalance;
    }

    // No previous movement and no same-day movement
    // If we're adding incoming stock, subtract it from current stock to get opening balance
    let openingBalance = stock.quantity;
    
    if (incomingToSubtract !== undefined && incomingToSubtract > 0) {
      openingBalance = openingBalance.sub(incomingToSubtract);
    }
    
    if (incomingGiftsToSubtract !== undefined && incomingGiftsToSubtract > 0) {
      openingBalance = openingBalance.sub(incomingGiftsToSubtract);
    }

    return openingBalance;
  }

  /**
   * Propagate closing balance changes to all future days
   * When a day's closing balance changes, all future days' opening balances must update
   */
  private async propagateClosingBalanceToFutureDays(
    inventoryId: string,
    itemId: string,
    fromDate: Date,
    balanceDelta: number
  ): Promise<void> {
    if (balanceDelta === 0) return;

    const nextDay = new Date(fromDate);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);

    await prisma.stockMovement.updateMany({
      where: {
        inventoryId,
        itemId,
        movementDate: { gte: nextDay },
      },
      data: {
        openingBalance: { increment: balanceDelta },
        closingBalance: { increment: balanceDelta },
      },
    });
  }

  /**
   * Initialize stock movement from current inventory stock
   * This should be run once to set up the initial opening balance
   */
  async initializeStockMovement(
    inventoryId: string,
    itemId: string,
    initialQuantity: number,
    date: Date = new Date()
  ): Promise<void> {
    const movementDate = new Date(date);
    movementDate.setHours(0, 0, 0, 0);

    const existing = await prisma.stockMovement.findUnique({
      where: {
        inventoryId_itemId_movementDate: {
          inventoryId,
          itemId,
          movementDate,
        },
      },
    });

    if (!existing) {
      await prisma.stockMovement.create({
        data: {
          inventoryId,
          itemId,
          movementDate,
          openingBalance: new Prisma.Decimal(initialQuantity),
          incoming: new Prisma.Decimal(0),
          outgoing: new Prisma.Decimal(0),
          pendingOutgoing: new Prisma.Decimal(0),
          incomingGifts: new Prisma.Decimal(0),
          outgoingGifts: new Prisma.Decimal(0),
          closingBalance: new Prisma.Decimal(initialQuantity),
        },
      });
    }
  }

  /**
   * Get stock movement for a specific date range
   */
  async getStockMovements(
    inventoryId: string,
    itemId: string,
    startDate: Date,
    endDate: Date
  ) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    return await prisma.stockMovement.findMany({
      where: {
        inventoryId,
        itemId,
        movementDate: {
          gte: start,
          lte: end,
        },
      },
      orderBy: {
        movementDate: 'asc',
      },
    });
  }
}

export const stockMovementService = new StockMovementService();

