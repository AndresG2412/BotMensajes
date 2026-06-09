import OpenAI from 'openai';
import { searchProducts, getProductById, getAllProducts, getProductRawImages } from '../data/catalog';
import { clearSession } from '../data/database';
import { google } from 'googleapis';
import { logger } from '../utils/logger';
import axios from 'axios';
import path from 'path';

// ─────────────────────────────────────────
//  Cola temporal de imágenes pendientes
// ─────────────────────────────────────────
export type PendingImage = { mimetype: string; base64: string; caption?: string };
let pendingImages: PendingImage[] = [];

export function getPendingImages(): PendingImage[] {
    const images = [...pendingImages];
    pendingImages = [];
    return images;
}

function queueImage(base64DataUri: string, caption?: string) {
    const match = base64DataUri.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) pendingImages.push({ mimetype: match[1], base64: match[2], caption });
}

// ─────────────────────────────────────────
//  Definición de tools para OpenAI
// ─────────────────────────────────────────
export const botTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'search_products',
            description: 'Busca propiedades en el catálogo de SIS Inmobiliaria según una búsqueda. Úsalo cuando el cliente describa lo que busca (ciudad, tipo, habitaciones, precio, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Término de búsqueda. Ej: "apartamento Pitalito 3 habitaciones", "casa barrio centro".'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_all_products',
            description: 'Obtiene todas las propiedades disponibles en el catálogo. Úsalo cuando el cliente pregunte qué propiedades hay disponibles en general.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_product_details',
            description: 'Obtiene todos los detalles de una propiedad específica por su ID (precio, habitaciones, baños, fotos, descripción, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'El ID exacto de la propiedad. Ej: "AP-102".'
                    }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_product_image',
            description: 'Envía las fotos de una propiedad al cliente por WhatsApp. Úsalo cuando el cliente pida ver la propiedad o quiera fotos.',
            parameters: {
                type: 'object',
                properties: {
                    product_id: {
                        type: 'string',
                        description: 'El ID de la propiedad cuyas fotos quieres enviar.'
                    }
                },
                required: ['product_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'schedule_appointment',
            description: [
                'Agenda una cita de visita o revisión de propiedad en Google Calendar.',
                'SOLO llama esta función cuando el cliente haya confirmado TODOS los datos: nombre, ciudad, fecha y hora.',
                'REGLAS ESTRICTAS:',
                '- Debes preguntar obligatoriamente la CIUDAD donde se realizará o desea la cita.',
                '- La fecha debe ser MÍNIMO el día siguiente al de hoy.',
                '- La hora debe estar entre 14:00 (2 PM) y 18:00 (6 PM).',
                '- Si el cliente pide hoy o una hora fuera de ese rango, NO llames esta función: corrígelo primero.',
                '- NUNCA modifiques ni canceles citas existentes. Solo crea nuevas.',
                '- NUNCA reveles información de citas de otros clientes ni de sus fechas.'
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    client_name: {
                        type: 'string',
                        description: 'Nombre completo del cliente que asistirá.'
                    },
                    city: {
                        type: 'string',
                        description: 'Ciudad de Colombia donde se solicita la cita o donde está la propiedad. Ej: "Pitalito", "Florencia", "Cali".'
                    },
                    date: {
                        type: 'string',
                        description: 'Fecha en formato YYYY-MM-DD. Debe ser mínimo mañana.'
                    },
                    time: {
                        type: 'string',
                        description: 'Hora en formato HH:MM (24h). Debe estar entre 14:00 y 18:00.'
                    },
                    appointment_type: {
                        type: 'string',
                        enum: ['visita_compra', 'visita_arriendo', 'revision_venta'],
                        description: 'Tipo: visita para comprar, visita para arrendar, o revisión de propiedad para venta.'
                    },
                    property_reference: {
                        type: 'string',
                        description: 'Referencia o nombre de la propiedad a visitar, si el cliente ya eligió una.'
                    },
                    address: {
                        type: 'string',
                        description: 'Dirección o punto de referencia para la visita, si aplica.'
                    },
                    phone: {
                        type: 'string',
                        description: 'Número de WhatsApp del cliente.'
                    }
                },
                required: ['client_name', 'city', 'date', 'time', 'appointment_type']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'close_conversation',
            description: 'Cierra y reinicia la conversación. Úsalo ÚNICAMENTE cuando el cliente se despida claramente o confirme que ya no necesita más ayuda. NO lo uses si solo dice "gracias" en medio de la conversación.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Razón breve del cierre. Ej: "cliente se despidió", "cita agendada, conversación cerrada".'
                    }
                },
                required: ['reason']
            }
        }
    }
];

