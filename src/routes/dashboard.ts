import { Router, Request, Response } from 'express';
import { getAllSessions, deleteSession, getMemory, saveMemory } from '../data/database';
import { getAllProducts, createProduct, updateProduct, deleteProduct } from '../data/catalog';
import { db } from '../data/connection';
import { stores, users } from '../data/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import {
    getBotStatus, startBotInstance, stopBotInstance,
    sendWhatsAppMessage, pauseChat, resumeChat, processUnansweredMessage
} from '../channels/whatsapp';
import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { DEFAULT_STORE_SYSTEM_PROMPT } from '../bot/prompts';

export const dashboardRouter = Router();

// ─────────────────────────────────────────
//  Helpers de autenticación / roles
// ─────────────────────────────────────────
const isSuperAdmin = (req: any): boolean =>
    req.user?.role === 'superadmin' || req.user?.user === config.DASHBOARD_USER;

const checkSuperAdmin = (req: any, res: Response, next: any) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Prohibido: Solo superadmin' });
    next();
};

// ─────────────────────────────────────────
//  Cloudinary — configuración única
// ─────────────────────────────────────────
cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key:    config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
});

// ─────────────────────────────────────────
//  USUARIOS  (solo superadmin)
// ─────────────────────────────────────────

/** GET /api/users — listar todos los usuarios */
dashboardRouter.get('/api/users', checkSuperAdmin, async (_req: Request, res: Response) => {
    try {
        const allUsers = await db.select({
            id:        users.id,
            username:  users.username,
            role:      users.role,
            storeId:   users.storeId,
            createdAt: users.createdAt,
        }).from(users);
        res.json(allUsers);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/users — crear usuario */
dashboardRouter.post('/api/users', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const { username, password, storeId, role } = req.body;
        if (!username || !password)
            return res.status(400).json({ error: 'Usuario y contraseña obligatorios' });

        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        const [user] = await db.insert(users).values({
            id: Date.now().toString(),
            username,
            passwordHash,
            storeId: storeId || null,
            role:    role || 'store_owner',
        }).returning();

        res.status(201).json({ id: user.id, username: user.username, role: user.role });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

/** DELETE /api/users/:id — eliminar usuario */
dashboardRouter.delete('/api/users/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        await db.delete(users).where(eq(users.id, req.params['id'] as string));
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  TIENDAS / BOTS
// ─────────────────────────────────────────

/** GET /api/stores */
dashboardRouter.get('/api/stores', async (req: any, res: Response) => {
    try {
        const result = isSuperAdmin(req)
            ? await db.query.stores.findMany()
            : await db.query.stores.findMany({ where: eq(stores.id, req.user.storeId) });
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/stores — crear tienda */
dashboardRouter.post('/api/stores', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const { id, name, systemPrompt, openaiApiKey, pqrEmail, adminCalendarEmail, telegramToken, telegramBotActive } = req.body;
        if (!id || !name) return res.status(400).json({ error: 'ID y Nombre son obligatorios' });

        const [store] = await db.insert(stores).values({
            id,
            name,
            systemPrompt:       systemPrompt || DEFAULT_STORE_SYSTEM_PROMPT,
            openaiApiKey:       openaiApiKey       || null,
            pqrEmail:           pqrEmail           || null,
            adminCalendarEmail: adminCalendarEmail || null,
            telegramToken:      telegramToken      || null,
            telegramBotActive:  !!telegramBotActive,
            isActive: true,
        }).returning();

        res.status(201).json(store);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

/** PUT /api/stores/:id — actualizar tienda */
dashboardRouter.put('/api/stores/:id', async (req: any, res: Response) => {
    try {
        const { id } = req.params;
        if (!isSuperAdmin(req) && req.user.storeId !== id)
            return res.status(403).json({ error: 'Sin permiso para modificar esta tienda' });

        const {
            name, systemPrompt, openaiApiKey, isActive,
            whatsappPhoneNumberId, whatsappAccessToken,
            pqrEmail, adminCalendarEmail, telegramToken, telegramBotActive,
        } = req.body;

        if (!name)         return res.status(400).json({ error: 'El nombre es obligatorio' });
        if (!systemPrompt) return res.status(400).json({ error: 'El System Prompt es obligatorio' });

        const [updated] = await db.update(stores)
            .set({
                name, systemPrompt,
                openaiApiKey:       openaiApiKey       || null,
                pqrEmail:           pqrEmail           || null,
                adminCalendarEmail: adminCalendarEmail || null,
                telegramToken:      telegramToken      || null,
                telegramBotActive:  !!telegramBotActive,
                isActive,
                ...(whatsappPhoneNumberId !== undefined && { whatsappPhoneNumberId: whatsappPhoneNumberId || null }),
                ...(whatsappAccessToken   !== undefined && { whatsappAccessToken:   whatsappAccessToken   || null }),
            })
            .where(eq(stores.id, id))
            .returning();

        if (!updated) return res.status(404).json({ error: 'Tienda no encontrada' });
        res.json(updated);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

/** DELETE /api/stores/:id — eliminar tienda y detener bot */
dashboardRouter.delete('/api/stores/:id', checkSuperAdmin, async (req: Request, res: Response) => {
    try {
        const id = req.params['id'] as string;
        await stopBotInstance(id);
        await db.delete(stores).where(eq(stores.id, id));
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  BOTS — estado y control
// ─────────────────────────────────────────

/** GET /api/bots/status/:storeId */
dashboardRouter.get('/api/bots/status/:storeId', (req: any, res: Response) => {
    const { storeId } = req.params;
    if (!isSuperAdmin(req) && req.user.storeId !== storeId)
        return res.status(403).json({ error: 'Prohibido' });
    res.json(getBotStatus(storeId));
});

/** POST /api/bots/start/:storeId */
dashboardRouter.post('/api/bots/start/:storeId', async (req: any, res: Response) => {
    const { storeId } = req.params;
    if (!isSuperAdmin(req) && req.user.storeId !== storeId)
        return res.status(403).json({ error: 'Prohibido' });

    startBotInstance(storeId).catch(err =>
        logger.error(`Error iniciando bot ${storeId}: ${err.message}`)
    );
    res.json({ success: true });
});

// ─────────────────────────────────────────
//  SESIONES / CHATS
// ─────────────────────────────────────────

/** GET /api/sessions */
dashboardRouter.get('/api/sessions', async (req: any, res: Response) => {
    const storeId = isSuperAdmin(req)
        ? (req.query.storeId as string | undefined)
        : req.user.storeId;

    if (!storeId && !isSuperAdmin(req))
        return res.status(400).json({ error: 'storeId es obligatorio' });

    res.json(await getAllSessions(storeId));
});

/** DELETE /api/sessions/:sessionId */
dashboardRouter.delete('/api/sessions/:sessionId', async (req: Request, res: Response) => {
    try {
        await deleteSession(req.params['sessionId'] as string);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/reply — respuesta humana desde el panel */
dashboardRouter.post('/api/reply', async (req: any, res: Response) => {
    try {
        const { sessionId, message, phone } = req.body;
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;

        if (!phone || !message || !storeId)
            return res.status(400).json({ error: 'Falta teléfono, mensaje o storeId' });

        if (sessionId) {
            await pauseChat(sessionId);
            try {
                const history = await getMemory(sessionId);
                history.push({ role: 'assistant', content: message });
                await saveMemory(sessionId, storeId, phone, history);
            } catch (e: any) {
                logger.error(`Error guardando mensaje de admin: ${e.message}`);
            }
        }

        await sendWhatsAppMessage(storeId, phone, message);
        res.json({ success: true, botPaused: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** POST /api/resume — reactivar bot en chat pausado */
dashboardRouter.post('/api/resume', async (req: Request, res: Response) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ error: 'Falta sessionId' });

        await resumeChat(sessionId);

        const parts = sessionId.split('_');
        if (parts.length >= 2) {
            const [storeId, ...rest] = parts;
            const phone = rest.join('_');
            processUnansweredMessage(sessionId, storeId, phone).catch(err =>
                logger.error(`Error en processUnansweredMessage: ${err.message}`)
            );
        }

        res.json({ success: true, botResumed: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  IMÁGENES — upload a Cloudinary
// ─────────────────────────────────────────

/**
 * POST /api/upload-images
 * Body: { images: string[], folder?: string }
 *   images → array de data URLs base64 (data:image/...;base64,...)
 *   folder → nombre de carpeta (normalmente la referencia de la propiedad)
 * Response: { urls: string[] }
 */
dashboardRouter.post('/api/upload-images', async (req: any, res: Response) => {
    try {
        const { images, folder } = req.body as { images: string[]; folder?: string };

        if (!Array.isArray(images) || images.length === 0)
            return res.status(400).json({ error: 'No se enviaron imágenes' });

        if (images.length > 20)
            return res.status(400).json({ error: 'Máximo 20 imágenes por solicitud' });

        const uploadFolder = `propiedades/${folder || 'sin-referencia'}`;

        const urls = await Promise.all(
            images.map(base64 =>
                cloudinary.uploader.upload(base64, {
                    folder:        uploadFolder,
                    resource_type: 'image',
                    // Transformación automática: máx 1200px, calidad auto
                    transformation: [{ width: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
                }).then(r => r.secure_url)
            )
        );

        logger.info(`Subidas ${urls.length} imágenes a Cloudinary en /${uploadFolder}`);
        res.json({ urls });
    } catch (e: any) {
        logger.error('Error subiendo imágenes a Cloudinary:', e);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  PRODUCTOS  (CRUD)
// ─────────────────────────────────────────

/** GET /api/products */
dashboardRouter.get('/api/products', async (req: any, res: Response) => {
    const storeId = isSuperAdmin(req)
        ? (req.query.storeId as string | undefined)
        : req.user.storeId;

    if (!storeId && !isSuperAdmin(req))
        return res.status(400).json({ error: 'storeId es obligatorio' });

    const products = await getAllProducts(storeId);

    res.json(products.map(p => ({
        id:               p.id,
        storeId:          p.storeId,
        nombre:           p.nombre           || p.name,
        precio:           p.price,
        imagen_url:       p.imageUrl,
        barrio:           p.barrio           || '',
        baños:            p.baños            || '',
        caracteristicas:  p.caracteristicas  || [],
        ciudad:           p.ciudad           || '',
        habitaciones:     p.habitaciones     || 0,
        metros_cuadrados: p.metros_cuadrados || 0,
        pisos:            p.pisos            || 0,
        referencia:       p.referencia       || p.id,
        imagenes:         p.imagenes         || [],
        folderCloudinary: p.folderCloudinary  || '',
        tipo_propiedad:   p.tipo_propiedad   || '',
    })));
});

/** POST /api/products — crear propiedad */
dashboardRouter.post('/api/products', async (req: any, res: Response) => {
    try {
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;
        if (!storeId) return res.status(400).json({ error: 'storeId es obligatorio' });

        const b = req.body;
        const product = await createProduct({
            nombre:           b.nombre                   || '',
            name:             b.nombre,
            description:      b.caracteristicas?.join(', ') || '',
            productType:      'propiedad',
            price:            Number(b.precio)           || 0,
            imageUrl:         b.imagen_url               || b.imagenes?.[0] || '',
            barrio:           b.barrio                   || '',
            baños:            b.baños                    || '',
            caracteristicas:  b.caracteristicas          || [],
            ciudad:           b.ciudad                   || '',
            habitaciones:     parseInt(b.habitaciones)   || 0,
            metros_cuadrados: parseFloat(b.metros_cuadrados) || 0,
            pisos:            parseInt(b.pisos)          || 0,
            referencia:       b.referencia               || '',
            imagenes:         b.imagenes                 || [],
            folderCloudinary: b.folderCloudinary          || '',
            tipo_propiedad:   b.tipo_propiedad           || '',
        }, storeId);

        res.status(201).json(product);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

/** PUT /api/products/:id — actualizar propiedad */
dashboardRouter.put('/api/products/:id', async (req: any, res: Response) => {
    try {
        const { id } = req.params;
        const storeId = isSuperAdmin(req) ? req.body.storeId : req.user.storeId;
        if (!storeId) return res.status(400).json({ error: 'storeId es obligatorio' });

        const b = req.body;
        const updated = await updateProduct(id, {
            nombre:           b.nombre,
            name:             b.nombre,
            description:      b.caracteristicas?.join(', ') || '',
            productType:      'propiedad',
            price:            Number(b.precio)           || 0,
            imageUrl:         b.imagen_url               || b.imagenes?.[0] || '',
            barrio:           b.barrio,
            baños:            b.baños,
            caracteristicas:  b.caracteristicas,
            ciudad:           b.ciudad,
            habitaciones:     b.habitaciones  !== undefined ? parseInt(b.habitaciones)       : undefined,
            metros_cuadrados: b.metros_cuadrados !== undefined ? parseFloat(b.metros_cuadrados) : undefined,
            pisos:            b.pisos         !== undefined ? parseInt(b.pisos)              : undefined,
            referencia:       b.referencia,
            imagenes:         b.imagenes,
            folderCloudinary: b.folderCloudinary,
            tipo_propiedad:   b.tipo_propiedad,
        }, storeId);

        if (!updated) return res.status(404).json({ error: 'Propiedad no encontrada' });
        res.json(updated);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** DELETE /api/products/:id */
dashboardRouter.delete('/api/products/:id', async (req: any, res: Response) => {
    try {
        const { id } = req.params;
        const storeId = isSuperAdmin(req)
            ? ((req.query.storeId || req.body.storeId) as string)
            : req.user.storeId;

        if (!storeId) return res.status(400).json({ error: 'storeId es obligatorio' });

        const deleted = await deleteProduct(id, storeId);
        if (!deleted) return res.status(404).json({ error: 'Propiedad no encontrada' });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  UTILIDADES
// ─────────────────────────────────────────

/** GET /api/test-models — prueba rápida de modelos disponibles (superadmin) */
dashboardRouter.get('/api/test-models', checkSuperAdmin, async (_req: Request, res: Response) => {
    const models = [
        'gemini-2.5-flash', 'gemini-2.5-flash-lite',
        'gemini-2.0-flash', 'gemini-2.0-flash-lite',
        'gemini-2.5-pro', 'gemma-3-27b-it', 'gemma-3-4b-it',
    ];
    const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL || undefined });
    const results: Record<string, string> = {};

    for (const model of models) {
        try {
            const r = await openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: 'Responde solo: OK' }],
                max_tokens: 5,
            } as any);
            results[model] = `✅ ${r.choices[0].message.content?.trim()}`;
        } catch (err: any) {
            results[model] = `❌ ${err.status ?? ''} ${err.message?.substring(0, 60)}`;
        }
    }

    res.json(results);
});

// ─────────────────────────────────────────
//  Servir el dashboard HTML
// ─────────────────────────────────────────
dashboardRouter.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});