import { Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole, blockAuditorWrites } from '../middleware/auth';
import { createAuditLog } from '../middleware/audit';
import { AuthRequest } from '../types';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(blockAuditorWrites);

const createOfferSchema = z.object({
  itemId: z.string().min(1, 'الصنف مطلوب'),
  offerPrice: z.number().positive('السعر يجب أن يكون موجب'),
  validFrom: z.string().optional(), // ISO date string
  validTo: z.string().optional().nullable(), // ISO date string or null
  isActive: z.boolean().optional().default(true),
  notes: z.string().optional(),
});

const updateOfferSchema = z.object({
  offerPrice: z.number().positive('السعر يجب أن يكون موجب').optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

// Get all offers
router.get('/', requireRole('ACCOUNTANT', 'MANAGER'), async (req: AuthRequest, res) => {
  try {
    const { itemId, isActive } = req.query;
    
    const where: any = {};
    if (itemId) where.itemId = itemId as string;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const offers = await prisma.itemOffer.findMany({
      where,
      include: {
        item: {
          select: {
            id: true,
            name: true,
            section: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
      orderBy: [
        { isActive: 'desc' },
        { validFrom: 'desc' },
      ],
    });

    res.json(offers);
  } catch (error) {
    console.error('Get offers error:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      // Check if it's a Prisma error about missing model
      if (error.message.includes('itemOffer') || error.message.includes('ItemOffer')) {
        return res.status(500).json({ 
          error: 'خطأ في قاعدة البيانات: يرجى تشغيل Prisma migration و generate',
          details: error.message 
        });
      }
    }
    res.status(500).json({ 
      error: 'خطأ في الخادم',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Get active offers for a specific item
router.get('/item/:itemId', requireRole('ACCOUNTANT', 'MANAGER', 'SALES_BAKERY', 'AGENT_BAKERY'), async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const now = new Date();

    const offers = await prisma.itemOffer.findMany({
      where: {
        itemId,
        isActive: true,
        validFrom: { lte: now },
        OR: [
          { validTo: null },
          { validTo: { gte: now } },
        ],
      },
      include: {
        item: {
          select: {
            id: true,
            name: true,
            section: true,
          },
        },
      },
      orderBy: { validFrom: 'desc' },
    });

    res.json(offers);
  } catch (error) {
    console.error('Get item offers error:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      if (error.message.includes('itemOffer') || error.message.includes('ItemOffer')) {
        return res.status(500).json({ 
          error: 'خطأ في قاعدة البيانات: يرجى تشغيل Prisma migration و generate',
          details: error.message 
        });
      }
    }
    res.status(500).json({ 
      error: 'خطأ في الخادم',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Create offer
router.post('/', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ItemOffer'), async (req: AuthRequest, res) => {
  try {
    const data = createOfferSchema.parse(req.body);

    // Verify item exists and is in BAKERY section
    const item = await prisma.item.findUnique({
      where: { id: data.itemId },
    });

    if (!item) {
      return res.status(404).json({ error: 'الصنف غير موجود' });
    }

    if (item.section !== 'BAKERY') {
      return res.status(400).json({ error: 'العروض متاحة فقط لأصناف الأفران' });
    }

    const validFrom = data.validFrom ? new Date(data.validFrom) : new Date();
    const validTo = data.validTo ? new Date(data.validTo) : null;

    const offer = await prisma.itemOffer.create({
      data: {
        itemId: data.itemId,
        offerPrice: data.offerPrice,
        validFrom,
        validTo,
        isActive: data.isActive ?? true,
        notes: data.notes,
        createdBy: req.user!.id,
      },
      include: {
        item: {
          select: {
            id: true,
            name: true,
            section: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    res.status(201).json(offer);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Create offer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Update offer
router.put('/:id', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ItemOffer'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const data = updateOfferSchema.parse(req.body);

    const updateData: any = {};
    if (data.offerPrice !== undefined) updateData.offerPrice = data.offerPrice;
    if (data.validFrom !== undefined) updateData.validFrom = new Date(data.validFrom);
    if (data.validTo !== undefined) updateData.validTo = data.validTo ? new Date(data.validTo) : null;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.notes !== undefined) updateData.notes = data.notes;

    const offer = await prisma.itemOffer.update({
      where: { id },
      data: updateData,
      include: {
        item: {
          select: {
            id: true,
            name: true,
            section: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    res.json(offer);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: error.errors });
    }
    console.error('Update offer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Delete offer
router.delete('/:id', requireRole('ACCOUNTANT', 'MANAGER'), createAuditLog('ItemOffer'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    await prisma.itemOffer.delete({
      where: { id },
    });

    res.json({ message: 'تم حذف العرض بنجاح' });
  } catch (error) {
    console.error('Delete offer error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

export default router;

