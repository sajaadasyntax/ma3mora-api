import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';
import authRoutes from './routes/auth';
import inventoriesRoutes from './routes/inventories';
import itemsRoutes from './routes/items';
import customersRoutes from './routes/customers';
import suppliersRoutes from './routes/suppliers';
import salesRoutes from './routes/sales';
import procurementRoutes from './routes/procurement';
import accountingRoutes from './routes/accounting';
import employeesRoutes from './routes/employees';
import uploadsRoutes from './routes/uploads';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(compression()); // Add compression for faster data transfer
app.use(express.json());
app.use(cookieParser());
// Static files for uploaded receipts
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/inventories', inventoriesRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/uploads', uploadsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API is running' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'خطأ داخلي في الخادم' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/api`);
});

