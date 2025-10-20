import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../types';

const prisma = new PrismaClient();

export function createAuditLog(entity: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);

    res.json = function (data: any) {
      // Log after successful operations
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        const action = `${req.method} ${req.path}`;
        const entityId = req.params.id || data?.id || 'N/A';

        prisma.auditLog
          .create({
            data: {
              userId: req.user.id,
              action,
              entity,
              entityId,
              before: req.method !== 'POST' ? JSON.stringify(req.body) : null,
              after: JSON.stringify(data),
            },
          })
          .catch((err) => console.error('Audit log error:', err));
      }

      return originalJson(data);
    };

    next();
  };
}

