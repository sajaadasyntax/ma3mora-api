import { PrismaClient, Prisma, Section, PaymentMethod } from '@prisma/client';

const prisma = new PrismaClient();

export interface DailyAggregateUpdate {
  salesTotal?: Prisma.Decimal;
  salesReceived?: Prisma.Decimal;
  salesDebt?: Prisma.Decimal;
  salesCount?: number;
  salesCash?: Prisma.Decimal;
  salesBank?: Prisma.Decimal;
  salesBankNile?: Prisma.Decimal;
  procurementTotal?: Prisma.Decimal;
  procurementPaid?: Prisma.Decimal;
  procurementDebt?: Prisma.Decimal;
  procurementCount?: number;
  procurementCancelled?: Prisma.Decimal;
  procurementCash?: Prisma.Decimal;
  procurementBank?: Prisma.Decimal;
  procurementBankNile?: Prisma.Decimal;
  expensesTotal?: Prisma.Decimal;
  expensesCount?: number;
  expensesCash?: Prisma.Decimal;
  expensesBank?: Prisma.Decimal;
  expensesBankNile?: Prisma.Decimal;
  salariesTotal?: Prisma.Decimal;
  salariesCount?: number;
  salariesCash?: Prisma.Decimal;
  salariesBank?: Prisma.Decimal;
  salariesBankNile?: Prisma.Decimal;
  advancesTotal?: Prisma.Decimal;
  advancesCount?: number;
  advancesCash?: Prisma.Decimal;
  advancesBank?: Prisma.Decimal;
  advancesBankNile?: Prisma.Decimal;
  cashExchangesCash?: Prisma.Decimal;
  cashExchangesBank?: Prisma.Decimal;
  cashExchangesBankNile?: Prisma.Decimal;
}

export class AggregationService {
  /**
   * Update or create daily financial aggregate
   */
  async updateDailyFinancialAggregate(
    date: Date,
    updates: DailyAggregateUpdate,
    inventoryId?: string,
    section?: Section
  ): Promise<void> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    // Get existing aggregate or create default
    const existing = await prisma.dailyFinancialAggregate.findUnique({
      where: {
        date_inventoryId_section: {
          date: dateOnly,
          inventoryId: (inventoryId ?? null) as string | null,
          section: (section ?? null) as Section | null,
        },
      },
    });

    // Build update data with increment operations
    const updateData: any = {};
    
    // Sales fields
    if (updates.salesTotal !== undefined) {
      updateData.salesTotal = existing 
        ? existing.salesTotal.add(updates.salesTotal)
        : updates.salesTotal;
    }
    if (updates.salesReceived !== undefined) {
      updateData.salesReceived = existing
        ? existing.salesReceived.add(updates.salesReceived)
        : updates.salesReceived;
    }
    if (updates.salesDebt !== undefined) {
      updateData.salesDebt = existing
        ? existing.salesDebt.add(updates.salesDebt)
        : updates.salesDebt;
    }
    if (updates.salesCount !== undefined) {
      updateData.salesCount = (existing?.salesCount || 0) + updates.salesCount;
    }
    if (updates.salesCash !== undefined) {
      updateData.salesCash = existing
        ? existing.salesCash.add(updates.salesCash)
        : updates.salesCash;
    }
    if (updates.salesBank !== undefined) {
      updateData.salesBank = existing
        ? existing.salesBank.add(updates.salesBank)
        : updates.salesBank;
    }
    if (updates.salesBankNile !== undefined) {
      updateData.salesBankNile = existing
        ? existing.salesBankNile.add(updates.salesBankNile)
        : updates.salesBankNile;
    }

