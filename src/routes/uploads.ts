import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireRole } from '../middleware/auth';

const router = express.Router();

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${base}_${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Invalid file type'));
    }
    cb(null, true);
  },
});

// Auth: allow roles that can attach receipts: ACCOUNTANT, MANAGER, INVENTORY, PROCUREMENT
router.post('/', requireRole('ACCOUNTANT', 'MANAGER', 'INVENTORY', 'PROCUREMENT'), upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
  }
  const publicPath = `/uploads/${req.file.filename}`;
  res.json({ url: publicPath, filename: req.file.filename, size: req.file.size, mime: req.file.mimetype });
});

export default router;


