import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
const prisma = new PrismaClient();

// Only MANAGER can access user management
const requireManager = (req: AuthRequest, res: any, next: any) => {
  if (req.user?.role !== 'MANAGER') {
    return res.status(403).json({ error: 'غير مصرح - يتطلب صلاحيات المدير' });
  }
  next();
};

// Apply auth middleware to all routes
router.use(requireAuth);
router.use(requireManager);

const createUserSchema = z.object({
  username: z.string().min(3, 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل'),
  password: z.string().min(6, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  role: z.enum([
    'SALES_GROCERY',
    'SALES_BAKERY',
    'AGENT_GROCERY',
    'AGENT_BAKERY',
    'INVENTORY',
    'PROCUREMENT',
    'ACCOUNTANT',
    'AUDITOR',
    'MANAGER',
  ]),
  inventoryAccesses: z.array(z.object({
    inventoryId: z.string(),
    section: z.enum(['GROCERY', 'BAKERY']),
  })).optional(),
});

// Get all users
router.get('/', async (req: AuthRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        accesses: {
          include: {
            inventory: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
  }
});

// Create new user
router.post('/', async (req: AuthRequest, res) => {
  try {
    const validatedData = createUserSchema.parse(req.body);

    // Check if username already exists
    const existingUser = await prisma.user.findUnique({
      where: { username: validatedData.username },
    });

    if (existingUser) {
      return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(validatedData.password, 10);

    // Create user with inventory accesses
    const user = await prisma.user.create({
      data: {
        username: validatedData.username,
        passwordHash,
        role: validatedData.role,
        accesses: validatedData.inventoryAccesses ? {
          create: validatedData.inventoryAccesses.map(access => ({
            inventoryId: access.inventoryId,
            section: access.section,
          })),
        } : undefined,
      },
      include: {
        accesses: {
          include: {
            inventory: true,
          },
        },
      },
    });

    // Remove sensitive data before sending response
    const { passwordHash: _, sessionToken: __, ...userWithoutSensitiveData } = user;

    res.status(201).json({
      user: userWithoutSensitiveData,
      message: 'تم إنشاء المستخدم بنجاح',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'بيانات غير صالحة', 
        details: error.errors.map(e => e.message) 
      });
    }
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'خطأ في إنشاء المستخدم' });
  }
});

// Delete user
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Prevent deleting yourself
    if (id === req.user?.id) {
      return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    // Delete user (accesses will be deleted automatically due to cascade)
    await prisma.user.delete({
      where: { id },
    });

    res.json({ message: 'تم حذف المستخدم بنجاح' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'خطأ في حذف المستخدم' });
  }
});

// Update user password
router.patch('/:id/password', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id },
      data: { 
        passwordHash,
        sessionToken: null, // Invalidate all sessions
      },
    });

    res.json({ message: 'تم تحديث كلمة المرور بنجاح' });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ error: 'خطأ في تحديث كلمة المرور' });
  }
});

export default router;