    // Procurement fields
    if (updates.procurementTotal !== undefined) {
      updateData.procurementTotal = existing
        ? existing.procurementTotal.add(updates.procurementTotal)
        : updates.procurementTotal;
    }
    if (updates.procurementPaid !== undefined) {
      updateData.procurementPaid = existing
        ? existing.procurementPaid.add(updates.procurementPaid)
        : updates.procurementPaid;
    }
    if (updates.procurementDebt !== undefined) {
      updateData.procurementDebt = existing
        ? existing.procurementDebt.add(updates.procurementDebt)
        : updates.procurementDebt;
    }
    if (updates.procurementCount !== undefined) {
      updateData.procurementCount = (existing?.procurementCount || 0) + updates.procurementCount;
    }
    if (updates.procurementCancelled !== undefined) {
      updateData.procurementCancelled = existing
        ? existing.procurementCancelled.add(updates.procurementCancelled)
        : updates.procurementCancelled;
    }
    if (updates.procurementCash !== undefined) {
      updateData.procurementCash = existing
        ? existing.procurementCash.add(updates.procurementCash)
        : updates.procurementCash;
    }
    if (updates.procurementBank !== undefined) {
      updateData.procurementBank = existing
        ? existing.procurementBank.add(updates.procurementBank)
        : updates.procurementBank;
    }
    if (updates.procurementBankNile !== undefined) {
      updateData.procurementBankNile = existing
        ? existing.procurementBankNile.add(updates.procurementBankNile)
        : updates.procurementBankNile;
    }

    // Expenses fields
    if (updates.expensesTotal !== undefined) {
      updateData.expensesTotal = existing
        ? existing.expensesTotal.add(updates.expensesTotal)
        : updates.expensesTotal;
    }
    if (updates.expensesCount !== undefined) {
      updateData.expensesCount = (existing?.expensesCount || 0) + updates.expensesCount;
    }
    if (updates.expensesCash !== undefined) {
      updateData.expensesCash = existing
        ? existing.expensesCash.add(updates.expensesCash)
        : updates.expensesCash;
    }
    if (updates.expensesBank !== undefined) {
      updateData.expensesBank = existing
        ? existing.expensesBank.add(updates.expensesBank)
        : updates.expensesBank;
    }
    if (updates.expensesBankNile !== undefined) {
      updateData.expensesBankNile = existing
        ? existing.expensesBankNile.add(updates.expensesBankNile)
        : updates.expensesBankNile;
    }

    // Salaries fields
    if (updates.salariesTotal !== undefined) {
      updateData.salariesTotal = existing
        ? existing.salariesTotal.add(updates.salariesTotal)
        : updates.salariesTotal;
    }
    if (updates.salariesCount !== undefined) {
      updateData.salariesCount = (existing?.salariesCount || 0) + updates.salariesCount;
    }
    if (updates.salariesCash !== undefined) {
      updateData.salariesCash = existing
        ? existing.salariesCash.add(updates.salariesCash)
        : updates.salariesCash;
    }
    if (updates.salariesBank !== undefined) {
      updateData.salariesBank = existing
        ? existing.salariesBank.add(updates.salariesBank)
        : updates.salariesBank;
    }
    if (updates.salariesBankNile !== undefined) {
      updateData.salariesBankNile = existing
        ? existing.salariesBankNile.add(updates.salariesBankNile)
        : updates.salariesBankNile;
    }

    // Advances fields
    if (updates.advancesTotal !== undefined) {
      updateData.advancesTotal = existing
        ? existing.advancesTotal.add(updates.advancesTotal)
        : updates.advancesTotal;
    }
    if (updates.advancesCount !== undefined) {
      updateData.advancesCount = (existing?.advancesCount || 0) + updates.advancesCount;
    }
    if (updates.advancesCash !== undefined) {
      updateData.advancesCash = existing
        ? existing.advancesCash.add(updates.advancesCash)
        : updates.advancesCash;
    }
    if (updates.advancesBank !== undefined) {
      updateData.advancesBank = existing
        ? existing.advancesBank.add(updates.advancesBank)
        : updates.advancesBank;
    }
    if (updates.advancesBankNile !== undefined) {
      updateData.advancesBankNile = existing
        ? existing.advancesBankNile.add(updates.advancesBankNile)
        : updates.advancesBankNile;
    }

    // Cash exchanges
    if (updates.cashExchangesCash !== undefined) {
      updateData.cashExchangesCash = existing
        ? existing.cashExchangesCash.add(updates.cashExchangesCash)
        : updates.cashExchangesCash;
    }
    if (updates.cashExchangesBank !== undefined) {
      updateData.cashExchangesBank = existing
        ? existing.cashExchangesBank.add(updates.cashExchangesBank)
        : updates.cashExchangesBank;
    }
    if (updates.cashExchangesBankNile !== undefined) {
      updateData.cashExchangesBankNile = existing
        ? existing.cashExchangesBankNile.add(updates.cashExchangesBankNile)
        : updates.cashExchangesBankNile;
    }

