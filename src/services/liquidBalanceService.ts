/**
 * Shared helper: compute available liquid balance per payment method.
 * Used by accounting (expenses, cash-exchanges) and procurement (order payments).
 * Single source of truth so all routes enforce the same balance check.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

type Method = 'CASH' | 'BANKAK' | 'BANK_NILE';

function zero(): Record<Method, Prisma.Decimal> {
  return { CASH: new Prisma.Decimal(0), BANKAK: new Prisma.Decimal(0), BANK_NILE: new Prisma.Decimal(0) };
}

function netSalary(s: { netAmount: Prisma.Decimal; amount: Prisma.Decimal }): Prisma.Decimal {
  return s.netAmount.greaterThan(0) ? s.netAmount : s.amount;
}

export async function getAvailableByMethod(): Promise<Record<Method, Prisma.Decimal>> {
  // ── 1. Opening balances (CASHBOX scope, open only) ───────────────────────
  const openingBalances = await prisma.openingBalance.findMany({
    where: { scope: 'CASHBOX', isClosed: false },
  });
  const opening = zero();
  for (const b of openingBalances) {
    const m = (b as any).paymentMethod as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      opening[m as Method] = opening[m as Method].add(b.amount);
  }

  // ── 2. Sales payments in (confirmed invoices only) ───────────────────────
  const salesPays = await prisma.salesPayment.findMany({
    where: { invoice: { paymentConfirmationStatus: 'CONFIRMED' } },
  });
  const salesIn = zero();
  for (const p of salesPays) {
    const m = p.method as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      salesIn[m as Method] = salesIn[m as Method].add(p.amount);
  }

  // ── 3. Expenses out (exclude debts) ──────────────────────────────────────
  const expenses = await prisma.expense.findMany();
  const expOut = zero();
  for (const e of expenses) {
    if (e.isDebt) continue;
    const m = e.method as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      expOut[m as Method] = expOut[m as Method].add(e.amount);
  }

  // ── 4. Income in (exclude debts) ─────────────────────────────────────────
  const income = await prisma.income.findMany();
  const incomeIn = zero();
  for (const i of income) {
    if (i.isDebt) continue;
    const m = i.method as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      incomeIn[m as Method] = incomeIn[m as Method].add(i.amount);
  }

  // ── 5. Salaries out (paid only) ──────────────────────────────────────────
  const paidSalaries = await prisma.salary.findMany({ where: { paidAt: { not: null } } });
  const salOut = zero();
  for (const s of paidSalaries) {
    const m = (s as any).paymentMethod as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      salOut[m as Method] = salOut[m as Method].add(netSalary(s as any));
  }

  // ── 6. Advances out (paid only) ──────────────────────────────────────────
  const paidAdvances = await prisma.advance.findMany({ where: { paidAt: { not: null } } });
  const advOut = zero();
  for (const a of paidAdvances) {
    const m = (a as any).paymentMethod as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      advOut[m as Method] = advOut[m as Method].add(a.amount);
  }

  // ── 7. Procurement payments out (confirmed orders, not cancelled) ─────────
  const procPays = await prisma.procOrderPayment.findMany({
    where: { order: { paymentConfirmed: true, status: { not: 'CANCELLED' } } },
  });
  const procOut = zero();
  for (const p of procPays) {
    const m = p.method as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      procOut[m as Method] = procOut[m as Method].add(p.amount);
  }

  // ── 8. Cash exchanges (move money between methods) ────────────────────────
  const exchanges = await (prisma as any).cashExchange.findMany();
  const exImpact = zero();
  for (const e of exchanges) {
    const fromM = e.fromMethod as string;
    const toM = e.toMethod as string;
    if (fromM === 'CASH' || fromM === 'BANKAK' || fromM === 'BANK_NILE')
      exImpact[fromM as Method] = exImpact[fromM as Method].sub(e.amount);
    if (toM === 'CASH' || toM === 'BANKAK' || toM === 'BANK_NILE')
      exImpact[toM as Method] = exImpact[toM as Method].add(e.amount);
  }

  // ── 9. Customer direct payments in ───────────────────────────────────────
  const custPays = await prisma.customerPayment.findMany();
  const custPayIn = zero();
  for (const p of custPays) {
    const m = p.method as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      custPayIn[m as Method] = custPayIn[m as Method].add(p.amount);
  }

  // ── 10. Sales deposits in ────────────────────────────────────────────────
  const salesDeps = await (prisma as any).salesDeposit.findMany();
  const depIn = zero();
  for (const d of salesDeps) {
    const m = d.method as string;
    if (m === 'CASH' || m === 'BANKAK' || m === 'BANK_NILE')
      depIn[m as Method] = depIn[m as Method].add(d.amount);
  }

  // ── 11. Treasury transactions (CASH_IN / CASH_OUT) ───────────────────────
  // Includes opening-balance mirrors for CUSTOMER/SUPPLIER scope.
  const treasuryTxns = await prisma.treasuryTransaction.findMany();
  const trImpact = zero();
  for (const t of treasuryTxns) {
    const m = t.method as string;
    if (m !== 'CASH' && m !== 'BANKAK' && m !== 'BANK_NILE') continue;
    if (t.type === 'CASH_IN') trImpact[m as Method] = trImpact[m as Method].add(t.amount);
    else if (t.type === 'CASH_OUT') trImpact[m as Method] = trImpact[m as Method].sub(t.amount);
  }

  return {
    CASH: opening.CASH
      .add(salesIn.CASH).add(incomeIn.CASH).add(custPayIn.CASH).add(depIn.CASH)
      .add(exImpact.CASH).add(trImpact.CASH)
      .sub(expOut.CASH).sub(salOut.CASH).sub(advOut.CASH).sub(procOut.CASH),
    BANKAK: opening.BANKAK
      .add(salesIn.BANKAK).add(incomeIn.BANKAK).add(custPayIn.BANKAK).add(depIn.BANKAK)
      .add(exImpact.BANKAK).add(trImpact.BANKAK)
      .sub(expOut.BANKAK).sub(salOut.BANKAK).sub(advOut.BANKAK).sub(procOut.BANKAK),
    BANK_NILE: opening.BANK_NILE
      .add(salesIn.BANK_NILE).add(incomeIn.BANK_NILE).add(custPayIn.BANK_NILE).add(depIn.BANK_NILE)
      .add(exImpact.BANK_NILE).add(trImpact.BANK_NILE)
      .sub(expOut.BANK_NILE).sub(salOut.BANK_NILE).sub(advOut.BANK_NILE).sub(procOut.BANK_NILE),
  };
}
