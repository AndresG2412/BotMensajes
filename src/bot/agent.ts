import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { botTools, executeTool, getPendingImages, PendingImage } from './tools';
import { getMemory, saveMemory, getSessionLastActivity, clearSession } from '../data/database';
import { getAllProducts } from '../data/catalog';
import { SECURITY_PROMPT } from './prompts';

const MAX_HISTORY_LENGTH = 15;
const INACTIVITY_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 horas en milisegundos

// --- CASCADAS DE MODELOS SEGÚN COMPLEJIDAD ---

// SIMPLE
const SIMPLE_MODEL_CASCADE = [
    { id: 'gemini-2.0-flash-lite',    tools: true  },
    { id: 'gemini-3.1-flash-lite',    tools: true  },
    { id: 'gemini-2.5-flash-lite',    tools: true  },
];

// COMPLEJO
const COMPLEX_MODEL_CASCADE = [
    { id: 'gemini-2.5-flash',         tools: true  },
    { id: 'gemini-3.1-flash-lite',    tools: true  },
    { id: 'gemini-2.5-flash-lite',    tools: true  },
];

type ModelEntry = { id: string; tools: boolean };

async function createWithCascade(
    cascade: ModelEntry[],
    apiKeys: string[],
    baseURL: string | undefined,
    params: Omit<Parameters<OpenAI['chat']['completions']['create']>[0], 'model'>
): Promise<{ completion: OpenAI.Chat.ChatCompletion; usedTools: boolean }> {
    let lastError: any;
    for (const entry of cascade) {
        for (const apiKey of apiKeys) {
            try {
                const openai = new OpenAI({ apiKey, baseURL });
                const callParams: any = { ...params, model: entry.id };
                if (!entry.tools) {
                    delete callParams.tools;
                    delete callParams.tool_choice;
                }
                const result = await openai.chat.completions.create(callParams);
                if (entry.id !== cascade[0].id) {
                    logger.warn(`Cascada: ${cascade[0].id} falló, usando ${entry.id}`);
                }
                return { completion: result as OpenAI.Chat.ChatCompletion, usedTools: entry.tools };
            } catch (err: any) {
                lastError = err;
                const status = err.status ?? err.statusCode;
                if (status === 429 || status === 503 || status === 500 || status === 404 || status === 400) {
                    logger.warn(`Cascada: ${entry.id} [key ...${apiKey.slice(-4)}] → HTTP ${status}, probando siguiente...`);
                    continue;
                }
                throw err;
            }
        }
    }
    throw lastError;
}

// --- EVALUADOR DE COMPLEJIDAD DE TAREAS ---
function isGreeting(userText: string): boolean {
    const text = userText.trim().toLowerCase().replace(/[¡!¿?.,]/g, '');
    const greetingWords = new Set([
        'hola', 'holaa', 'holaaa', 'buenas', 'buen dia', 'buen día', 'buenos dias', 'buenos días',
        'buenas tardes', 'buenas noches', 'que tal', 'qué tal', 'como estas', 'cómo estás',
        'como vas', 'cómo vas', 'como va', 'cómo va', 'alo', 'aló', 'hi', 'hello'
    ]);
    if (greetingWords.has(text)) return true;
    
    const words = text.split(/\s+/);
    if (words.length <= 3 && words.some(word => greetingWords.has(word))) {
        return true;
    }
    return false;
}

function isComplexTask(userText: string, hasMedia: boolean): boolean {
    if (hasMedia) return true; // Procesamiento multimodal siempre requiere modelo avanzado

    // Si es un saludo, siempre se trata como tarea simple para usar modelos con alta cuota
    if (isGreeting(userText)) return false;

    // Si el texto supera los 100 caracteres, asumimos que es una consulta detallada
    if (userText.length > 100) return true;

    // Palabras clave que delatan intenciones complejas del negocio (ventas, stock, precios)
    const complexKeywords = /precio|costo|cuánto|vende|comprar|pagar|link|checkout|catálogo|producto|inventario|disponible|asistente|imagen|foto|catálogo|bici|pedalazo|control/i;
    
    return complexKeywords.test(userText);
}

async function buildCatalogContext(storeId: string): Promise<string> {
    try {
        const products = await getAllProducts(storeId);
        if (products.length === 0) return '';
        const lines = products.map(p => {
            const price = p.price != null ? `$${p.price}` : 'consultar precio';
            const url = p.checkoutUrl ? ` | Link: ${p.checkoutUrl}` : '';
            return `- [ID: ${p.id}] ${p.name} — ${price}${url}${p.description ? ` | ${p.description}` : ''}`;
        }).join('\n');
        return `\n\nCATÁLOGO DE PRODUCTOS DISPONIBLES:\n${lines}\n\nCuando el cliente quiera pagar, envíale el link del producto directamente del catálogo anterior. Si no tiene link de pago, dile que te contacte para coordinar.`;
    } catch {
        return '';
    }
}

async function getOrCreateSession(sessionId: string, systemPrompt: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const mem = await getMemory(sessionId);
    if (!mem || mem.length === 0) {
        return [{ role: 'system', content: systemPrompt }];
    }
    if (mem[0].role === 'system') {
        mem[0].content = systemPrompt;
    }
    return mem;
}



export type BotResponse = { text: string; images: PendingImage[] };

