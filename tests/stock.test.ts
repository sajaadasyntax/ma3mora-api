import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

describe('Stock Management Tests', () => {
  let testInventoryId: string;
  let testItemId: string;

  beforeAll(async () => {
    // Create test inventory
    const inventory = await prisma.inventory.create({
      data: { name: 'Test Inventory', isMain: false },
    });
    testInventoryId = inventory.id;

    // Create test item
    const item = await prisma.item.create({
      data: {
        name: 'Test Item',
        section: 'GROCERY',
        prices: {
          create: [
            { tier: 'WHOLESALE', price: 100 },
            { tier: 'RETAIL', price: 120 },
          ],
        },
        stocks: {
          create: {
            inventoryId: testInventoryId,
            quantity: 1000,
          },
        },
      },
    });
    testItemId = item.id;
  });

  afterAll(async () => {
    // Cleanup
    await prisma.inventoryStock.deleteMany({
      where: { inventoryId: testInventoryId },
    });
    await prisma.item.deleteMany({
      where: { id: testItemId },
    });
    await prisma.inventory.deleteMany({
      where: { id: testInventoryId },
    });
    await prisma.$disconnect();
  });

  test('should initialize stock correctly', async () => {
    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
    });

    expect(stock).toBeTruthy();
    expect(stock!.quantity).toEqual(new Prisma.Decimal(1000));
  });

  test('should decrease stock correctly', async () => {
    const decrementAmount = 100;

    await prisma.inventoryStock.update({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
      data: {
        quantity: {
          decrement: decrementAmount,
        },
      },
    });

    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
    });

    expect(stock!.quantity).toEqual(new Prisma.Decimal(900));
  });

  test('should increase stock correctly', async () => {
    const incrementAmount = 200;

    await prisma.inventoryStock.update({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
      data: {
        quantity: {
          increment: incrementAmount,
        },
      },
    });

    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
    });

    expect(stock!.quantity).toEqual(new Prisma.Decimal(1100));
  });

  test('should handle decimal quantities', async () => {
    await prisma.inventoryStock.update({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
      data: {
        quantity: 50.5,
      },
    });

    const stock = await prisma.inventoryStock.findUnique({
      where: {
        inventoryId_itemId: {
          inventoryId: testInventoryId,
          itemId: testItemId,
        },
      },
    });

    expect(stock!.quantity).toEqual(new Prisma.Decimal(50.5));
  });
});

describe('Payment Calculations Tests', () => {
  test('should calculate subtotal correctly', () => {
    const items = [
      { quantity: 10, unitPrice: new Prisma.Decimal(100) },
      { quantity: 5, unitPrice: new Prisma.Decimal(200) },
      { quantity: 2, unitPrice: new Prisma.Decimal(50) },
    ];

    const subtotal = items.reduce(
      (sum, item) => sum.add(new Prisma.Decimal(item.quantity).mul(item.unitPrice)),
      new Prisma.Decimal(0)
    );

    // 10*100 + 5*200 + 2*50 = 1000 + 1000 + 100 = 2100
    expect(subtotal).toEqual(new Prisma.Decimal(2100));
  });

  test('should apply discount correctly', () => {
    const subtotal = new Prisma.Decimal(2100);
    const discount = new Prisma.Decimal(100);
    const total = subtotal.sub(discount);

    expect(total).toEqual(new Prisma.Decimal(2000));
  });

  test('should calculate partial payment correctly', () => {
    const total = new Prisma.Decimal(2000);
    const payment1 = new Prisma.Decimal(500);
    const payment2 = new Prisma.Decimal(700);
    
    const paidAmount = payment1.add(payment2);
    const remaining = total.sub(paidAmount);

    expect(paidAmount).toEqual(new Prisma.Decimal(1200));
    expect(remaining).toEqual(new Prisma.Decimal(800));
  });

  test('should determine payment status', () => {
    const total = new Prisma.Decimal(2000);
    
    // Paid
    const paid = new Prisma.Decimal(2000);
    expect(paid.equals(total)).toBe(true);
    
    // Partial
    const partial = new Prisma.Decimal(1000);
    expect(partial.greaterThan(0) && partial.lessThan(total)).toBe(true);
    
    // Credit
    const credit = new Prisma.Decimal(0);
    expect(credit.equals(0)).toBe(true);
  });
});

