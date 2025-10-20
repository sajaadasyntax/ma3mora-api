# Ma3mora API - Backend

This is the backend API for the Ma3mora Inventory Management System.

## Tech Stack

- **Node.js** with **Express**
- **TypeScript**
- **Prisma** ORM with PostgreSQL
- **JWT** Authentication
- **Zod** for validation

## Prerequisites

- Node.js 18+ or 20+
- PostgreSQL database
- npm, yarn, or pnpm

## Independent Setup & Installation

### 1. Navigate to the API directory
```bash
cd apps/api
```

### 2. Install dependencies
```bash
npm install
# or
pnpm install
# or
yarn install
```

### 3. Environment Setup

Create a `.env` file in the `apps/api` directory:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/ma3mora?schema=public"

# JWT Secret
JWT_SECRET="your-secret-key-change-in-production"

# Server
PORT=4000
NODE_ENV=development

# CORS (Frontend URL)
FRONTEND_URL="http://localhost:3000"
```

### 4. Database Setup

Generate Prisma Client:
```bash
npm run db:generate
```

Run migrations:
```bash
npm run db:migrate
```

Seed the database (optional):
```bash
npm run db:seed
```

## Running the API

### Development Mode
```bash
npm run dev
```
The API will run on `http://localhost:4000`

### Production Build
```bash
# Build
npm run build

# Start
npm start
```

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run db:migrate` - Run database migrations
- `npm run db:seed` - Seed database with initial data
- `npm run db:studio` - Open Prisma Studio (database GUI)
- `npm run db:generate` - Generate Prisma Client
- `npm run db:push` - Push schema changes to database (without migrations)
- `npm run db:reset` - Reset database (WARNING: deletes all data)
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Inventories
- `GET /api/inventories` - List all inventories
- `GET /api/inventories/:id/stocks` - Get inventory stocks

### Items
- `GET /api/items` - List all items
- `POST /api/items` - Create item (PROCUREMENT only)
- `DELETE /api/items/:id` - Delete item (PROCUREMENT only, stock must be 0)
- `PUT /api/items/:id/prices` - Update item prices (ACCOUNTANT only)

### Customers
- `GET /api/customers` - List all customers
- `POST /api/customers` - Create customer (SALES only)
- `GET /api/customers/:id` - Get customer details

### Suppliers
- `GET /api/suppliers` - List all suppliers
- `POST /api/suppliers` - Create supplier (PROCUREMENT only)

### Sales
- `GET /api/sales/invoices` - List sales invoices
- `POST /api/sales/invoices` - Create invoice (SALES only)
- `GET /api/sales/invoices/:id` - Get invoice details
- `POST /api/sales/invoices/:id/payments` - Record payment (ACCOUNTANT/SALES)
- `POST /api/sales/invoices/:id/deliver` - Deliver invoice (INVENTORY only)

### Procurement
- `GET /api/procurement/orders` - List procurement orders
- `POST /api/procurement/orders` - Create order (PROCUREMENT only)
- `GET /api/procurement/orders/:id` - Get order details
- `POST /api/procurement/orders/:id/receive` - Receive order (INVENTORY only)

### Accounting
- `GET /api/accounting/expenses` - List expenses
- `POST /api/accounting/expenses` - Create expense
- `GET /api/accounting/opening-balances` - Get opening balances
- `POST /api/accounting/opening-balances` - Create opening balance
- `GET /api/accounting/balance/summary` - Get balance summary
- `GET /api/accounting/audit` - Get audit logs

## User Roles

- **ACCOUNTANT** - View all, update prices, record payments, manage accounting
- **PROCUREMENT** - Create items/suppliers, manage procurement orders
- **INVENTORY** - Deliver invoices, receive procurement orders
- **SALES_GROCERY** - Create customers, sales invoices (grocery section)
- **SALES_BAKERY** - Create customers, sales invoices (bakery section)
- **AUDITOR** - Read-only access to everything

## Database Schema

See `prisma/schema.prisma` for the complete database schema.

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Troubleshooting

### Database Connection Issues
- Check your `DATABASE_URL` in `.env`
- Ensure PostgreSQL is running
- Verify database credentials

### Migration Issues
- Try `npm run db:push` for schema sync without migrations
- Use `npm run db:reset` to reset database (WARNING: deletes data)

### Port Already in Use
- Change the `PORT` in `.env` file
- Or kill the process using port 4000

## Project Structure

```
apps/api/
├── prisma/
│   ├── schema.prisma      # Database schema
│   ├── seed.ts           # Seed data
│   └── migrations/       # Migration files
├── src/
│   ├── index.ts          # Entry point
│   ├── types.ts          # TypeScript types
│   ├── middleware/       # Express middleware
│   │   ├── auth.ts       # Authentication & authorization
│   │   └── audit.ts      # Audit logging
│   └── routes/           # API routes
│       ├── auth.ts
│       ├── items.ts
│       ├── customers.ts
│       ├── suppliers.ts
│       ├── sales.ts
│       ├── procurement.ts
│       ├── inventories.ts
│       └── accounting.ts
├── tests/                # Test files
├── .env                  # Environment variables
├── package.json
└── tsconfig.json
```

## Contributing

When making changes:
1. Run migrations for schema changes
2. Update seed data if needed
3. Write tests for new features
4. Follow TypeScript best practices

## License

Private - All rights reserved

