import { Prisma, JournalEntryType, TransactionDirection, PaymentMethod, JournalEntry } from '@prisma/client';
import { prisma } from '../lib/prisma';

export class JournalService {
  /**
   * إنشاء قيد يومية تلقائي
   * Auto-generate a journal entry for any financial transaction
   */
  async createJournalEntry(params: {
    date: Date;
    entryType: JournalEntryType;
    referenceId: string;
    referenceType: string;
    direction: TransactionDirection;
    amount: number | Prisma.Decimal;
    method?: PaymentMethod;
    description: string;
    createdBy: string;
  }): Promise<JournalEntry> {
    const dateOnly = new Date(params.date);
    dateOnly.setHours(0, 0, 0, 0);

    const entry = await prisma.journalEntry.create({
      data: {
        date: dateOnly,
        entryType: params.entryType,
        referenceId: params.referenceId,
        referenceType: params.referenceType,
        direction: params.direction,
        amount: new Prisma.Decimal(params.amount.toString()),
        method: params.method ?? null,
        description: params.description,
        createdBy: params.createdBy,
      },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
            role: true,
          },
        },
      },
    });

    return entry;
  }

  /**
   * جلب قيود يومية ليوم محدد
   * Returns all journal entries for a given date, ordered by createdAt
   */
  async getDailyJournal(date: Date): Promise<JournalEntry[]> {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    return await prisma.journalEntry.findMany({
      where: {
        date: dateOnly,
      },
      orderBy: {
        createdAt: 'asc',
      },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
            role: true,
          },
        },
      },
    });
  }
}

export const journalService = new JournalService();