    // Calculate net balances
    const salesReceived = updateData.salesReceived || existing?.salesReceived || new Prisma.Decimal(0);
    const salesCashAmount = updateData.salesCash || existing?.salesCash || new Prisma.Decimal(0);
    const salesBankAmount = updateData.salesBank || existing?.salesBank || new Prisma.Decimal(0);
    const salesBankNileAmount = updateData.salesBankNile || existing?.salesBankNile || new Prisma.Decimal(0);
    
    const procurementPaid = updateData.procurementPaid || existing?.procurementPaid || new Prisma.Decimal(0);
    const procurementCashAmount = updateData.procurementCash || existing?.procurementCash || new Prisma.Decimal(0);
    const procurementBankAmount = updateData.procurementBank || existing?.procurementBank || new Prisma.Decimal(0);
    const procurementBankNileAmount = updateData.procurementBankNile || existing?.procurementBankNile || new Prisma.Decimal(0);
    
    const expensesCashAmount = updateData.expensesCash || existing?.expensesCash || new Prisma.Decimal(0);
    const expensesBankAmount = updateData.expensesBank || existing?.expensesBank || new Prisma.Decimal(0);
    const expensesBankNileAmount = updateData.expensesBankNile || existing?.expensesBankNile || new Prisma.Decimal(0);
    
    const salariesCashAmount = updateData.salariesCash || existing?.salariesCash || new Prisma.Decimal(0);
    const salariesBankAmount = updateData.salariesBank || existing?.salariesBank || new Prisma.Decimal(0);
    const salariesBankNileAmount = updateData.salariesBankNile || existing?.salariesBankNile || new Prisma.Decimal(0);
    
    const advancesCashAmount = updateData.advancesCash || existing?.advancesCash || new Prisma.Decimal(0);
    const advancesBankAmount = updateData.advancesBank || existing?.advancesBank || new Prisma.Decimal(0);
    const advancesBankNileAmount = updateData.advancesBankNile || existing?.advancesBankNile || new Prisma.Decimal(0);
    
    const cashExchangesCashAmount = updateData.cashExchangesCash || existing?.cashExchangesCash || new Prisma.Decimal(0);
    const cashExchangesBankAmount = updateData.cashExchangesBank || existing?.cashExchangesBank || new Prisma.Decimal(0);
    const cashExchangesBankNileAmount = updateData.cashExchangesBankNile || existing?.cashExchangesBankNile || new Prisma.Decimal(0);

    // Get opening balances for net calculation
    const openingBalances = await prisma.openingBalance.findMany({
      where: {
        scope: 'CASHBOX',
        isClosed: false,
      },
    });

    const openingCash = openingBalances
      .filter(b => (b as any).paymentMethod === 'CASH')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    const openingBank = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    const openingBankNile = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    // Calculate net balances (opening + income - expenses - salaries - advances - procurement + cash exchanges)
    // Note: This calculates net for the entire period, not just this day
    // For daily net, we'd need to track cumulative from start of period
    const netCash = openingCash
      .add(salesCashAmount)
      .sub(procurementCashAmount)
      .sub(expensesCashAmount)
      .sub(salariesCashAmount)
      .sub(advancesCashAmount)
      .add(cashExchangesCashAmount);

    const netBank = openingBank
      .add(salesBankAmount)
      .sub(procurementBankAmount)
      .sub(expensesBankAmount)
      .sub(salariesBankAmount)
      .sub(advancesBankAmount)
      .add(cashExchangesBankAmount);

    const netBankNile = openingBankNile
      .add(salesBankNileAmount)
      .sub(procurementBankNileAmount)
      .sub(expensesBankNileAmount)
      .sub(salariesBankNileAmount)
      .sub(advancesBankNileAmount)
      .add(cashExchangesBankNileAmount);

    updateData.netCash = netCash;
    updateData.netBank = netBank;
    updateData.netBankNile = netBankNile;
    updateData.netTotal = netCash.add(netBank).add(netBankNile);

    // Recalculate sales debt if needed
    if (updateData.salesTotal && updateData.salesReceived) {
      updateData.salesDebt = updateData.salesTotal.sub(updateData.salesReceived);
    }

    // Recalculate procurement debt if needed
    if (updateData.procurementTotal && updateData.procurementPaid) {
      updateData.procurementDebt = updateData.procurementTotal.sub(updateData.procurementPaid);
    }

