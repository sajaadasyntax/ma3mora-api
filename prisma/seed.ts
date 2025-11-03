import { PrismaClient, Role, Section, CustomerType, PaymentMethod, PaymentStatus, DeliveryStatus, ProcOrderStatus, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { aggregationService } from '../src/services/aggregationService';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  // Clear existing data (except aggregates which will be recalculated)
  console.log('Clearing existing data...');
  await prisma.auditLog.deleteMany();
  await prisma.inventoryDeliveryBatch.deleteMany();
  await prisma.inventoryDeliveryItem.deleteMany();
  await prisma.inventoryDelivery.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.stockBatch.deleteMany();
  await prisma.inventoryTransfer.deleteMany();
  await prisma.salesPayment.deleteMany();
  await prisma.salesInvoiceItem.deleteMany();
  await prisma.salesInvoice.deleteMany();
  await prisma.procOrderPayment.deleteMany();
  await prisma.procOrderReturn.deleteMany();
  await prisma.procOrderItem.deleteMany();
  await prisma.inventoryReceipt.deleteMany();
  await prisma.procOrder.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.salary.deleteMany();
  await prisma.advance.deleteMany();
  await prisma.cashExchange.deleteMany();
  await prisma.openingBalance.deleteMany();
  await prisma.inventoryStock.deleteMany();
  await prisma.itemPrice.deleteMany();
  await prisma.item.deleteMany();
  await prisma.customerCumulativeAggregate.deleteMany();
  await prisma.supplierCumulativeAggregate.deleteMany();
  await prisma.dailyItemSalesAggregate.deleteMany();
  await prisma.monthlyFinancialAggregate.deleteMany();
  await prisma.dailyFinancialAggregate.deleteMany();
  await prisma.cumulativeBalanceSnapshot.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.userInventoryAccess.deleteMany();
  await prisma.user.deleteMany();
  await prisma.inventory.deleteMany();

  // Create inventories
  console.log('Creating inventories...');
  const mainInventory = await prisma.inventory.upsert({
    where: { name: 'المخزن الرئيسي' },
    update: {},
    create: { name: 'المخزن الرئيسي', isMain: true },
  });

  const branches = ['الفرعي', 'القرشي', 'الهدى', 'عبود'];
  const branchInventories = await Promise.all(
    branches.map((name) =>
      prisma.inventory.upsert({
        where: { name },
        update: {},
        create: { name, isMain: false },
      })
    )
  );

  console.log(`✅ Created ${1 + branches.length} inventories`);

  // Create users
  console.log('Creating users...');
  const hashedPassword = await bcrypt.hash('password123', 10);

  const accountant = await prisma.user.upsert({
    where: { username: 'accountant' },
    update: {},
    create: {
      username: 'accountant',
      passwordHash: hashedPassword,
      role: Role.ACCOUNTANT,
    },
  });

  const salesGrocery = await prisma.user.upsert({
    where: { username: 'sales_grocery' },
    update: {},
    create: {
      username: 'sales_grocery',
      passwordHash: hashedPassword,
      role: Role.SALES_GROCERY,
      accesses: {
        create: [
          { inventoryId: mainInventory.id, section: Section.GROCERY },
          ...branchInventories.map(inv => ({ inventoryId: inv.id, section: Section.GROCERY })),
        ],
      },
    },
  });

  const salesBakery = await prisma.user.upsert({
    where: { username: 'sales_bakery' },
    update: {},
    create: {
      username: 'sales_bakery',
      passwordHash: hashedPassword,
      role: Role.SALES_BAKERY,
      accesses: {
        create: [
          { inventoryId: mainInventory.id, section: Section.BAKERY },
          ...branchInventories.map(inv => ({ inventoryId: inv.id, section: Section.BAKERY })),
        ],
      },
    },
  });

  const inventoryUser = await prisma.user.upsert({
    where: { username: 'inventory' },
    update: {},
    create: {
      username: 'inventory',
      passwordHash: hashedPassword,
      role: Role.INVENTORY,
    },
  });

  const procurementUser = await prisma.user.upsert({
    where: { username: 'procurement' },
    update: {},
    create: {
      username: 'procurement',
      passwordHash: hashedPassword,
      role: Role.PROCUREMENT,
    },
  });

  const auditor = await prisma.user.upsert({
    where: { username: 'auditor' },
    update: {},
    create: {
      username: 'auditor',
      passwordHash: hashedPassword,
      role: Role.AUDITOR,
    },
  });

  const manager = await prisma.user.upsert({
    where: { username: 'manager' },
    update: {},
    create: {
      username: 'manager',
      passwordHash: hashedPassword,
      role: Role.MANAGER,
    },
  });

  console.log('✅ Created 7 users');

  // Create sample items
  console.log('Creating sample items...');
  const groceryItems = [
    { name: 'سكر', wholesalePrice: 25, retailPrice: 30 },
    { name: 'رز', wholesalePrice: 20, retailPrice: 25 },
    { name: 'زيت', wholesalePrice: 35, retailPrice: 40 },
    { name: 'طحين', wholesalePrice: 15, retailPrice: 20 },
    { name: 'معكرونة', wholesalePrice: 18, retailPrice: 22 },
    { name: 'شاي', wholesalePrice: 28, retailPrice: 35 },
    { name: 'قهوة', wholesalePrice: 45, retailPrice: 55 },
    { name: 'ملح', wholesalePrice: 5, retailPrice: 8 },
  ];

  const bakeryItems = [
    { name: 'خبز طازج', wholesalePrice: 8, retailPrice: 10 },
    { name: 'كعك', wholesalePrice: 12, retailPrice: 15 },
    { name: 'معجنات', wholesalePrice: 15, retailPrice: 20 },
    { name: 'بسكويت', wholesalePrice: 10, retailPrice: 12 },
    { name: 'كرواسون', wholesalePrice: 18, retailPrice: 22 },
  ];

  const createdGroceryItems = await Promise.all(
    groceryItems.map((item) =>
      prisma.item.create({
        data: {
          name: item.name,
          section: Section.GROCERY,
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: item.wholesalePrice },
              { tier: CustomerType.RETAIL, price: item.retailPrice },
            ],
          },
        },
        include: {
          prices: true,
        },
      })
    )
  );

  const createdBakeryItems = await Promise.all(
    bakeryItems.map((item) =>
      prisma.item.create({
        data: {
          name: item.name,
          section: Section.BAKERY,
          prices: {
            create: [
              { tier: CustomerType.WHOLESALE, price: item.wholesalePrice },
              { tier: CustomerType.RETAIL, price: item.retailPrice },
            ],
          },
        },
        include: {
          prices: true,
        },
      })
    )
  );

  console.log(`✅ Created ${groceryItems.length + bakeryItems.length} items with prices`);

  // Create initial stock with fixed values
  console.log('Creating initial stock...');
  const allInventories = [mainInventory, ...branchInventories];
  const allItems = [...createdGroceryItems, ...createdBakeryItems];

  // Fixed stock quantities per item (predictable values)
  const stockQuantities: Record<string, number> = {
    'سكر': 500,
    'رز': 500,
    'زيت': 400,
    'طحين': 600,
    'معكرونة': 300,
    'شاي': 350,
    'قهوة': 250,
    'ملح': 800,
    'خبز طازج': 200,
    'كعك': 150,
    'معجنات': 180,
    'بسكويت': 300,
    'كرواسون': 120,
  };

  for (const inventory of allInventories) {
    for (const item of allItems) {
      await prisma.inventoryStock.create({
        data: {
          inventoryId: inventory.id,
          itemId: item.id,
          quantity: stockQuantities[item.name] || 200, // Use fixed quantity or default to 200
        },
      });
    }
  }

  console.log('✅ Created initial stock');

  // Create opening balance
  console.log('Creating opening balance...');
  await prisma.openingBalance.create({
    data: {
      scope: 'CASHBOX',
      amount: 1000000,
      paymentMethod: PaymentMethod.CASH,
    },
  });
  await prisma.openingBalance.create({
    data: {
      scope: 'CASHBOX',
      amount: 500000,
      paymentMethod: PaymentMethod.BANK,
    },
  });
  await prisma.openingBalance.create({
    data: {
      scope: 'CASHBOX',
      amount: 300000,
      paymentMethod: PaymentMethod.BANK_NILE,
    },
  });

  console.log('✅ Created opening balances');

  // Create sample customers
  console.log('Creating sample customers...');
  const customers = [
    { name: 'محل الأمانة', type: CustomerType.WHOLESALE, division: Section.GROCERY },
    { name: 'سوبر ماركت النور', type: CustomerType.RETAIL, division: Section.GROCERY },
    { name: 'مخبز الفرح', type: CustomerType.WHOLESALE, division: Section.BAKERY },
    { name: 'مطعم البركة', type: CustomerType.RETAIL, division: Section.BAKERY },
  ];

  const createdCustomers = await Promise.all(
    customers.map((customer) =>
      prisma.customer.create({
        data: customer,
      })
    )
  );

  console.log('✅ Created 4 sample customers');

  // Create sample suppliers
  console.log('Creating sample suppliers...');
  const suppliers = [
    { name: 'مورد الأرز الذهبي', phone: '+964770123456' },
    { name: 'شركة الدقيق الممتاز', phone: '+964771234567' },
  ];

  const createdSuppliers = await Promise.all(
    suppliers.map((supplier) =>
      prisma.supplier.create({
        data: supplier,
      })
    )
  );

  console.log('✅ Created 2 sample suppliers');

  // Create sample employees
  console.log('Creating sample employees...');
  const employees = [
    { name: 'أحمد محمد', position: 'مدير المبيعات', phone: '+964770123456', salary: 500000 },
    { name: 'فاطمة علي', position: 'محاسب', phone: '+964771234567', salary: 400000 },
    { name: 'محمد حسن', position: 'أمين مخزن', phone: '+964772345678', salary: 350000 },
    { name: 'عائشة أحمد', position: 'موظف مبيعات', phone: '+964773456789', salary: 300000 },
  ];

  const createdEmployees = await Promise.all(
    employees.map((employee) =>
      prisma.employee.create({
        data: employee,
      })
    )
  );

  console.log('✅ Created 4 sample employees');

  // Create sample transactions (last 7 days)
  console.log('Creating sample transactions...');
  const today = new Date();
  const daysAgo = (days: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days);
    return date;
  };

  // Create sample invoices
  for (let day = 0; day < 7; day++) {
    const invoiceDate = daysAgo(day);
    invoiceDate.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), 0, 0);

    // Create 2-5 invoices per day
    const invoiceCount = Math.floor(Math.random() * 4) + 2;
    for (let i = 0; i < invoiceCount; i++) {
      const customer = createdCustomers[Math.floor(Math.random() * createdCustomers.length)];
      const section = customer.division;
      const items = section === Section.GROCERY ? createdGroceryItems : createdBakeryItems;
      const selectedItems = items.slice(0, Math.floor(Math.random() * 3) + 2);

      const invoiceItems = selectedItems.map(item => {
        const quantity = Math.floor(Math.random() * 10) + 1;
        const price = item.prices.find(p => p.tier === customer.type)?.price || item.prices[0].price;
        return {
          itemId: item.id,
          quantity: new Prisma.Decimal(quantity),
          giftQty: new Prisma.Decimal(0),
          unitPrice: price,
          lineTotal: price.mul(quantity),
        };
      });

      const subtotal = invoiceItems.reduce((sum, item) => sum.add(item.lineTotal), new Prisma.Decimal(0));
      const discount = new Prisma.Decimal(Math.floor(Math.random() * 5));
      const total = subtotal.sub(discount);
      const paymentMethod = [PaymentMethod.CASH, PaymentMethod.BANK, PaymentMethod.BANK_NILE][Math.floor(Math.random() * 3)];

      const invoice = await prisma.salesInvoice.create({
        data: {
          invoiceNumber: `INV-${String(day * 10 + i + 1).padStart(6, '0')}`,
          inventoryId: mainInventory.id,
          section,
          salesUserId: section === Section.GROCERY ? salesGrocery.id : salesBakery.id,
          customerId: customer.id,
          paymentMethod,
          paymentStatus: Math.random() > 0.3 ? PaymentStatus.PAID : PaymentStatus.CREDIT,
          deliveryStatus: Math.random() > 0.5 ? DeliveryStatus.DELIVERED : DeliveryStatus.NOT_DELIVERED,
          subtotal,
          discount,
          total,
          paidAmount: Math.random() > 0.3 ? total : new Prisma.Decimal(0),
          createdAt: invoiceDate,
          items: {
            create: invoiceItems,
          },
        },
      });

      // Create payment if invoice is paid
      if (invoice.paidAmount.greaterThan(0)) {
        await prisma.salesPayment.create({
          data: {
            invoiceId: invoice.id,
            amount: invoice.paidAmount,
            method: paymentMethod,
            recordedBy: accountant.id,
            paidAt: invoiceDate,
          },
        });
      }

      // Update aggregates
      try {
        await aggregationService.updateDailyFinancialAggregate(
          invoiceDate,
          {
            salesTotal: total,
            salesReceived: invoice.paidAmount,
            salesDebt: total.sub(invoice.paidAmount),
            salesCount: 1,
            salesCash: paymentMethod === PaymentMethod.CASH ? total : new Prisma.Decimal(0),
            salesBank: paymentMethod === PaymentMethod.BANK ? total : new Prisma.Decimal(0),
            salesBankNile: paymentMethod === PaymentMethod.BANK_NILE ? total : new Prisma.Decimal(0),
          },
          mainInventory.id,
          section
        );

        for (const item of invoiceItems) {
          await aggregationService.updateDailyItemSalesAggregate(
            invoiceDate,
            item.itemId,
            {
              quantity: item.quantity,
              giftQty: new Prisma.Decimal(0),
              amount: item.lineTotal,
              invoiceCount: 1,
            },
            mainInventory.id,
            section
          );
        }

        await aggregationService.updateCustomerCumulativeAggregate(
          customer.id,
          invoiceDate,
          {
            totalSales: total,
            totalPaid: invoice.paidAmount,
            invoiceCount: 1,
            salesCash: paymentMethod === PaymentMethod.CASH ? total : new Prisma.Decimal(0),
            salesBank: paymentMethod === PaymentMethod.BANK ? total : new Prisma.Decimal(0),
            salesBankNile: paymentMethod === PaymentMethod.BANK_NILE ? total : new Prisma.Decimal(0),
          }
        );
      } catch (err) {
        console.error('Error updating aggregates:', err);
      }
    }
  }

  console.log('✅ Created sample invoices and payments');

  // Create sample procurement orders
  for (let day = 0; day < 5; day++) {
    const orderDate = daysAgo(day);
    orderDate.setHours(9 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 60), 0, 0);

    const supplier = createdSuppliers[Math.floor(Math.random() * createdSuppliers.length)];
    const section = [Section.GROCERY, Section.BAKERY][Math.floor(Math.random() * 2)];
    const items = section === Section.GROCERY ? createdGroceryItems : createdBakeryItems;
    const selectedItems = items.slice(0, Math.floor(Math.random() * 3) + 2);

    const orderItems = selectedItems.map(item => {
      const quantity = Math.floor(Math.random() * 50) + 10;
      // Use first available price or default to 10 if no prices exist
      const basePrice = item.prices && item.prices.length > 0 
        ? item.prices[0].price 
        : new Prisma.Decimal(10);
      const unitCost = basePrice.mul(0.7); // 70% of retail price
      return {
        itemId: item.id,
        quantity: new Prisma.Decimal(quantity),
        giftQty: new Prisma.Decimal(0),
        unitCost,
        lineTotal: unitCost.mul(quantity),
      };
    });

    const total = orderItems.reduce((sum, item) => sum.add(item.lineTotal), new Prisma.Decimal(0));
    const paidAmount = Math.random() > 0.4 ? total : new Prisma.Decimal(0);

    const order = await prisma.procOrder.create({
      data: {
        orderNumber: `ORD-${String(day + 1).padStart(6, '0')}`,
        inventoryId: mainInventory.id,
        section,
        createdBy: procurementUser.id,
        supplierId: supplier.id,
        status: ProcOrderStatus.RECEIVED,
        total,
        paidAmount,
        paymentConfirmed: paidAmount.greaterThan(0),
        paymentConfirmedBy: paidAmount.greaterThan(0) ? manager.id : undefined,
        paymentConfirmedAt: paidAmount.greaterThan(0) ? orderDate : undefined,
        createdAt: orderDate,
        items: {
          create: orderItems,
        },
      },
    });

    if (paidAmount.greaterThan(0)) {
      await prisma.procOrderPayment.create({
        data: {
          orderId: order.id,
          amount: paidAmount,
          method: PaymentMethod.CASH,
          recordedBy: accountant.id,
          paidAt: orderDate,
        },
      });
    }

    // Update aggregates
    try {
      await aggregationService.updateDailyFinancialAggregate(
        orderDate,
        {
          procurementTotal: total,
          procurementPaid: paidAmount,
          procurementDebt: total.sub(paidAmount),
          procurementCount: 1,
          procurementCash: paidAmount.greaterThan(0) ? paidAmount : new Prisma.Decimal(0),
        },
        mainInventory.id,
        section
      );

      await aggregationService.updateSupplierCumulativeAggregate(
        supplier.id,
        orderDate,
        {
          totalPurchases: total,
          totalPaid: paidAmount,
          orderCount: 1,
          purchasesCash: paidAmount.greaterThan(0) ? paidAmount : new Prisma.Decimal(0),
        }
      );
    } catch (err) {
      console.error('Error updating aggregates:', err);
    }
  }

  console.log('✅ Created sample procurement orders');

  // Create sample expenses
  for (let day = 0; day < 7; day++) {
    const expenseDate = daysAgo(day);
    expenseDate.setHours(14 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 60), 0, 0);

    const expenseCount = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < expenseCount; i++) {
      const amount = new Prisma.Decimal(Math.floor(Math.random() * 50000) + 10000);
      const method = [PaymentMethod.CASH, PaymentMethod.BANK][Math.floor(Math.random() * 2)];

      const expense = await prisma.expense.create({
        data: {
          inventoryId: mainInventory.id,
          section: [Section.GROCERY, Section.BAKERY][Math.floor(Math.random() * 2)],
          amount,
          method,
          description: `مصروفات يومية ${day + 1}`,
          createdBy: accountant.id,
          createdAt: expenseDate,
        },
      });

      try {
        await aggregationService.updateDailyFinancialAggregate(
          expenseDate,
          {
            expensesTotal: amount,
            expensesCount: 1,
            expensesCash: method === PaymentMethod.CASH ? amount : new Prisma.Decimal(0),
            expensesBank: method === PaymentMethod.BANK ? amount : new Prisma.Decimal(0),
          },
          mainInventory.id,
          expense.section || undefined
        );
      } catch (err) {
        console.error('Error updating aggregates:', err);
      }
    }
  }

  console.log('✅ Created sample expenses');

  console.log('🎉 Seed completed successfully!');
  console.log('\n📝 Login credentials:');
  console.log('  Accountant: accountant / password123');
  console.log('  Sales (Grocery): sales_grocery / password123');
  console.log('  Sales (Bakery): sales_bakery / password123');
  console.log('  Inventory: inventory / password123');
  console.log('  Procurement: procurement / password123');
  console.log('  Auditor: auditor / password123');
  console.log('  Manager: manager / password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
