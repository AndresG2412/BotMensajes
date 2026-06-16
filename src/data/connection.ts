import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const dataDir = path.join(process.cwd(), 'data');
const storesFile = path.join(dataDir, 'local-stores.json');
const dbFile = path.join(dataDir, 'database.sqlite');

function ensureDataDir() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

ensureDataDir();

const sqlite = new Database(dbFile);
export const db = drizzle(sqlite, { schema });

// Migración inicial desde JSON a SQLite si SQLite está vacío
try {
    if (fs.existsSync(storesFile)) {
        // Verificar si la tabla existe (para no fallar en el primer arranque si aún no se corrió migrate)
        const tableCheck = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stores';").get();
        
        if (tableCheck) {
            // Ver si hay tiendas en sqlite
            const countRes: any = sqlite.prepare("SELECT count(*) as count FROM stores;").get();
            if (countRes && countRes.count === 0) {
                if (fs.existsSync(storesFile)) {
                    console.log("[INFO] Base de datos SQLite vacía. Migrando datos desde local-stores.json...");
                    const parsed = JSON.parse(fs.readFileSync(storesFile, 'utf8'));
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const insert = sqlite.prepare(`
                            INSERT INTO stores (id, name, system_prompt, is_active, openai_api_key, pqr_email, admin_calendar_email, telegram_token, telegram_bot_active, whatsapp_phone_number_id, whatsapp_access_token)
                            VALUES (@id, @name, @systemPrompt, @isActive, @openaiApiKey, @pqrEmail, @adminCalendarEmail, @telegramToken, @telegramBotActive, @whatsappPhoneNumberId, @whatsappAccessToken)
                        `);
                        
                        for (const store of parsed) {
                            insert.run({
                                id: store.id || 'default',
                                name: store.name || 'Mi Tienda',
                                systemPrompt: store.systemPrompt || '',
                                isActive: store.isActive ? 1 : 0,
                                openaiApiKey: store.openaiApiKey || null,
                                pqrEmail: store.pqrEmail || null,
                                adminCalendarEmail: store.adminCalendarEmail || null,
                                telegramToken: store.telegramToken || null,
                                telegramBotActive: store.telegramBotActive ? 1 : 0,
                                whatsappPhoneNumberId: store.whatsappPhoneNumberId || null,
                                whatsappAccessToken: store.whatsappAccessToken || null
                            });
                        }
                        console.log("[INFO] Migración desde JSON completada con éxito.");
                    }
                } else {
                    console.log("[INFO] Base de datos vacía y sin JSON previo. Creando tienda por defecto...");
                    sqlite.prepare(`
                        INSERT INTO stores (id, name, system_prompt, is_active)
                        VALUES ('default', 'Mi Tienda', '', 1)
                    `).run();
                    console.log("[INFO] Tienda por defecto creada.");
                }
            }
        }
    }
} catch (error) {
    console.error("[ERROR] Hubo un problema al intentar migrar los datos JSON a SQLite:", error);
}
