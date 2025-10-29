import express, { type Request } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, requireRole } from '../middleware/auth';

const router = express.Router();

// Type for multer file
type MulterFile = {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer: Buffer;
};

// Require authentication for all upload routes
router.use(requireAuth);

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req: Request, _file: MulterFile, cb: (error: Error | null, destination: string) => void) => {
    cb(null, uploadsDir);
  },
  filename: (_req: Request, file: MulterFile, cb: (error: Error | null, filename: string) => void) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${base}_${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req: Request, file: MulterFile, cb: FileFilterCallback) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Invalid file type'));
    }
    cb(null, true);
  },
});

// Auth: allow roles that can attach receipts: ACCOUNTANT, MANAGER, INVENTORY, PROCUREMENT
router.post('/', requireRole('ACCOUNTANT', 'MANAGER', 'INVENTORY', 'PROCUREMENT'), upload.single('file'), (req: Request & { file?: MulterFile }, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
  }
  const publicPath = `/uploads/${req.file.filename}`;
  // Prefer explicit PUBLIC_API_URL in production; fallback to request host
  const configuredBaseUrl = process.env.PUBLIC_API_URL;
  const inferredBaseUrl = `${req.protocol}://${req.get('host')}`;
  const baseUrl = configuredBaseUrl && configuredBaseUrl.trim().length > 0 ? configuredBaseUrl : inferredBaseUrl;

  res.json({
    url: `${baseUrl}${publicPath}`,
    path: publicPath,
    filename: req.file.filename,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

export default router;


