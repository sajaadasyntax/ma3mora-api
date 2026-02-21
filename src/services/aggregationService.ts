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
  salesDebtMethod?: Prisma.Decimal;
  salesOthers?: Prisma.Decimal;
  procurementTotal?: Prisma.Decimal;
  procurementPaid?: Prisma.Decimal;
  procurementDebt?: Prisma.Decimal;
  procurementCount?: number;
  procurementCancelled?: Prisma.Decimal;
  procurementCash?: Prisma.Decimal;
  procurementBank?: Prisma.Decimal;
  procurementBankNile?: Prisma.Decimal;
  procurementDebtMethod?: Prisma.Decimal;
  procurementOthers?: Prisma.Decimal;
  expensesTotal?: Prisma.Decimal;
  expensesCount?: number;
  expensesCash?: Prisma.Decimal;
  expensesBank?: Prisma.Decimal;
  expensesBankNile?: Prisma.Decimal;
  expensesDebtMethod?: Prisma.Decimal;
  expensesOthers?: Prisma.Decimal;
  incomeTotal?: Prisma.Decimal;
  incomeCount?: number;
  incomeCash?: Prisma.Decimal;
  incomeBank?: Prisma.Decimal;
  incomeBankNile?: Prisma.Decimal;
  incomeDebtMethod?: Prisma.Decimal;
  incomeOthers?: Prisma.Decimal;
  salariesTotal?: Prisma.Decimal;
  salariesCount?: number;
  salariesCash?: Prisma.Decimal;
  salariesBank?: Prisma.Decimal;
  salariesBankNile?: Prisma.Decimal;
  salariesDebtMethod?: Prisma.Decimal;
  salariesOthers?: Prisma.Decimal;
  advancesTotal?: Prisma.Decimal;
  advancesCount?: number;
  advancesCash?: Prisma.Decimal;
  advancesBank?: Prisma.Decimal;
  advancesBankNile?: Prisma.Decimal;
  advancesDebtMethod?: Prisma.Decimal;
  advancesOthers?: Prisma.Decimal;
  cashExchangesCash?: Prisma.Decimal;
  cashExchangesBank?: Prisma.Decimal;
  cashExchangesBankNile?: Prisma.Decimal;
  cashExchangesDebtMethod?: Prisma.Decimal;
  cashExchangesOthers?: Prisma.Decimal;
  treasuryInflow?: Prisma.Decimal;
  treasuryOutflow?: Prisma.Decimal;
  customerPaymentsTotal?: Prisma.Decimal;
  customerPaymentsCount?: number;
  salesReturnsTotal?: Prisma.Decimal;
  salesReturnsCount?: number;
  netDebt?: Prisma.Decimal;
  netOthers?: Prisma.Decimal;
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
    // Handle null values explicitly for Prisma unique constraint
    const whereClause: any = {
      date: dateOnly,
      inventoryId: inventoryId ?? null,
      section: section ?? null,
    };
    const existing: any = await prisma.dailyFinancialAggregate.findUnique({
      where: {
        date_inventoryId_section: whereClause,
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
    if (updates.salesDebtMethod !== undefined) {
      updateData.salesDebtMethod = existing
        ? existing.salesDebtMethod.add(updates.salesDebtMethod)
        : updates.salesDebtMethod;
    }
    if (updates.salesOthers !== undefined) {
      updateData.salesOthers = existing
        ? existing.salesOthers.add(updates.salesOthers)
        : updates.salesOthers;
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
    if (updates.procurementDebtMethod !== undefined) {
      updateData.procurementDebtMethod = existing
        ? existing.procurementDebtMethod.add(updates.procurementDebtMethod)
        : updates.procurementDebtMethod;
    }
    if (updates.procurementOthers !== undefined) {
      updateData.procurementOthers = existing
        ? existing.procurementOthers.add(updates.procurementOthers)
        : updates.procurementOthers;
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
    if (updates.expensesDebtMethod !== undefined) {
      updateData.expensesDebtMethod = existing
        ? existing.expensesDebtMethod.add(updates.expensesDebtMethod)
        : updates.expensesDebtMethod;
    }
    if (updates.expensesOthers !== undefined) {
      updateData.expensesOthers = existing
        ? existing.expensesOthers.add(updates.expensesOthers)
        : updates.expensesOthers;
    }
    
    // Income fields (opposite of expenses - money coming IN)
    if (updates.incomeTotal !== undefined) {
      updateData.incomeTotal = existing
        ? existing.incomeTotal.add(updates.incomeTotal)
        : updates.incomeTotal;
    }
    if (updates.incomeCount !== undefined) {
      updateData.incomeCount = (existing?.incomeCount || 0) + updates.incomeCount;
    }
    if (updates.incomeCash !== undefined) {
      updateData.incomeCash = existing
        ? existing.incomeCash.add(updates.incomeCash)
        : updates.incomeCash;
    }
    if (updates.incomeBank !== undefined) {
      updateData.incomeBank = existing
        ? existing.incomeBank.add(updates.incomeBank)
        : updates.incomeBank;
    }
    if (updates.incomeBankNile !== undefined) {
      updateData.incomeBankNile = existing
        ? existing.incomeBankNile.add(updates.incomeBankNile)
        : updates.incomeBankNile;
    }
    if (updates.incomeDebtMethod !== undefined) {
      updateData.incomeDebtMethod = existing
        ? existing.incomeDebtMethod.add(updates.incomeDebtMethod)
        : updates.incomeDebtMethod;
    }
    if (updates.incomeOthers !== undefined) {
      updateData.incomeOthers = existing
        ? existing.incomeOthers.add(updates.incomeOthers)
        : updates.incomeOthers;
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
    if (updates.salariesDebtMethod !== undefined) {
      updateData.salariesDebtMethod = existing
        ? existing.salariesDebtMethod.add(updates.salariesDebtMethod)
        : updates.salariesDebtMethod;
    }
    if (updates.salariesOthers !== undefined) {
      updateData.salariesOthers = existing
        ? existing.salariesOthers.add(updates.salariesOthers)
        : updates.salariesOthers;
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
    if (updates.advancesDebtMethod !== undefined) {
      updateData.advancesDebtMethod = existing
        ? existing.advancesDebtMethod.add(updates.advancesDebtMethod)
        : updates.advancesDebtMethod;
    }
    if (updates.advancesOthers !== undefined) {
      updateData.advancesOthers = existing
        ? existing.advancesOthers.add(updates.advancesOthers)
        : updates.advancesOthers;
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
    if (updates.cashExchangesDebtMethod !== undefined) {
      updateData.cashExchangesDebtMethod = existing
        ? existing.cashExchangesDebtMethod.add(updates.cashExchangesDebtMethod)
        : updates.cashExchangesDebtMethod;
    }
    if (updates.cashExchangesOthers !== undefined) {
      updateData.cashExchangesOthers = existing
        ? existing.cashExchangesOthers.add(updates.cashExchangesOthers)
        : updates.cashExchangesOthers;
    }

    // Treasury fields
    if (updates.treasuryInflow !== undefined) {
      updateData.treasuryInflow = existing
        ? existing.treasuryInflow.add(updates.treasuryInflow)
        : updates.treasuryInflow;
    }
    if (updates.treasuryOutflow !== undefined) {
      updateData.treasuryOutflow = existing
        ? existing.treasuryOutflow.add(updates.treasuryOutflow)
        : updates.treasuryOutflow;
    }

    // Customer payments fields
    if (updates.customerPaymentsTotal !== undefined) {
      updateData.customerPaymentsTotal = existing
        ? existing.customerPaymentsTotal.add(updates.customerPaymentsTotal)
        : updates.customerPaymentsTotal;
    }
    if (updates.customerPaymentsCount !== undefined) {
      updateData.customerPaymentsCount = (existing?.customerPaymentsCount || 0) + updates.customerPaymentsCount;
    }

    // Sales returns fields
    if (updates.salesReturnsTotal !== undefined) {
      updateData.salesReturnsTotal = existing
        ? existing.salesReturnsTotal.add(updates.salesReturnsTotal)
        : updates.salesReturnsTotal;
    }
    if (updates.salesReturnsCount !== undefined) {
      updateData.salesReturnsCount = (existing?.salesReturnsCount || 0) + updates.salesReturnsCount;
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
    
    const incomeCashAmount = updateData.incomeCash || existing?.incomeCash || new Prisma.Decimal(0);
    const incomeBankAmount = updateData.incomeBank || existing?.incomeBank || new Prisma.Decimal(0);
    const incomeBankNileAmount = updateData.incomeBankNile || existing?.incomeBankNile || new Prisma.Decimal(0);
    
    const salariesCashAmount = updateData.salariesCash || existing?.salariesCash || new Prisma.Decimal(0);
    const salariesBankAmount = updateData.salariesBank || existing?.salariesBank || new Prisma.Decimal(0);
    const salariesBankNileAmount = updateData.salariesBankNile || existing?.salariesBankNile || new Prisma.Decimal(0);
    
    const advancesCashAmount = updateData.advancesCash || existing?.advancesCash || new Prisma.Decimal(0);
    const advancesBankAmount = updateData.advancesBank || existing?.advancesBank || new Prisma.Decimal(0);
    const advancesBankNileAmount = updateData.advancesBankNile || existing?.advancesBankNile || new Prisma.Decimal(0);
    
    const cashExchangesCashAmount = updateData.cashExchangesCash || existing?.cashExchangesCash || new Prisma.Decimal(0);
    const cashExchangesBankAmount = updateData.cashExchangesBank || existing?.cashExchangesBank || new Prisma.Decimal(0);
    const cashExchangesBankNileAmount = updateData.cashExchangesBankNile || existing?.cashExchangesBankNile || new Prisma.Decimal(0);

    const salesDebtMethodAmount = updateData.salesDebtMethod || existing?.salesDebtMethod || new Prisma.Decimal(0);
    const salesOthersAmount = updateData.salesOthers || existing?.salesOthers || new Prisma.Decimal(0);
    const procurementDebtMethodAmount = updateData.procurementDebtMethod || existing?.procurementDebtMethod || new Prisma.Decimal(0);
    const procurementOthersAmount = updateData.procurementOthers || existing?.procurementOthers || new Prisma.Decimal(0);
    const expensesDebtMethodAmount = updateData.expensesDebtMethod || existing?.expensesDebtMethod || new Prisma.Decimal(0);
    const expensesOthersAmount = updateData.expensesOthers || existing?.expensesOthers || new Prisma.Decimal(0);
    const incomeDebtMethodAmount = updateData.incomeDebtMethod || existing?.incomeDebtMethod || new Prisma.Decimal(0);
    const incomeOthersAmount = updateData.incomeOthers || existing?.incomeOthers || new Prisma.Decimal(0);
    const salariesDebtMethodAmount = updateData.salariesDebtMethod || existing?.salariesDebtMethod || new Prisma.Decimal(0);
    const salariesOthersAmount = updateData.salariesOthers || existing?.salariesOthers || new Prisma.Decimal(0);
    const advancesDebtMethodAmount = updateData.advancesDebtMethod || existing?.advancesDebtMethod || new Prisma.Decimal(0);
    const advancesOthersAmount = updateData.advancesOthers || existing?.advancesOthers || new Prisma.Decimal(0);
    const cashExchangesDebtMethodAmount = updateData.cashExchangesDebtMethod || existing?.cashExchangesDebtMethod || new Prisma.Decimal(0);
    const cashExchangesOthersAmount = updateData.cashExchangesOthers || existing?.cashExchangesOthers || new Prisma.Decimal(0);

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
      .filter(b => (b as any).paymentMethod === 'BANKAK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    const openingBankNile = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    // Calculate net balances (opening + sales + income - expenses - salaries - advances - procurement + cash exchanges)
    // Note: This calculates net for the entire period, not just this day
    // For daily net, we'd need to track cumulative from start of period
    const netCash = openingCash
      .add(salesCashAmount)
      .add(incomeCashAmount)
      .sub(procurementCashAmount)
      .sub(expensesCashAmount)
      .sub(salariesCashAmount)
      .sub(advancesCashAmount)
      .add(cashExchangesCashAmount);

    const netBank = openingBank
      .add(salesBankAmount)
      .add(incomeBankAmount)
      .sub(procurementBankAmount)
      .sub(expensesBankAmount)
      .sub(salariesBankAmount)
      .sub(advancesBankAmount)
      .add(cashExchangesBankAmount);

    const netBankNile = openingBankNile
      .add(salesBankNileAmount)
      .add(incomeBankNileAmount)
      .sub(procurementBankNileAmount)
      .sub(expensesBankNileAmount)
      .sub(salariesBankNileAmount)
      .sub(advancesBankNileAmount)
      .add(cashExchangesBankNileAmount);

    const netDebt = salesDebtMethodAmount
      .add(incomeDebtMethodAmount)
      .sub(procurementDebtMethodAmount)
      .sub(expensesDebtMethodAmount)
      .sub(salariesDebtMethodAmount)
      .sub(advancesDebtMethodAmount)
      .add(cashExchangesDebtMethodAmount);

    const netOthers = salesOthersAmount
      .add(incomeOthersAmount)
      .sub(procurementOthersAmount)
      .sub(expensesOthersAmount)
      .sub(salariesOthersAmount)
      .sub(advancesOthersAmount)
      .add(cashExchangesOthersAmount);

    updateData.netCash = netCash;
    updateData.netBank = netBank;
    updateData.netBankNile = netBankNile;
    updateData.netDebt = netDebt;
    updateData.netOthers = netOthers;
    updateData.netTotal = netCash.add(netBank).add(netBankNile).add(netDebt).add(netOthers);

    // Recalculate sales debt if needed
    if (updateData.salesTotal && updateData.salesReceived) {
      updateData.salesDebt = updateData.salesTotal.sub(updateData.salesReceived);
    }

    // Recalculate procurement debt if needed
    if (updateData.procurementTotal && updateData.procurementPaid) {
      updateData.procurementDebt = updateData.procurementTotal.sub(updateData.procurementPaid);
    }

    // Upsert the aggregate
    // Handle null values explicitly for Prisma unique constraint
    const upsertWhereClause: any = {
      date: dateOnly,
      inventoryId: inventoryId ?? null,
      section: section ?? null,
    };
    const createData: any = {
      date: dateOnly,
      ...(inventoryId !== undefined && inventoryId !== null ? { inventoryId } : {}),
      ...(section !== undefined && section !== null ? { section } : {}),
      ...updateData,
    };
    await prisma.dailyFinancialAggregate.upsert({
      where: {
        date_inventoryId_section: upsertWhereClause,
      },
      update: updateData,
      create: createData,
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

    const monthlyWhereClause: any = {
      year,
      month,
      inventoryId: (inventoryId ?? null) as any,
      section: (section ?? null) as any,
    };
    const existing = await prisma.monthlyFinancialAggregate.findUnique({
      where: {
        year_month_inventoryId_section: monthlyWhereClause,
      },
    });

    // Build update data (similar to daily)
    const updateData: any = {};
    
    // Apply same logic as daily aggregate but sum all daily values for the month
    // For now, we'll recalculate from all daily aggregates for the month
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const dailyAggregatesWhere: any = {
      date: {
        gte: startOfMonth,
        lte: endOfMonth,
      },
      inventoryId: (inventoryId ?? null) as any,
      section: (section ?? null) as any,
    };
    const dailyAggregates: any[] = await prisma.dailyFinancialAggregate.findMany({
      where: dailyAggregatesWhere,
    });

    // Sum all daily aggregates
    const monthlyTotals = dailyAggregates.reduce((acc: any, daily: any) => ({
      salesTotal: acc.salesTotal.add(daily.salesTotal),
      salesReceived: acc.salesReceived.add(daily.salesReceived),
      salesDebt: acc.salesDebt.add(daily.salesDebt),
      salesCount: acc.salesCount + daily.salesCount,
      salesCash: acc.salesCash.add(daily.salesCash),
      salesBank: acc.salesBank.add(daily.salesBank),
      salesBankNile: acc.salesBankNile.add(daily.salesBankNile),
      salesDebtMethod: acc.salesDebtMethod.add(daily.salesDebtMethod),
      salesOthers: acc.salesOthers.add(daily.salesOthers),
      procurementTotal: acc.procurementTotal.add(daily.procurementTotal),
      procurementPaid: acc.procurementPaid.add(daily.procurementPaid),
      procurementDebt: acc.procurementDebt.add(daily.procurementDebt),
      procurementCount: acc.procurementCount + daily.procurementCount,
      procurementCancelled: acc.procurementCancelled.add(daily.procurementCancelled),
      procurementCash: acc.procurementCash.add(daily.procurementCash),
      procurementBank: acc.procurementBank.add(daily.procurementBank),
      procurementBankNile: acc.procurementBankNile.add(daily.procurementBankNile),
      procurementDebtMethod: acc.procurementDebtMethod.add(daily.procurementDebtMethod),
      procurementOthers: acc.procurementOthers.add(daily.procurementOthers),
      expensesTotal: acc.expensesTotal.add(daily.expensesTotal),
      expensesCount: acc.expensesCount + daily.expensesCount,
      expensesCash: acc.expensesCash.add(daily.expensesCash),
      expensesBank: acc.expensesBank.add(daily.expensesBank),
      expensesBankNile: acc.expensesBankNile.add(daily.expensesBankNile),
      expensesDebtMethod: acc.expensesDebtMethod.add(daily.expensesDebtMethod),
      expensesOthers: acc.expensesOthers.add(daily.expensesOthers),
      incomeTotal: acc.incomeTotal.add(daily.incomeTotal),
      incomeCount: acc.incomeCount + daily.incomeCount,
      incomeCash: acc.incomeCash.add(daily.incomeCash),
      incomeBank: acc.incomeBank.add(daily.incomeBank),
      incomeBankNile: acc.incomeBankNile.add(daily.incomeBankNile),
      incomeDebtMethod: acc.incomeDebtMethod.add(daily.incomeDebtMethod),
      incomeOthers: acc.incomeOthers.add(daily.incomeOthers),
      salariesTotal: acc.salariesTotal.add(daily.salariesTotal),
      salariesCount: acc.salariesCount + daily.salariesCount,
      salariesCash: acc.salariesCash.add(daily.salariesCash),
      salariesBank: acc.salariesBank.add(daily.salariesBank),
      salariesBankNile: acc.salariesBankNile.add(daily.salariesBankNile),
      salariesDebtMethod: acc.salariesDebtMethod.add(daily.salariesDebtMethod),
      salariesOthers: acc.salariesOthers.add(daily.salariesOthers),
      advancesTotal: acc.advancesTotal.add(daily.advancesTotal),
      advancesCount: acc.advancesCount + daily.advancesCount,
      advancesCash: acc.advancesCash.add(daily.advancesCash),
      advancesBank: acc.advancesBank.add(daily.advancesBank),
      advancesBankNile: acc.advancesBankNile.add(daily.advancesBankNile),
      advancesDebtMethod: acc.advancesDebtMethod.add(daily.advancesDebtMethod),
      advancesOthers: acc.advancesOthers.add(daily.advancesOthers),
      cashExchangesCash: acc.cashExchangesCash.add(daily.cashExchangesCash),
      cashExchangesBank: acc.cashExchangesBank.add(daily.cashExchangesBank),
      cashExchangesBankNile: acc.cashExchangesBankNile.add(daily.cashExchangesBankNile),
      cashExchangesDebtMethod: acc.cashExchangesDebtMethod.add(daily.cashExchangesDebtMethod),
      cashExchangesOthers: acc.cashExchangesOthers.add(daily.cashExchangesOthers),
      treasuryInflow: acc.treasuryInflow.add(daily.treasuryInflow),
      treasuryOutflow: acc.treasuryOutflow.add(daily.treasuryOutflow),
      customerPaymentsTotal: acc.customerPaymentsTotal.add(daily.customerPaymentsTotal),
      customerPaymentsCount: acc.customerPaymentsCount + daily.customerPaymentsCount,
      salesReturnsTotal: acc.salesReturnsTotal.add(daily.salesReturnsTotal),
      salesReturnsCount: acc.salesReturnsCount + daily.salesReturnsCount,
    }), {
      salesTotal: new Prisma.Decimal(0),
      salesReceived: new Prisma.Decimal(0),
      salesDebt: new Prisma.Decimal(0),
      salesCount: 0,
      salesCash: new Prisma.Decimal(0),
      salesBank: new Prisma.Decimal(0),
      salesBankNile: new Prisma.Decimal(0),
      salesDebtMethod: new Prisma.Decimal(0),
      salesOthers: new Prisma.Decimal(0),
      procurementTotal: new Prisma.Decimal(0),
      procurementPaid: new Prisma.Decimal(0),
      procurementDebt: new Prisma.Decimal(0),
      procurementCount: 0,
      procurementCancelled: new Prisma.Decimal(0),
      procurementCash: new Prisma.Decimal(0),
      procurementBank: new Prisma.Decimal(0),
      procurementBankNile: new Prisma.Decimal(0),
      procurementDebtMethod: new Prisma.Decimal(0),
      procurementOthers: new Prisma.Decimal(0),
      expensesTotal: new Prisma.Decimal(0),
      expensesCount: 0,
      expensesCash: new Prisma.Decimal(0),
      expensesBank: new Prisma.Decimal(0),
      expensesBankNile: new Prisma.Decimal(0),
      expensesDebtMethod: new Prisma.Decimal(0),
      expensesOthers: new Prisma.Decimal(0),
      incomeTotal: new Prisma.Decimal(0),
      incomeCount: 0,
      incomeCash: new Prisma.Decimal(0),
      incomeBank: new Prisma.Decimal(0),
      incomeBankNile: new Prisma.Decimal(0),
      incomeDebtMethod: new Prisma.Decimal(0),
      incomeOthers: new Prisma.Decimal(0),
      salariesTotal: new Prisma.Decimal(0),
      salariesCount: 0,
      salariesCash: new Prisma.Decimal(0),
      salariesBank: new Prisma.Decimal(0),
      salariesBankNile: new Prisma.Decimal(0),
      salariesDebtMethod: new Prisma.Decimal(0),
      salariesOthers: new Prisma.Decimal(0),
      advancesTotal: new Prisma.Decimal(0),
      advancesCount: 0,
      advancesCash: new Prisma.Decimal(0),
      advancesBank: new Prisma.Decimal(0),
      advancesBankNile: new Prisma.Decimal(0),
      advancesDebtMethod: new Prisma.Decimal(0),
      advancesOthers: new Prisma.Decimal(0),
      cashExchangesCash: new Prisma.Decimal(0),
      cashExchangesBank: new Prisma.Decimal(0),
      cashExchangesBankNile: new Prisma.Decimal(0),
      cashExchangesDebtMethod: new Prisma.Decimal(0),
      cashExchangesOthers: new Prisma.Decimal(0),
      treasuryInflow: new Prisma.Decimal(0),
      treasuryOutflow: new Prisma.Decimal(0),
      customerPaymentsTotal: new Prisma.Decimal(0),
      customerPaymentsCount: 0,
      salesReturnsTotal: new Prisma.Decimal(0),
      salesReturnsCount: 0,
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
      .filter(b => (b as any).paymentMethod === 'BANKAK')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));
    const openingBankNile = openingBalances
      .filter(b => (b as any).paymentMethod === 'BANK_NILE')
      .reduce((sum, b) => sum.add(b.amount), new Prisma.Decimal(0));

    const netCash = openingCash
      .add(monthlyTotals.salesCash)
      .add(monthlyTotals.incomeCash)
      .sub(monthlyTotals.procurementCash)
      .sub(monthlyTotals.expensesCash)
      .sub(monthlyTotals.salariesCash)
      .sub(monthlyTotals.advancesCash)
      .add(monthlyTotals.cashExchangesCash);

    const netBank = openingBank
      .add(monthlyTotals.salesBank)
      .add(monthlyTotals.incomeBank)
      .sub(monthlyTotals.procurementBank)
      .sub(monthlyTotals.expensesBank)
      .sub(monthlyTotals.salariesBank)
      .sub(monthlyTotals.advancesBank)
      .add(monthlyTotals.cashExchangesBank);

    const netBankNile = openingBankNile
      .add(monthlyTotals.salesBankNile)
      .add(monthlyTotals.incomeBankNile)
      .sub(monthlyTotals.procurementBankNile)
      .sub(monthlyTotals.expensesBankNile)
      .sub(monthlyTotals.salariesBankNile)
      .sub(monthlyTotals.advancesBankNile)
      .add(monthlyTotals.cashExchangesBankNile);

    const netDebt = monthlyTotals.salesDebtMethod
      .add(monthlyTotals.incomeDebtMethod)
      .sub(monthlyTotals.procurementDebtMethod)
      .sub(monthlyTotals.expensesDebtMethod)
      .sub(monthlyTotals.salariesDebtMethod)
      .sub(monthlyTotals.advancesDebtMethod)
      .add(monthlyTotals.cashExchangesDebtMethod);

    const netOthers = monthlyTotals.salesOthers
      .add(monthlyTotals.incomeOthers)
      .sub(monthlyTotals.procurementOthers)
      .sub(monthlyTotals.expensesOthers)
      .sub(monthlyTotals.salariesOthers)
      .sub(monthlyTotals.advancesOthers)
      .add(monthlyTotals.cashExchangesOthers);

    const monthlyUpsertWhereClause: any = {
      year,
      month,
      inventoryId: (inventoryId ?? null) as any,
      section: (section ?? null) as any,
    };
    await prisma.monthlyFinancialAggregate.upsert({
      where: {
        year_month_inventoryId_section: monthlyUpsertWhereClause,
      },
      update: {
        ...monthlyTotals,
        netCash,
        netBank,
        netBankNile,
        netDebt,
        netOthers,
        netTotal: netCash.add(netBank).add(netBankNile).add(netDebt).add(netOthers),
      },   

      create: {
        year,
        month,
        ...(inventoryId !== undefined && inventoryId !== null ? { inventoryId } : {}),
        ...(section !== undefined && section !== null ? { section } : {}),
        ...monthlyTotals,
        netCash,
        netBank,
        netBankNile,
        netDebt,
        netOthers,
        netTotal: netCash.add(netBank).add(netBankNile).add(netDebt).add(netOthers),
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

    const itemSalesWhereClause: any = {
      date: dateOnly,
      inventoryId: (inventoryId ?? null) as any,
      itemId,
      section: (section ?? null) as any,
    };
    const existing = await prisma.dailyItemSalesAggregate.findUnique({
      where: {
        date_inventoryId_itemId_section: itemSalesWhereClause,
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

    const itemSalesUpsertWhereClause: any = {
      date: dateOnly,
      inventoryId: (inventoryId ?? null) as any,
      itemId,
      section: (section ?? null) as any,
    };
    await prisma.dailyItemSalesAggregate.upsert({
      where: {
        date_inventoryId_itemId_section: itemSalesUpsertWhereClause,
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
        ...(inventoryId !== undefined && inventoryId !== null ? { inventoryId } : {}),
        itemId,
        ...(section !== undefined && section !== null ? { section } : {}),
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

    const balanceSnapshotWhereClause: any = {
      date: dateOnly,
      inventoryId: (inventoryId ?? null) as any,
      section: (section ?? null) as any,
    };
    await prisma.cumulativeBalanceSnapshot.upsert({
      where: {
        date_inventoryId_section: balanceSnapshotWhereClause,
      },
      update: updates,
      create: {
        date: dateOnly,
        ...(inventoryId !== undefined && inventoryId !== null ? { inventoryId } : {}),
        ...(section !== undefined && section !== null ? { section } : {}),
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

    // Get all transactions - exclude rejected invoices
    const invoices = await prisma.salesInvoice.findMany({ 
      where: {
        ...where,
        paymentConfirmationStatus: { not: 'REJECTED' },
      }
    });
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
    const incomes = await prisma.income.findMany({ where });
    const customerPayments: any[] = await (prisma as any).customerPayment.findMany({
      where: {
        createdAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      },
    });
    const treasuryTransactions: any[] = await (prisma as any).treasuryTransaction.findMany({
      where: {
        createdAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      },
    });
    const bankakTransactions: any[] = await (prisma as any).bankakTransaction.findMany({
      where: {
        createdAt: {
          gte: dateOnly,
          lte: dateEnd,
        },
      },
    });
    const salesReturns: any[] = await (prisma as any).salesReturn.findMany({
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
      BANKAK: invoices.filter(inv => (inv.paymentMethod as string) === 'BANKAK').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
      BANK_NILE: invoices.filter(inv => inv.paymentMethod === 'BANK_NILE').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
      DEBT: invoices.filter(inv => (inv.paymentMethod as string) === 'DEBT').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
      OTHERS: invoices.filter(inv => (inv.paymentMethod as string) === 'OTHERS').reduce((sum, inv) => sum.add(inv.total), new Prisma.Decimal(0)),
    };

    const procurementTotal = orders
      .filter(o => o.status !== 'CANCELLED')
      .reduce((sum, o) => sum.add(o.total), new Prisma.Decimal(0));
    const procurementPaid = orders.reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0));
    const procurementCancelled = orders
      .filter(o => o.status === 'CANCELLED')
      .reduce((sum, o) => sum.add(o.total), new Prisma.Decimal(0));
    const procurementByMethod = {
      CASH: orders.filter(o => (o as any).paymentMethod === 'CASH').reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0)),
      BANKAK: orders.filter(o => (o as any).paymentMethod === 'BANKAK').reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0)),
      BANK_NILE: orders.filter(o => (o as any).paymentMethod === 'BANK_NILE').reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0)),
      DEBT: orders.filter(o => (o as any).paymentMethod === 'DEBT').reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0)),
      OTHERS: orders.filter(o => (o as any).paymentMethod === 'OTHERS').reduce((sum, o) => sum.add(o.paidAmount), new Prisma.Decimal(0)),
    };

    const expensesTotal = expenses.reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0));
    const expensesByMethod = {
      CASH: expenses.filter(e => e.method === 'CASH').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
      BANKAK: expenses.filter(e => (e.method as string) === 'BANKAK').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
      BANK_NILE: expenses.filter(e => e.method === 'BANK_NILE').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
      DEBT: expenses.filter(e => (e.method as string) === 'DEBT').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
      OTHERS: expenses.filter(e => (e.method as string) === 'OTHERS').reduce((sum, e) => sum.add(e.amount), new Prisma.Decimal(0)),
    };

    const salariesTotal = salaries.reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0));
    const salariesByMethod = {
      CASH: salaries.filter(s => s.paymentMethod === 'CASH').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANKAK: salaries.filter(s => (s.paymentMethod as string) === 'BANKAK').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      BANK_NILE: salaries.filter(s => s.paymentMethod === 'BANK_NILE').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      DEBT: salaries.filter(s => (s.paymentMethod as string) === 'DEBT').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
      OTHERS: salaries.filter(s => (s.paymentMethod as string) === 'OTHERS').reduce((sum, s) => sum.add(s.amount), new Prisma.Decimal(0)),
    };

    const advancesTotal = advances.reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0));
    const advancesByMethod = {
      CASH: advances.filter(a => a.paymentMethod === 'CASH').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANKAK: advances.filter(a => (a.paymentMethod as string) === 'BANKAK').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      BANK_NILE: advances.filter(a => a.paymentMethod === 'BANK_NILE').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      DEBT: advances.filter(a => (a.paymentMethod as string) === 'DEBT').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
      OTHERS: advances.filter(a => (a.paymentMethod as string) === 'OTHERS').reduce((sum, a) => sum.add(a.amount), new Prisma.Decimal(0)),
    };

    // Income calculations
    const incomeTotalAmount = incomes.reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0));
    const incomeByMethod = {
      CASH: incomes.filter(i => (i as any).method === 'CASH').reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0)),
      BANKAK: incomes.filter(i => (i as any).method === 'BANKAK').reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0)),
      BANK_NILE: incomes.filter(i => (i as any).method === 'BANK_NILE').reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0)),
      DEBT: incomes.filter(i => (i as any).method === 'DEBT').reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0)),
      OTHERS: incomes.filter(i => (i as any).method === 'OTHERS').reduce((sum, i) => sum.add(i.amount), new Prisma.Decimal(0)),
    };

    // Customer payments calculations
    const customerPaymentsTotalAmount = customerPayments.reduce((sum, cp) => sum.add(cp.amount), new Prisma.Decimal(0));

    // Treasury transactions calculations
    const treasuryInflowAmount = treasuryTransactions
      .filter(t => (t as any).type === 'INFLOW')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));
    const treasuryOutflowAmount = treasuryTransactions
      .filter(t => (t as any).type === 'OUTFLOW')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    // Sales returns calculations
    const salesReturnsTotalAmount = salesReturns.reduce((sum, sr) => sum.add(sr.amount), new Prisma.Decimal(0));

    // Update aggregate - use absolute values instead of increments for recalculation
    // First, get existing aggregate to clear it
    // Handle null values explicitly for Prisma unique constraint
    const whereClause: any = {
      date: dateOnly,
      inventoryId: inventoryId ?? null,
      section: section ?? null,
    };
    
    const existing = await prisma.dailyFinancialAggregate.findUnique({
      where: {
        date_inventoryId_section: whereClause,
      },
    });

    // Delete existing aggregate if it exists to avoid double-counting
    if (existing) {
      await prisma.dailyFinancialAggregate.delete({
        where: {
          date_inventoryId_section: whereClause,
        },
      });
    }

    // Create new aggregate with absolute values
    await this.updateDailyFinancialAggregate(date, {
      salesTotal,
      salesReceived,
      salesDebt,
      salesCount: invoices.length,
      salesCash: salesByMethod.CASH,
      salesBank: salesByMethod.BANKAK,
      salesBankNile: salesByMethod.BANK_NILE,
      salesDebtMethod: salesByMethod.DEBT,
      salesOthers: salesByMethod.OTHERS,
      procurementTotal,
      procurementPaid,
      procurementDebt: procurementTotal.sub(procurementPaid),
      procurementCount: orders.filter(o => o.status !== 'CANCELLED').length,
      procurementCancelled,
      procurementCash: procurementByMethod.CASH,
      procurementBank: procurementByMethod.BANKAK,
      procurementBankNile: procurementByMethod.BANK_NILE,
      procurementDebtMethod: procurementByMethod.DEBT,
      procurementOthers: procurementByMethod.OTHERS,
      expensesTotal,
      expensesCount: expenses.length,
      expensesCash: expensesByMethod.CASH,
      expensesBank: expensesByMethod.BANKAK,
      expensesBankNile: expensesByMethod.BANK_NILE,
      expensesDebtMethod: expensesByMethod.DEBT,
      expensesOthers: expensesByMethod.OTHERS,
      incomeTotal: incomeTotalAmount,
      incomeCount: incomes.length,
      incomeCash: incomeByMethod.CASH,
      incomeBank: incomeByMethod.BANKAK,
      incomeBankNile: incomeByMethod.BANK_NILE,
      incomeDebtMethod: incomeByMethod.DEBT,
      incomeOthers: incomeByMethod.OTHERS,
      salariesTotal,
      salariesCount: salaries.length,
      salariesCash: salariesByMethod.CASH,
      salariesBank: salariesByMethod.BANKAK,
      salariesBankNile: salariesByMethod.BANK_NILE,
      salariesDebtMethod: salariesByMethod.DEBT,
      salariesOthers: salariesByMethod.OTHERS,
      advancesTotal,
      advancesCount: advances.length,
      advancesCash: advancesByMethod.CASH,
      advancesBank: advancesByMethod.BANKAK,
      advancesBankNile: advancesByMethod.BANK_NILE,
      advancesDebtMethod: advancesByMethod.DEBT,
      advancesOthers: advancesByMethod.OTHERS,
      treasuryInflow: treasuryInflowAmount,
      treasuryOutflow: treasuryOutflowAmount,
      customerPaymentsTotal: customerPaymentsTotalAmount,
      customerPaymentsCount: customerPayments.length,
      salesReturnsTotal: salesReturnsTotalAmount,
      salesReturnsCount: salesReturns.length,
    }, inventoryId, section);
  }
}

export const aggregationService = new AggregationService();