// ─────────────────────────────────────────
//  Executor
// ─────────────────────────────────────────
export async function executeTool(
    name: string,
    args: any,
    storeId: string,
    senderPhone: string,
    sessionId?: string,
    systemPrompt?: string,
    adminCalendarEmail?: string,   
    pqrEmail?: string              
): Promise<string> {
    logger.info(`Ejecutando tool: ${name}`, args);

    try {
        switch (name) {

            // ── Buscar propiedades ──────────────────────────────────────
            case 'search_products': {
                const products = await searchProducts(args.query, storeId);
                if (products.length === 0) {
                    const all = await getAllProducts(storeId);
                    if (all.length > 0) {
                        return JSON.stringify({
                            nota: 'No hay coincidencias exactas, pero aquí hay otras propiedades disponibles:',
                            propiedades: all.slice(0, 10)
                        });
                    }
                    return JSON.stringify({ error: 'No se encontraron propiedades en el catálogo.' });
                }
                return JSON.stringify(products);
            }

            // ── Listar todas ────────────────────────────────────────────
            case 'list_all_products': {
                const all = await getAllProducts(storeId);
                return JSON.stringify(all);
            }

            // ── Detalle de una propiedad ────────────────────────────────
            case 'get_product_details': {
                const product = await getProductById(args.id, storeId);
                if (!product) return JSON.stringify({ error: 'No se encontró la propiedad con ese ID.' });
                return JSON.stringify(product);
            }

            // ── Enviar fotos de propiedad ───────────────────────────────
            case 'send_product_image': {
                const images = await getProductRawImages(args.product_id, storeId);
                if (!images || images.length === 0) {
                    return JSON.stringify({ success: false, error: 'Esta propiedad no tiene imágenes disponibles.' });
                }
                const productInfo = await getProductById(args.product_id, storeId);
                const baseName = productInfo ? productInfo.name : 'Propiedad';
                let sent = 0;

                for (let i = 0; i < images.length; i++) {
                    const imageUrl = images[i];
                    const caption = i === 0 ? `📸 ${baseName} (${images.length} foto${images.length > 1 ? 's' : ''})` : undefined;
                    try {
                        if (imageUrl.startsWith('data:')) {
                            queueImage(imageUrl, caption);
                        } else {
                            const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
                            const contentType = response.headers['content-type'] || 'image/jpeg';
                            const base64 = Buffer.from(response.data).toString('base64');
                            pendingImages.push({ mimetype: contentType, base64, caption });
                        }
                        sent++;
                    } catch (dlErr: any) {
                        logger.error(`Error descargando imagen ${i + 1} de ${baseName}: ${dlErr.message}`);
                    }
                }

                return JSON.stringify({
                    success: true,
                    message: `Se enviaron ${sent} imagen(es) de ${baseName}.`,
                    instructions_for_ai: 'Las imágenes ya fueron enviadas. Continúa tu respuesta de texto normalmente.'
                });
            }

            // ── Agendar cita en Google Calendar ────────────────────────
            case 'schedule_appointment': {
                const { client_name, city, date, time, appointment_type, property_reference, address, phone } = args as {
                    client_name: string;
                    city: string;
                    date: string;
                    time: string;
                    appointment_type: 'visita_compra' | 'visita_arriendo' | 'revision_venta';
                    property_reference?: string;
                    address?: string;
                    phone?: string;
                };

                // ── Validaciones de negocio iniciales ──
                const [year, month, day] = date.split('-').map(Number);
                const [hour, minute] = time.split(':').map(Number);

                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);

                const appointmentDate = new Date(year, month - 1, day);

                if (appointmentDate < tomorrow) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'La fecha solicitada es hoy o en el pasado. Dile al cliente que la cita más próxima disponible es mañana y pregúntale qué día le queda bien.'
                    });
                }
                if (hour < 14 || hour >= 18) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'La hora está fuera del rango permitido (2 PM – 6 PM). Dile al cliente el horario disponible y pregúntale qué hora dentro de ese rango le queda bien.'
                    });
                }
                if (!adminCalendarEmail) {
                    logger.warn(`schedule_appointment: sin adminCalendarEmail para storeId ${storeId}`);
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'No hay calendario configurado. Dile al cliente que un asesor de SIS Inmobiliaria lo contactará pronto para confirmar la cita.'
                    });
                }

                // ── Flujo con Google Calendar API ──
                try {
                    const keyFilePath = path.resolve(process.cwd(), 'firebase-key.json');
                    const auth = new google.auth.GoogleAuth({
                        keyFile: keyFilePath,
                        scopes: ['https://www.googleapis.com/auth/calendar'],
                    });
                    const calendar = google.calendar({ version: 'v3', auth });

                    const typeLabels: Record<string, string> = {
                        visita_compra: 'Visita de compra',
                        visita_arriendo: 'Visita de arriendo',
                        revision_venta: 'Revisión de propiedad para venta',
                    };

                    const startTime = new Date(year, month - 1, day, hour, minute);
                    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Duración fija: 1 hora

                    // ── VERIFICACIÓN DE DISPONIBILIDAD (Cruces de Horarios) ──
                    // Buscamos cualquier evento que se solape con el rango de la cita propuesta
                    const existingEvents = await calendar.events.list({
                        calendarId: adminCalendarEmail,
                        timeMin: startTime.toISOString(),
                        timeMax: endTime.toISOString(),
                        singleEvents: true,
                        maxResults: 1 // Con que encuentre 1 es suficiente para saber que está ocupado
                    });

                    if (existingEvents.data.items && existingEvents.data.items.length > 0) {
                        logger.warn(`Conflicto de horario detectado para la fecha ${date} a las ${time}`);
                        return JSON.stringify({
                            success: false,
                            error: 'Horario ocupado',
                            instructions_for_ai: `El horario de las ${time} del día ${date} ya está reservado por otra persona. Dile de forma muy amable al cliente que ese espacio no está disponible e invítalo a proponer otra hora (entre 2 PM y 6 PM) u otra fecha.`
                        });
                    }

                    // ── Crear evento si el horario está libre ──
                    await calendar.events.insert({
                        calendarId: adminCalendarEmail,
                        requestBody: {
                            summary: `${typeLabels[appointment_type]} (${city}) — ${client_name}`,
                            description: [
                                `Cliente: ${client_name}`,
                                `Ciudad: ${city}`,
                                phone ? `WhatsApp: ${phone}` : '',
                                property_reference ? `Propiedad: ${property_reference}` : '',
                                address ? `Dirección / referencia: ${address}` : '',
                                `Tipo: ${typeLabels[appointment_type]}`,
                                `Agendado automáticamente vía bot de WhatsApp — SIS Inmobiliaria`,
                            ].filter(Boolean).join('\n'),
                            start: { dateTime: startTime.toISOString(), timeZone: 'America/Bogota' },
                            end: { dateTime: endTime.toISOString(), timeZone: 'America/Bogota' },
                        },
                    });

                    const contactInfo = pqrEmail
                        ? `Si necesitas cambiar o cancelar, escríbenos al correo ${pqrEmail} o espera a que un asesor te contacte.`
                        : 'Si necesitas cambiar o cancelar, espera a que un asesor de SIS Inmobiliaria te contacte.';

                    return JSON.stringify({
                        success: true,
                        confirmed_date: date,
                        confirmed_time: time,
                        city: city,
                        contact_info: contactInfo,
                        instructions_for_ai: `La cita quedó registrada con éxito en la ciudad de ${city}. Confirma al cliente: fecha ${date}, hora ${time}, y dile: "${contactInfo}"`
                    });

                } catch (calErr: any) {
                    logger.error(`Error creando evento en Google Calendar:`, calErr.message);
                    if (calErr.response?.data) {
                        logger.error(`Detalles del error de Calendar API:`, JSON.stringify(calErr.response.data));
                    }
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Hubo un error técnico al registrar la cita. Dile al cliente que un asesor de SIS Inmobiliaria lo contactará pronto para confirmar la cita manualmente.'
                    });
                }
            }

            // ── Cerrar conversación ─────────────────────────────────────
            case 'close_conversation': {
                logger.info(`Cerrando conversación ${sessionId}: ${args.reason}`);
                if (sessionId && systemPrompt) {
                    await clearSession(sessionId, storeId, senderPhone, systemPrompt);
                }
                return JSON.stringify({
                    success: true,
                    instructions_for_ai: 'La conversación fue cerrada. Despídete amablemente y dile que puede escribir cuando quiera para una nueva consulta.'
                });
            }

            default:
                return JSON.stringify({ error: `Función "${name}" no reconocida.` });
        }

    } catch (error: any) {
        logger.error(`Error ejecutando tool ${name}: ${error.message}`);
        return JSON.stringify({ error: `Error inesperado al procesar "${name}". Intenta de nuevo.` });
    }
}