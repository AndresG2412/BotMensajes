import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash'),
    role: text('role').notNull(),
    storeId: text('store_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
});

export const stores = sqliteTable('stores', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    systemPrompt: text('system_prompt'),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    openaiApiKey: text('openai_api_key'),
    pqrEmail: text('pqr_email'),
    adminCalendarEmail: text('admin_calendar_email'),
    telegramToken: text('telegram_token'),
    telegramBotActive: integer('telegram_bot_active', { mode: 'boolean' }).default(false),
    whatsappPhoneNumberId: text('whatsapp_phone_number_id'),
    whatsappAccessToken: text('whatsapp_access_token')
});

// Products está en Firebase, pero lo declaramos para compatibilidad si alguna vez cambian
export const products = sqliteTable('products', {
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    productType: text('product_type'),
    price: integer('price'),
    imageUrl: text('image_url'),
    checkoutUrl: text('checkout_url')
});

export const sessions = sqliteTable('sessions', {
    sessionId: text('session_id').primaryKey(),
    storeId: text('store_id').notNull(),
    phone: text('phone').notNull(),
    lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
    isPaused: integer('is_paused', { mode: 'boolean' }).default(false),
    remarketingSent: integer('remarketing_sent', { mode: 'boolean' }).default(false)
});
