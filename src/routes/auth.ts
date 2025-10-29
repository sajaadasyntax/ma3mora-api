import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { username },
      include: { accesses: { include: { inventory: true } } },
    });

    if (!user) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    // Generate a new session token to invalidate all previous sessions
    const sessionToken = crypto.randomBytes(32).toString('hex');
    
    // Update user with new session token
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionToken },
    });

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, sessionToken },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // In production across subdomains, cookies must be SameSite=None and Secure to be sent on cross-site requests (e.g., web on ma3morainventory.cloud, API on api.ma3morainventory.cloud)
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const { passwordHash, ...userWithoutPassword } = user;

    res.json({
      user: userWithoutPassword,
      message: 'تم تسجيل الدخول بنجاح',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Login error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        // Clear session token from database
        await prisma.user.update({
          where: { id: decoded.userId },
          data: { sessionToken: null },
        });
      } catch (error) {
        // Token invalid, ignore
      }
    }
    res.clearCookie('token');
    res.json({ message: 'تم تسجيل الخروج بنجاح' });
  } catch (error) {
    res.clearCookie('token');
    res.json({ message: 'تم تسجيل الخروج بنجاح' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (!token) {
      return res.status(401).json({ error: 'غير مصرح' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { accesses: { include: { inventory: true } } },
    });

    if (!user) {
      return res.status(401).json({ error: 'المستخدم غير موجود' });
    }

    // Verify session token matches
    if (decoded.sessionToken !== user.sessionToken) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'تم إنهاء جلستك بسبب تسجيل الدخول من مكان آخر' });
    }

    const { passwordHash, sessionToken, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    res.status(401).json({ error: 'رمز الوصول غير صالح' });
  }
});

export default router;

