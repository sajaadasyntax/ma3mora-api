import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

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
      // Update existing movement
      const newIncoming = new Prisma.Decimal(existing.incoming.toString())
        .add(changes.incoming || 0);
      const newOutgoing = new Prisma.Decimal(existing.outgoing.toString())
        .add(changes.outgoing || 0);
      const newPendingOutgoing = new Prisma.Decimal(existing.pendingOutgoing.toString())
        .add(changes.pendingOutgoing || 0);
      const newIncomingGifts = new Prisma.Decimal(existing.incomingGifts.toString())
        .add(changes.incomingGifts || 0);
      const newOutgoingGifts = new Prisma.Decimal(existing.outgoingGifts.toString())
        .add(changes.outgoingGifts || 0);

      // Calculate new closing balance
      const closingBalance = new Prisma.Decimal(existing.openingBalance.toString())
        .add(newIncoming)
        .add(newIncomingGifts)
        .sub(newOutgoing)
        .sub(newPendingOutgoing)
        .sub(newOutgoingGifts);

      await prisma.stockMovement.update({
        where: {
          inventoryId_itemId_movementDate: {
            inventoryId,
            itemId,
            movementDate,
          },
        },
        data: {
          incoming: newIncoming,
          outgoing: newOutgoing,
          pendingOutgoing: newPendingOutgoing,
          incomingGifts: newIncomingGifts,
          outgoingGifts: newOutgoingGifts,
          closingBalance,
        },
      });

      // Update all future dates' opening balances
      await this.propagateClosingBalanceToFutureDays(inventoryId, itemId, movementDate, closingBalance);
    } else {
      // Create new movement - get opening balance from previous day
      const openingBalance = await this.getOpeningBalanceForDate(inventoryId, itemId, movementDate);

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

      // Update all future dates' opening balances
      await this.propagateClosingBalanceToFutureDays(inventoryId, itemId, movementDate, closingBalance);
    }
  }

  /**
   * Get opening balance for a specific date
   * Opening balance = Previous day's closing balance
   * If no previous day exists, get from current InventoryStock
   */
  private async getOpeningBalanceForDate(
    inventoryId: string,
    itemId: string,
    date: Date
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

    // No previous movement - get from current stock (fallback)
    // This should ideally be the initial stock when the system started
    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId,
          itemId,
        },
      },
    });

    return stock?.quantity || new Prisma.Decimal(0);
  }

  /**
   * Propagate closing balance changes to all future days
   * When a day's closing balance changes, all future days' opening balances must update
   */
  private async propagateClosingBalanceToFutureDays(
    inventoryId: string,
    itemId: string,
    fromDate: Date,
    newClosingBalance: Prisma.Decimal
  ): Promise<void> {
    // Get all future movements
    const nextDay = new Date(fromDate);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);

    const futureMovements = await prisma.stockMovement.findMany({
      where: {
        inventoryId,
        itemId,
        movementDate: {
          gte: nextDay,
        },
      },
      orderBy: {
        movementDate: 'asc',
      },
    });

    // Update each future day sequentially
    let currentClosing = newClosingBalance;
    for (const movement of futureMovements) {
      const newOpeningBalance = currentClosing;
      const newClosingBalance = newOpeningBalance
        .add(movement.incoming)
        .add(movement.incomingGifts)
        .sub(movement.outgoing)
        .sub(movement.pendingOutgoing)
        .sub(movement.outgoingGifts);

      await prisma.stockMovement.update({
        where: {
          id: movement.id,
        },
        data: {
          openingBalance: newOpeningBalance,
          closingBalance: newClosingBalance,
        },
      });

      currentClosing = newClosingBalance;
    }
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