    // Upsert the aggregate
    await prisma.dailyFinancialAggregate.upsert({
      where: {
        date_inventoryId_section: {
          date: dateOnly,
          inventoryId: (inventoryId ?? null) as string | null,
          section: (section ?? null) as Section | null,
        },
      },
      update: updateData,
      create: {
        date: dateOnly,
        inventoryId: (inventoryId ?? null) as string | null,
        section: (section ?? null) as Section | null,
        ...updateData,
      },
    });

    // Update monthly aggregate
    await this.updateMonthlyAggregate(date, updates, inventoryId, section);
  }

  /**
   * Update monthly aggregate from daily aggregate
   */
  private async updateMonthlyAggregate(
    date: Date,
    updates: DailyAggregateUpdate,
    inventoryId?: string,
    section?: Section
  ): Promise<void> {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    const existing = await prisma.monthlyFinancialAggregate.findUnique({
      where: {
        year_month_inventoryId_section: {
          year,
          month,
          inventoryId: (inventoryId ?? null) as string | null,
          section: (section ?? null) as Section | null,
        },
      },
    });

    // Build update data (similar to daily)
    const updateData: any = {};
    
    // Apply same logic as daily aggregate but sum all daily values for the month
    // For now, we'll recalculate from all daily aggregates for the month
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const dailyAggregates = await prisma.dailyFinancialAggregate.findMany({
      where: {
        date: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
        inventoryId: (inventoryId ?? null) as string | null,
        section: (section ?? null) as Section | null,
      },
    });

    // Sum all daily aggregates
    const monthlyTotals = dailyAggregates.reduce((acc, daily) => ({
      salesTotal: acc.salesTotal.add(daily.salesTotal),
      salesReceived: acc.salesReceived.add(daily.salesReceived),
      salesDebt: acc.salesDebt.add(daily.salesDebt),
      salesCount: acc.salesCount + daily.salesCount,
      salesCash: acc.salesCash.add(daily.salesCash),
      salesBank: acc.salesBank.add(daily.salesBank),
      salesBankNile: acc.salesBankNile.add(daily.salesBankNile),
      procurementTotal: acc.procurementTotal.add(daily.procurementTotal),
      procurementPaid: acc.procurementPaid.add(daily.procurementPaid),
      procurementDebt: acc.procurementDebt.add(daily.procurementDebt),
      procurementCount: acc.procurementCount + daily.procurementCount,
      procurementCancelled: acc.procurementCancelled.add(daily.procurementCancelled),
      procurementCash: acc.procurementCash.add(daily.procurementCash),
      procurementBank: acc.procurementBank.add(daily.procurementBank),
      procurementBankNile: acc.procurementBankNile.add(daily.procurementBankNile),
      expensesTotal: acc.expensesTotal.add(daily.expensesTotal),
      expensesCount: acc.expensesCount + daily.expensesCount,
      expensesCash: acc.expensesCash.add(daily.expensesCash),
      expensesBank: acc.expensesBank.add(daily.expensesBank),
      expensesBankNile: acc.expensesBankNile.add(daily.expensesBankNile),
      salariesTotal: acc.salariesTotal.add(daily.salariesTotal),
      salariesCount: acc.salariesCount + daily.salariesCount,
      salariesCash: acc.salariesCash.add(daily.salariesCash),
      salariesBank: acc.salariesBank.add(daily.salariesBank),
      salariesBankNile: acc.salariesBankNile.add(daily.salariesBankNile),
      advancesTotal: acc.advancesTotal.add(daily.advancesTotal),
      advancesCount: acc.advancesCount + daily.advancesCount,
      advancesCash: acc.advancesCash.add(daily.advancesCash),
      advancesBank: acc.advancesBank.add(daily.advancesBank),
      advancesBankNile: acc.advancesBankNile.add(daily.advancesBankNile),
      cashExchangesCash: acc.cashExchangesCash.add(daily.cashExchangesCash),
      cashExchangesBank: acc.cashExchangesBank.add(daily.cashExchangesBank),
      cashExchangesBankNile: acc.cashExchangesBankNile.add(daily.cashExchangesBankNile),
    }), {
      salesTotal: new Prisma.Decimal(0),
      salesReceived: new Prisma.Decimal(0),
      salesDebt: new Prisma.Decimal(0),
      salesCount: 0,
      salesCash: new Prisma.Decimal(0),
      salesBank: new Prisma.Decimal(0),
      salesBankNile: new Prisma.Decimal(0),
      procurementTotal: new Prisma.Decimal(0),
      procurementPaid: new Prisma.Decimal(0),
      procurementDebt: new Prisma.Decimal(0),
      procurementCount: 0,
      procurementCancelled: new Prisma.Decimal(0),
      procurementCash: new Prisma.Decimal(0),
      procurementBank: new Prisma.Decimal(0),
      procurementBankNile: new Prisma.Decimal(0),
      expensesTotal: new Prisma.Decimal(0),
      expensesCount: 0,
      expensesCash: new Prisma.Decimal(0),
      expensesBank: new Prisma.Decimal(0),
      expensesBankNile: new Prisma.Decimal(0),
      salariesTotal: new Prisma.Decimal(0),
      salariesCount: 0,
      salariesCash: new Prisma.Decimal(0),
      salariesBank: new Prisma.Decimal(0),
      salariesBankNile: new Prisma.Decimal(0),
      advancesTotal: new Prisma.Decimal(0),
      advancesCount: 0,
      advancesCash: new Prisma.Decimal(0),
      advancesBank: new Prisma.Decimal(0),
      advancesBankNile: new Prisma.Decimal(0),
      cashExchangesCash: new Prisma.Decimal(0),
      cashExchangesBank: new Prisma.Decimal(0),
      cashExchangesBankNile: new Prisma.Decimal(0),
    });

    // Calculate net balances
    const openingBalances = await prisma.openingBalance.findMany({
      where: {
        scope: 'CASHBOX',
        isClosed: false,
      },
    });

    const openingCash = openingBalances
      .filter(b => (b as any).paymentMethod === 'CASH')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    const openingBank = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    const openingBankNile = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    const netCash = openingCash
      .add(monthlyTotals.salesCash)
      .sub(monthlyTotals.procurementCash)
      .sub(monthlyTotals.expensesCash)
      .sub(monthlyTotals.salariesCash)
      .sub(monthlyTotals.advancesCash)
      .add(monthlyTotals.cashExchangesCash);

    const netBank = openingBank
      .add(monthlyTotals.salesBank)
      .sub(monthlyTotals.procurementBank)
      .sub(monthlyTotals.expensesBank)
      .sub(monthlyTotals.salariesBank)
      .sub(monthlyTotals.advancesBank)
      .add(monthlyTotals.cashExchangesBank);

    const netBankNile = openingBankNile
      .add(monthlyTotals.salesBankNile)
      .sub(monthlyTotals.procurementBankNile)
      .sub(monthlyTotals.expensesBankNile)
      .sub(monthlyTotals.salariesBankNile)
      .sub(monthlyTotals.advancesBankNile)
      .add(monthlyTotals.cashExchangesBankNile);

    await prisma.monthlyFinancialAggregate.upsert({
      where: {
        year_month_inventoryId_section: {
          year,
          month,
          inventoryId: (inventoryId ?? null) as string | null,
          section: (section ?? null) as Section | null,
        },
      },
      update: {
        ...monthlyTotals,
        netCash,
        netBank,
        netBankNile,
        netTotal: netCash.add(netBank).add(netBankNile),
      },
      create: {
        year,
        month,
        inventoryId: (inventoryId ?? null) as string | null,
        section: (section ?? null) as Section | null,
        ...monthlyTotals,
        netCash,
        netBank,
        netBankNile,
        netTotal: netCash.add(netBank).add(netBankNile),
      },
    });
  }

  /**
   * Update daily item sales aggregate
   */
  async updateDailyItemSalesAggregate(
    date: Date,
    itemId: string,
    updates: {
      quantity: Prisma.Decimal;
      giftQty?: Prisma.Decimal;
      amount: Prisma.Decimal;
      invoiceCount?: number;
    },
    inventoryId?: string,
    section?: Section
  ): Promise<void> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    const existing = await prisma.dailyItemSalesAggregate.findUnique({
      where: {
        date_inventoryId_itemId_section: {
          date: dateOnly,
          inventoryId: inventoryId || null,
          itemId,
          section: section || null,
        },
      },
    });

    const totalQuantity = existing
      ? existing.totalQuantity.add(updates.quantity)
      : updates.quantity;
    const totalGiftQty = existing && updates.giftQty
      ? existing.totalGiftQty.add(updates.giftQty)
      : (updates.giftQty || new Prisma.Decimal(0));
    const totalAmount = existing
      ? existing.totalAmount.add(updates.amount)
      : updates.amount;
    const invoiceCount = (existing?.invoiceCount || 0) + (updates.invoiceCount || 1);
    
    // Calculate average unit price
    const averageUnitPrice = totalQuantity.greaterThan(0)
      ? totalAmount.div(totalQuantity)
      : new Prisma.Decimal(0);

    await prisma.dailyItemSalesAggregate.upsert({
      where: {
        date_inventoryId_itemId_section: {
          date: dateOnly,
          inventoryId: inventoryId || null,
          itemId,
          section: section || null,
        },
      },
      update: {
        totalQuantity,
        totalGiftQty,
        totalAmount,
        averageUnitPrice,
        invoiceCount,
      },
      create: {
        date: dateOnly,
        inventoryId: inventoryId || null,
        itemId,
        section: section || null,
        totalQuantity,
        totalGiftQty,
        totalAmount,
        averageUnitPrice,
        invoiceCount,
      },
    });
  }

  /**
   * Update customer cumulative aggregate
   */
  async updateCustomerCumulativeAggregate(
    customerId: string,
    date: Date,
    updates: {
      totalSales?: Prisma.Decimal;
      totalPaid?: Prisma.Decimal;
      invoiceCount?: number;
      salesCash?: Prisma.Decimal;
      salesBank?: Prisma.Decimal;
      salesBankNile?: Prisma.Decimal;
    }
  ): Promise<void> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    // Get the latest aggregate before this date to maintain cumulative totals
    const previousAggregate = await prisma.customerCumulativeAggregate.findFirst({
      where: {
        customerId,
        date: { lt: dateOnly },
      },
      orderBy: { date: 'desc' },
    });

    const totalSales = previousAggregate
      ? previousAggregate.totalSales.add(updates.totalSales || 0)
      : (updates.totalSales || new Prisma.Decimal(0));
    const totalPaid = previousAggregate
      ? previousAggregate.totalPaid.add(updates.totalPaid || 0)
      : (updates.totalPaid || new Prisma.Decimal(0));
    const totalOutstanding = totalSales.sub(totalPaid);
    const totalInvoices = (previousAggregate?.totalInvoices || 0) + (updates.invoiceCount || 0);

    const salesCash = previousAggregate
      ? previousAggregate.salesCash.add(updates.salesCash || 0)
      : (updates.salesCash || new Prisma.Decimal(0));
    const salesBank = previousAggregate
      ? previousAggregate.salesBank.add(updates.salesBank || 0)
      : (updates.salesBank || new Prisma.Decimal(0));
    const salesBankNile = previousAggregate
      ? previousAggregate.salesBankNile.add(updates.salesBankNile || 0)
      : (updates.salesBankNile || new Prisma.Decimal(0));

    await prisma.customerCumulativeAggregate.upsert({
      where: {
        customerId_date: {
          customerId,
          date: dateOnly,
        },
      },
      update: {
        totalInvoices,
        totalSales,
        totalPaid,
        totalOutstanding,
        salesCash,
        salesBank,
        salesBankNile,
      },
      create: {
        customerId,
        date: dateOnly,
        totalInvoices,
        totalSales,
        totalPaid,
        totalOutstanding,
        salesCash,
        salesBank,
        salesBankNile,
      },
    });
  }

  /**
   * Update supplier cumulative aggregate
   */
  async updateSupplierCumulativeAggregate(
    supplierId: string,
    date: Date,
    updates: {
      totalPurchases?: Prisma.Decimal;
      totalPaid?: Prisma.Decimal;
      orderCount?: number;
      purchasesCash?: Prisma.Decimal;
      purchasesBank?: Prisma.Decimal;
      purchasesBankNile?: Prisma.Decimal;
    }
  ): Promise<void> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    // Get the latest aggregate before this date
    const previousAggregate = await prisma.supplierCumulativeAggregate.findFirst({
      where: {
        supplierId,
        date: { lt: dateOnly },
      },
      orderBy: { date: 'desc' },
    });

    const totalPurchases = previousAggregate
      ? previousAggregate.totalPurchases.add(updates.totalPurchases || 0)
      : (updates.totalPurchases || new Prisma.Decimal(0));
    const totalPaid = previousAggregate
      ? previousAggregate.totalPaid.add(updates.totalPaid || 0)
      : (updates.totalPaid || new Prisma.Decimal(0));
    const totalOutstanding = totalPurchases.sub(totalPaid);
    const totalOrders = (previousAggregate?.totalOrders || 0) + (updates.orderCount || 0);

    const purchasesCash = previousAggregate
      ? previousAggregate.purchasesCash.add(updates.purchasesCash || 0)
      : (updates.purchasesCash || new Prisma.Decimal(0));
    const purchasesBank = previousAggregate
      ? previousAggregate.purchasesBank.add(updates.purchasesBank || 0)
      : (updates.purchasesBank || new Prisma.Decimal(0));
    const purchasesBankNile = previousAggregate
      ? previousAggregate.purchasesBankNile.add(updates.purchasesBankNile || 0)
      : (updates.purchasesBankNile || new Prisma.Decimal(0));

    await prisma.supplierCumulativeAggregate.upsert({
      where: {
        supplierId_date: {
          supplierId,
          date: dateOnly,
        },
      },
      update: {
        totalOrders,
        totalPurchases,
        totalPaid,
        totalOutstanding,
        purchasesCash,
        purchasesBank,
        purchasesBankNile,
      },
      create: {
        supplierId,
        date: dateOnly,
        totalOrders,
        totalPurchases,
        totalPaid,
        totalOutstanding,
        purchasesCash,
        purchasesBank,
        purchasesBankNile,
      },
    });
  }

  /**
   * Update cumulative balance snapshot
   */
  async updateBalanceSnapshot(
    date: Date,
    updates: {
      openingCash?: Prisma.Decimal;
      openingBank?: Prisma.Decimal;
      openingBankNile?: Prisma.Decimal;
      closingCash?: Prisma.Decimal;
      closingBank?: Prisma.Decimal;
      closingBankNile?: Prisma.Decimal;
      receivablesTotal?: Prisma.Decimal;
      payablesTotal?: Prisma.Decimal;
      payablesWithExpenses?: Prisma.Decimal;
    },
    inventoryId?: string,
    section?: Section
  ): Promise<void> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    await prisma.cumulativeBalanceSnapshot.upsert({
      where: {
        date_inventoryId_section: {
          date: dateOnly,
          inventoryId: (inventoryId ?? null) as string | null,
          section: (section ?? null) as Section | null,
        },
      },
      update: updates,
      create: {
        date: dateOnly,
        inventoryId: (inventoryId ?? null) as string | null,
        section: (section ?? null) as Section | null,
        openingCash: updates.openingCash || new Prisma.Decimal(0),
        openingBank: updates.openingBank || new Prisma.Decimal(0),
        openingBankNile: updates.openingBankNile || new Prisma.Decimal(0),
        closingCash: updates.closingCash || new Prisma.Decimal(0),
        closingBank: updates.closingBank || new Prisma.Decimal(0),
        closingBankNile: updates.closingBankNile || new Prisma.Decimal(0),
        receivablesTotal: updates.receivablesTotal || new Prisma.Decimal(0),
        payablesTotal: updates.payablesTotal || new Prisma.Decimal(0),
        payablesWithExpenses: updates.payablesWithExpenses || new Prisma.Decimal(0),
      },
    });
  }

  /**
   * Get aggregates for date range (for reports)
   */
  async getDailyAggregatesForRange(
    startDate: Date,
    endDate: Date,
    filters?: {
      inventoryId?: string;
      section?: Section;
    }
  ) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    return await prisma.dailyFinancialAggregate.findMany({
      where: {
        date: {
          gte: start,
          lte: end,
        },
        ...(filters?.inventoryId ? { inventoryId: filters.inventoryId } : {}),
        ...(filters?.section ? { section: filters.section } : {}),
      },
      orderBy: { date: 'desc' },
    });
  }

  /**
   * Get monthly aggregates for range
   */
  async getMonthlyAggregatesForRange(
    startYear: number,
    startMonth: number,
    endYear: number,
    endMonth: number,
    filters?: {
      inventoryId?: string;
      section?: Section;
    }
  ) {
    return await prisma.monthlyFinancialAggregate.findMany({
      where: {
        OR: [
          { year: startYear, month: { gte: startMonth } },
          { year: { gt: startYear, lt: endYear } },
          { year: endYear, month: { lte: endMonth } },
        ],
        ...(filters?.inventoryId ? { inventoryId: filters.inventoryId } : {}),
        ...(filters?.section ? { section: filters.section } : {}),
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  /**
   * Recalculate aggregate for a specific date (for data integrity)
   */
  async recalculateDate(date: Date, inventoryId?: string, section?: Section): Promise<void> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);
    const dateEnd = new Date(dateOnly);
    dateEnd.setHours(23, 59, 59, 999);

    // Recalculate from all transactions for this date
    const where: any = {
      createdAt: {
        gte: dateOnly,
        lte: dateEnd,
      },
    };
    if (inventoryId) where.inventoryId = inventoryId;
    if (section) where.section = section;

    // Get all transactions
    const invoices = await prisma.salesInvoice.findMany({ where });
    const orders = await prisma.procOrder.findMany({ where });
    const expenses = await prisma.expense.findMany({ where });
    const salaries = await prisma.salary.findMany({
      where: {
        paidAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      },
    });
    const advances = await prisma.advance.findMany({
      where: {
        paidAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      },
    });
    const cashExchanges = await prisma.cashExchange.findMany({
      where: {
        createdAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      },
    });

    // Calculate totals
    const salesTotal = invoices.reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0));
    const salesReceived = invoices.reduce((sum, inv) => sum.add(inv.paidAmount), new Prisma.Decimal(0));
    const salesDebt = salesTotal.sub(salesReceived);
    
    const salesByMethod = {
      CASH: invoices.filter(inv => inv.paymentMethod === 'CASH').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
      BANK: invoices.filter(inv => inv.paymentMethod === 'BANK').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
      BANK_NILE: invoices.filter(inv => inv.paymentMethod === 'BANK_NILE').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
    };

    const procurementTotal = orders
      .filter(o => o.status !== 'CANCELLED')
      .reduce((sum, o) => sum.add(o.total), new Prisma.Decimal(0));
    const procurementPaid = orders.reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0));
    const procurementCancelled = orders
      .filter(o => o.status === 'CANCELLED')
      .reduce((sum, o) => sum.add(o.total), new Prisma.Decimal(0));

    const expensesTotal = expenses.reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));
    const expensesByMethod = {
      CASH: expenses.filter(e => e.method === 'CASH').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
      BANK: expenses.filter(e => e.method === 'BANK').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
      BANK_NILE: expenses.filter(e => e.method === 'BANK_NILE').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
    };

    const salariesTotal = salaries.reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));
    const salariesByMethod = {
      CASH: salaries.filter(s => s.paymentMethod === 'CASH').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANK: salaries.filter(s => s.paymentMethod === 'BANK').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANK_NILE: salaries.filter(s => s.paymentMethod === 'BANK_NILE').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
    };

    const advancesTotal = advances.reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));
    const advancesByMethod = {
      CASH: advances.filter(a => a.paymentMethod === 'CASH').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANK: advances.filter(a => a.paymentMethod === 'BANK').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANK_NILE: advances.filter(a => a.paymentMethod === 'BANK_NILE').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
    };

    // Update aggregate
    await this.updateDailyFinancialAggregate(date, {
      salesTotal,
      salesReceived,
      salesDebt,
      salesCount: invoices.length,
      salesCash: salesByMethod.CASH,
      salesBank: salesByMethod.BANK,
      salesBankNile: salesByMethod.BANK_NILE,
      procurementTotal,
      procurementPaid,
      procurementDebt: procurementTotal.sub(procurementPaid),
      procurementCount: orders.filter(o => o.status !== 'CANCELLED').length,
      procurementCancelled,
      expensesTotal,
      expensesCount: expenses.length,
      expensesCash: expensesByMethod.CASH,
      expensesBank: expensesByMethod.BANK,
      expensesBankNile: expensesByMethod.BANK_NILE,
      salariesTotal,
      salariesCount: salaries.length,
      salariesCash: salariesByMethod.CASH,
      salariesBank: salariesByMethod.BANK,
      salariesBankNile: salariesByMethod.BANK_NILE,
      advancesTotal,
      advancesCount: advances.length,
      advancesCash: advancesByMethod.CASH,
      advancesBank: advancesByMethod.BANK,
      advancesBankNile: advancesByMethod.BANK_NILE,
    }, inventoryId, section);
  }
}

export const aggregationService = new AggregationService();

