import { Request } from 'express';
import { User } from '@prisma/client';

export interface AuthRequest extends Request {
  user?: User;
}

export interface JWTPayload {
  userId: string;
  username: string;
  role: string;
}

