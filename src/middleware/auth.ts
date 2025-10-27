import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { AuthRequest, JWTPayload } from '../types';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: 'غير مصرح' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { accesses: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'المستخدم غير موجود' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'رمز الوصول غير صالح' });
  }
}

export function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'غير مصرح' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'ليس لديك صلاحية للوصول' });
    }

    next();
  };
}

export function requireAccess(inventoryId?: string, section?: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'غير مصرح' });
    }

    // ACCOUNTANT, INVENTORY, PROCUREMENT, AUDITOR, and MANAGER have access to all
    if (['ACCOUNTANT', 'INVENTORY', 'PROCUREMENT', 'AUDITOR', 'MANAGER'].includes(req.user.role)) {
      return next();
    }

    // Sales users need specific access
    const targetInventoryId = inventoryId || req.params.inventoryId || req.body.inventoryId;
    const targetSection = section || req.params.section || req.body.section;

    if (!targetInventoryId || !targetSection) {
      return res.status(400).json({ error: 'المخزن والقسم مطلوبان' });
    }

    const hasAccess = await prisma.userInventoryAccess.findUnique({
      where: {
        userId_inventoryId_section: {
          userId: req.user.id,
          inventoryId: targetInventoryId,
          section: targetSection,
        },
      },
    });

    if (!hasAccess) {
      return res.status(403).json({ error: 'ليس لديك صلاحية للوصول لهذا المخزن' });
    }

    next();
  };
}

export function blockAuditorWrites(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role === 'AUDITOR' && req.method !== 'GET') {
    return res.status(403).json({ error: 'المراجع لديه صلاحية القراءة فقط' });
  }
  next();
}