export async function handleUserMessage(
    sessionId: string,
    storeId: string,
    senderPhone: string,
    userText: string,
    systemPrompt: string,
    customApiKey: string | null,
    media?: {mimetype: string, data: string}
): Promise<BotResponse> {

    const catalogContext = await buildCatalogContext(storeId);
    const enrichedSystemPrompt = SECURITY_PROMPT + "\n\n" + systemPrompt + catalogContext;

    // --- Cierre por inactividad ---
    const lastActivity = await getSessionLastActivity(sessionId);
    if (lastActivity) {
        const elapsed = Date.now() - lastActivity.getTime();
        if (elapsed > INACTIVITY_TIMEOUT_MS) {
            logger.info(`Sesión ${sessionId} inactiva por ${Math.round(elapsed / 3600000)}h — reiniciando conversación.`);
            await clearSession(sessionId, storeId, senderPhone, enrichedSystemPrompt);
        }
    }

    const history = await getOrCreateSession(sessionId, enrichedSystemPrompt);

    const baseURL = config.OPENAI_BASE_URL || undefined;
    const apiKeys = [
        customApiKey || config.OPENAI_API_KEY,
        ...(config.OPENAI_API_KEY_2 ? [config.OPENAI_API_KEY_2] : [])
    ].filter(Boolean);

    let contentPayload: any = userText || "El usuario envió un archivo sin texto.";
    if (media) {
        contentPayload = [
            { type: "text", text: userText || "¿Me puedes decir qué ves en esta foto conectándolo con la tienda?" },
            { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
        ];
    }

    history.push({ role: 'user', content: contentPayload });

    if (history.length > MAX_HISTORY_LENGTH) {
        history.splice(1, history.length - MAX_HISTORY_LENGTH);
    }

    await saveMemory(sessionId, storeId, senderPhone, history);

    const sanitizedHistory = history.map(msg => {
        if (Array.isArray((msg as any).content)) {
            const text = (msg as any).content
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text)
                .join(' ') || '[imagen]';
            return { ...msg, content: text };
        }
        return msg;
    }) as OpenAI.Chat.ChatCompletionMessageParam[];

    // --- ENRUTAMIENTO DINÁMICO DE CASCADA ---
    const isComplex = isComplexTask(userText, !!media);
    const activeCascade = isComplex ? COMPLEX_MODEL_CASCADE : SIMPLE_MODEL_CASCADE;
    
    logger.info(`Sesión ${sessionId} enrutada a cascada: ${isComplex ? 'COMPLEJA' : 'SIMPLE'} (Primer intento: ${activeCascade[0].id})`);

    try {
        let { completion: aiResponse, usedTools } = await createWithCascade(activeCascade, apiKeys, baseURL, {
            messages: sanitizedHistory,
            tools: botTools,
            tool_choice: 'auto'
        });

        let responseMessage = aiResponse.choices[0].message;

        if (usedTools) {
            while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
                history.push(responseMessage);

                for (const toolCall of responseMessage.tool_calls) {
                    try {
                        const functionName = toolCall.function.name;
                        const functionArgs = JSON.parse(toolCall.function.arguments);
                        const functionResult = await executeTool(functionName, functionArgs, storeId, senderPhone, sessionId, enrichedSystemPrompt);
                        history.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: functionResult
                        });
                    } catch (parseError) {
                        logger.error(`Error parseando argumentos de tool ${toolCall.function.name}:`, toolCall.function.arguments);
                        history.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify({ error: "Argumentos inválidos proporcionados por la IA." })
                        });
                    }
                }

                // Si entramos en ejecución de herramientas, seguimos asegurando el uso de la cascada activa
                const next = await createWithCascade(activeCascade, apiKeys, baseURL, {
                    messages: history,
                    tools: botTools,
                    tool_choice: 'auto'
                });
                aiResponse = next.completion;
                responseMessage = aiResponse.choices[0].message;
            }
        }

        let finalContent = responseMessage.content || "Hubo un error de procesamiento.";

        if (finalContent.includes('Demasiadas solicitudes') || finalContent.includes('Too many requests')) {
            finalContent = "Lo siento, estoy recibiendo muchas consultas en este momento. Por favor, escríbeme de nuevo en unos minutos.";
        }

        history.push({ role: 'assistant', content: finalContent });

        let finalHistory = history;
        if (history.length > MAX_HISTORY_LENGTH) {
            finalHistory = [history[0], ...history.slice(history.length - MAX_HISTORY_LENGTH + 1)];
        }

        await saveMemory(sessionId, storeId, senderPhone, finalHistory);

        const images = getPendingImages();

        return { text: finalContent, images };

    } catch (error: any) {
        logger.error(`Error conversacional sesión ${sessionId}:`, error.message, error.status, JSON.stringify(error.error ?? error.response?.data ?? ''));
        const status = error.status ?? error.statusCode;
        if (status === 400) {
            logger.warn(`Sesión ${sessionId} con historial corrupto — limpiando y reintentando...`);
            const freshHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
                { role: 'system', content: enrichedSystemPrompt },
                { role: 'user', content: userText || 'Hola' }
            ];
            await saveMemory(sessionId, storeId, senderPhone, freshHistory);
            try {
                const { completion: retryResponse } = await createWithCascade(activeCascade, apiKeys, baseURL, {
                    messages: freshHistory,
                    tools: botTools,
                    tool_choice: 'auto'
                });
                const retryContent = retryResponse.choices[0].message.content || "Hubo un error de procesamiento.";
                freshHistory.push({ role: 'assistant', content: retryContent });
                await saveMemory(sessionId, storeId, senderPhone, freshHistory);
                return { text: retryContent, images: [] };
            } catch (retryErr: any) {
                logger.error(`Reintento fallido para ${sessionId}: ${retryErr.message}`);
            }
        }
        return { text: "Lo siento, tengo un problema y no te puedo atender en este momento. Escribe de nuevo más tarde.", images: [] };
    }
}