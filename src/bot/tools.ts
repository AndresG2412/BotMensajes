import OpenAI from 'openai';
import { searchProducts, getProductById, getAllProducts, getProductRawImages, getProductsFiltered, getAlternativeProducts } from '../data/catalog';
import { clearSession, getSession, setSessionAppointmentFlag, checkPendingAppointment, saveAppointment } from '../data/database';
import { google } from 'googleapis';
import { logger } from '../utils/logger';
import { sendAppointmentNotification } from '../utils/mailer';
import axios from 'axios';
import path from 'path';

// ─────────────────────────────────────────
//  Cola temporal de imágenes pendientes
// ─────────────────────────────────────────
export type PendingImage = { mimetype: string; base64: string; caption?: string };
const pendingImagesMap = new Map<string, PendingImage[]>();

export function getPendingImages(sessionId: string): PendingImage[] {
    const images = pendingImagesMap.get(sessionId) || [];
    pendingImagesMap.delete(sessionId);
    return images;
}

function queueImage(sessionId: string, base64DataUri: string, caption?: string) {
    const match = base64DataUri.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
        if (!pendingImagesMap.has(sessionId)) {
            pendingImagesMap.set(sessionId, []);
        }
        pendingImagesMap.get(sessionId)!.push({ mimetype: match[1], base64: match[2], caption });
    }
}

// ─────────────────────────────────────────
//  Helper: resumen breve de propiedades para el modelo
// ─────────────────────────────────────────
function summarizeProducts(products: any[], max = 5) {
    return products.slice(0, max).map(p => ({
        id: p.id,
        nombre: p.name,
        ciudad: p.ciudad,
        tipo: p.tipo_propiedad,
        precio: p.price,
        habitaciones: p.habitaciones,
        baños: p.baños,
        metros: p.metros_cuadrados,
        descripcion: p.description,
        referencia: p.referencia,
    }));
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
                'SOLO llama esta función cuando el cliente haya proporcionado TODOS los datos requeridos según el tipo de cita.',
                'REGLAS ESTRICTAS:',
                '- La fecha y hora deben ser proporcionadas directamente por el cliente.',
                '- La fecha debe ser MÍNIMO el día siguiente al de hoy.',
                '- La hora de inicio debe ser en punto (ej: 13:00, 14:00, 15:00, 16:00, 17:00) entre la 1:00 PM (13:00) y las 5:00 PM (17:00) inclusive. NUNCA permitas minutos (como 14:30 o 15:15).',
                '- NUNCA modifiques ni canceles citas existentes. Solo crea nuevas.',
                '- NUNCA reveles información de citas de otros clientes ni de sus fechas.',
                '',
                'PARA VISITA DE ARRIENDO (visita_arriendo) O COMPRA (visita_compra):',
                '- Solo necesitas del cliente: client_name, phone, date y time.',
                '- city y address los tomas TÚ MISMO de los datos de la propiedad que el cliente eligió del catálogo (usa la ciudad y el nombre/referencia de la propiedad). NUNCA le preguntes la ciudad ni la dirección al cliente.',
                '- property_reference es OBLIGATORIO: pon el nombre o referencia de la propiedad del catálogo.',
                '',
                'PARA REVISIÓN DE VENTA (revision_venta):',
                '- Necesitas del cliente: client_name, phone, date, time, city y address (porque es la propiedad del cliente y no está en el catálogo).',
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
                        description: 'Ciudad donde está la propiedad. Para visita_arriendo/visita_compra: usa la ciudad de la propiedad del catálogo (NO preguntes al cliente). Para revision_venta: pídela al cliente.'
                    },
                    date: {
                        type: 'string',
                        description: 'Fecha en formato YYYY-MM-DD. Debe ser mínimo mañana.'
                    },
                    time: {
                        type: 'string',
                        description: 'Hora en formato HH:MM (24h). Debe estar entre 13:00 y 17:00, y los minutos deben ser 00 (horas en punto).'
                    },
                    appointment_type: {
                        type: 'string',
                        enum: ['visita_compra', 'visita_arriendo', 'revision_venta'],
                        description: 'Tipo: visita para comprar, visita para arrendar, o revisión de propiedad para venta.'
                    },
                    property_reference: {
                        type: 'string',
                        description: 'Referencia o nombre de la propiedad del catálogo a visitar. OBLIGATORIO para visita_arriendo y visita_compra.'
                    },
                    address: {
                        type: 'string',
                        description: 'Dirección o punto de referencia. Para visita_arriendo/visita_compra: usa la referencia/nombre de la propiedad del catálogo (NO preguntes al cliente). Para revision_venta: pídela al cliente.'
                    },
                    phone: {
                        type: 'string',
                        description: 'Número de WhatsApp o de contacto del cliente.'
                    }
                },
                required: ['client_name', 'phone', 'date', 'time', 'appointment_type']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'filter_rental_properties',
            description: 'Busca propiedades en arriendo filtrando por categoría de arriendo, ciudad, tipo de propiedad (casa, apartamento, lote) y presupuesto máximo mensual. Úsalo después de recopilar ciudad, presupuesto y tipo en el FLUJO C.',
            parameters: {
                type: 'object',
                properties: {
                    categoriaId: {
                        type: 'string',
                        description: 'ID de la categoría de arriendo tal como está en Firebase. Usa el ID exacto que corresponde a arriendo según el contexto de categorías inyectado en el prompt.'
                    },
                    ciudad: {
                        type: 'string',
                        description: 'Ciudad donde el cliente busca arrendar. Ej: "Pitalito", "San Agustín", "Timaná".'
                    },
                    tipo_propiedad: {
                        type: 'string',
                        description: 'Tipo de propiedad: "casa", "apartamento" o "lote".'
                    },
                    presupuesto_max: {
                        type: 'number',
                        description: 'Presupuesto máximo mensual del cliente en pesos colombianos. Ej: 800000. Si no mencionó cifra exacta, usa 0.'
                    }
                },
                required: ['categoriaId']
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
    },
    {
        type: 'function',
        function: {
            name: 'filter_sale_properties',
            description: 'Busca propiedades en venta o lotes filtrando por categoría, ciudad, tipo de propiedad (casa, apartamento, lote, comercio) y presupuesto máximo. Úsalo en el FLUJO B después de recopilar ciudad, presupuesto y tipo del cliente.',
            parameters: {
                type: 'object',
                properties: {
                    categoriaId: {
                        type: 'string',
                        description: 'ID de la categoría a buscar según las CATEGORÍAS DISPONIBLES inyectadas. Para propiedades generales usa el ID correspondiente; para lotes etapa 1 usa su ID; para lotes etapa 2 y 3 usa su ID. NUNCA inventes un categoriaId.'
                    },
                    ciudad: {
                        type: 'string',
                        description: 'Ciudad donde el cliente busca. Ej: "Pitalito", "San Agustín", "Timaná".'
                    },
                    tipo_propiedad: {
                        type: 'string',
                        description: 'Tipo de propiedad: "casa", "apartamento", "lote" o "comercio".'
                    },
                    presupuesto_max: {
                        type: 'number',
                        description: 'Presupuesto máximo del cliente en pesos colombianos. Usa 0 si no lo mencionó.'
                    }
                },
                required: ['categoriaId']
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
                        const sessionKey = sessionId || senderPhone || 'default';
                        if (imageUrl.startsWith('data:')) {
                            queueImage(sessionKey, imageUrl, caption);
                        } else {
                            const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
                            const contentType = response.headers['content-type'] || 'image/jpeg';
                            const base64 = Buffer.from(response.data).toString('base64');
                            if (!pendingImagesMap.has(sessionKey)) {
                                pendingImagesMap.set(sessionKey, []);
                            }
                            pendingImagesMap.get(sessionKey)!.push({ mimetype: contentType, base64, caption });
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

            // ── Filtrar propiedades en arriendo ────────────────────────
            case 'filter_rental_properties': {
                const { categoriaId, ciudad, tipo_propiedad, presupuesto_max } = args as {
                    categoriaId: string;
                    ciudad?: string;
                    tipo_propiedad?: string;
                    presupuesto_max?: number;
                };

                const results = await getProductsFiltered({
                    categoriaId,
                    ciudad: ciudad?.trim() || undefined,
                    tipo_propiedad: tipo_propiedad?.trim() || undefined,
                    presupuestoMax: presupuesto_max || 0,
                });

                if (results.length > 0) {
                    return JSON.stringify({
                        encontradas: results.length,
                        propiedades: summarizeProducts(results),
                        instrucciones: 'Presenta al cliente máximo 3 opciones de forma breve y vendedora. Para cada una menciona nombre/referencia, ciudad, tipo, precio mensual y 1 o 2 características que la hagan atractiva. Ofrece enviar fotos con send_product_image. Si le interesa visitar alguna, sigue el FLUJO CITA. Cierra siempre invitando a dar el siguiente paso.'
                    });
                }

                // ── Sin match exacto: buscar alternativas para hacer cross-sell ──
                const alt = await getAlternativeProducts({
                    categoriaId,
                    ciudad: ciudad?.trim() || undefined,
                    tipo_propiedad: tipo_propiedad?.trim() || undefined,
                });

                // Hay propiedades en la ciudad pero el tipo/presupuesto no coincidió
                if (alt.porCiudad.length > 0) {
                    return JSON.stringify({
                        encontradas: 0,
                        alternativas: summarizeProducts(alt.porCiudad),
                        instrucciones: `No hay arriendo exacto del tipo "${tipo_propiedad || ''}" o presupuesto pedido en ${ciudad || 'esa ciudad'}, pero SÍ hay otras opciones en ${ciudad}. Preséntalas como alternativa atractiva (máximo 3) y pregunta si le interesa alguna. NO ofrezcas avisar después: vende lo que hay ahora.`
                    });
                }

                // No hay en esa ciudad, pero sí en otras → cross-sell de ciudad
                if (alt.enCategoria.length > 0) {
                    return JSON.stringify({
                        encontradas: 0,
                        ciudades_disponibles: alt.ciudadesDisponibles,
                        alternativas: summarizeProducts(alt.enCategoria),
                        instrucciones: `Por ahora no hay arriendo en ${ciudad || 'esa ciudad'}. NO digas que avisarás luego (esa función no existe). En su lugar, dile con naturalidad que sí tienes disponibles en ${alt.ciudadesDisponibles.join(', ')} y ofrécele esas opciones (máximo 3) por si le sirven. Sé un buen vendedor: muestra lo disponible y abre la puerta a una visita.`
                    });
                }

                // Catálogo de arriendo realmente vacío
                return JSON.stringify({
                    encontradas: 0,
                    instrucciones: 'No hay ninguna propiedad en arriendo cargada en el catálogo en este momento. Dile al cliente de forma honesta y amable que ahora mismo no tienes arriendos disponibles, e invítalo a contarte si también consideraría comprar, donde sí hay opciones.'
                });
            }

            // ── Filtrar propiedades en venta ────────────────────────────
            case 'filter_sale_properties': {
                const { categoriaId, ciudad, tipo_propiedad, presupuesto_max } = args as {
                    categoriaId: string;
                    ciudad?: string;
                    tipo_propiedad?: string;
                    presupuesto_max?: number;
                };

                const results = await getProductsFiltered({
                    categoriaId,
                    ciudad: ciudad?.trim() || undefined,
                    tipo_propiedad: tipo_propiedad?.trim() || undefined,
                    presupuestoMax: presupuesto_max || 0,
                });

                if (results.length > 0) {
                    return JSON.stringify({
                        encontradas: results.length,
                        propiedades: summarizeProducts(results),
                        instrucciones: 'Presenta al cliente máximo 3 opciones de forma breve y vendedora. Para cada una menciona nombre/referencia, ciudad, tipo, precio de venta y 1 o 2 características atractivas. Ofrece enviar fotos con send_product_image. Si le interesa visitar alguna, inicia el FLUJO CITA. Cierra invitando a agendar la visita.'
                    });
                }

                // ── Sin match exacto: alternativas para cross-sell ──
                const alt = await getAlternativeProducts({
                    categoriaId,
                    ciudad: ciudad?.trim() || undefined,
                    tipo_propiedad: tipo_propiedad?.trim() || undefined,
                });

                if (alt.porCiudad.length > 0) {
                    return JSON.stringify({
                        encontradas: 0,
                        alternativas: summarizeProducts(alt.porCiudad),
                        instrucciones: `No hay venta exacta del tipo "${tipo_propiedad || ''}" o presupuesto pedido en ${ciudad || 'esa ciudad'}, pero SÍ hay otras opciones en ${ciudad}. Preséntalas como alternativa (máximo 3) y pregunta si le interesa alguna. NO ofrezcas avisar después: vende lo que hay.`
                    });
                }

                if (alt.enCategoria.length > 0) {
                    return JSON.stringify({
                        encontradas: 0,
                        ciudades_disponibles: alt.ciudadesDisponibles,
                        alternativas: summarizeProducts(alt.enCategoria),
                        instrucciones: `Por ahora no hay venta en ${ciudad || 'esa ciudad'} con esos criterios. NO digas que avisarás luego (esa función no existe). En su lugar, dile que sí tienes disponibles en ${alt.ciudadesDisponibles.join(', ')} y ofrécele esas opciones (máximo 3). Sé buen vendedor: muestra lo disponible y propón una visita.`
                    });
                }

                return JSON.stringify({
                    encontradas: 0,
                    instrucciones: 'No hay propiedades de esa categoría cargadas en el catálogo en este momento. Dile al cliente de forma honesta y amable, y ofrécele explorar otra categoría o tipo de propiedad disponible.'
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

                // ── Validar campos según tipo de cita ──
                const isPropertyVisit = appointment_type === 'visita_arriendo' || appointment_type === 'visita_compra';

                // Para visitas de arriendo/compra, city y address son opcionales (se auto-rellenan desde la propiedad)
                const effectiveCity = city?.trim() || (isPropertyVisit ? (property_reference || 'Por definir') : '');
                const effectiveAddress = address?.trim() || (isPropertyVisit ? (property_reference || 'Propiedad del catálogo') : '');

                if (
                    !client_name || !client_name.trim() ||
                    !date || !date.trim() ||
                    !time || !time.trim() ||
                    !appointment_type || !appointment_type.trim() ||
                    !phone || !phone.trim()
                ) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Faltan datos obligatorios para poder agendar la cita. Asegúrate de tener: nombre completo, teléfono de contacto de 10 dígitos, fecha y hora de la cita.'
                    });
                }

                // Para revision_venta, city y address son obligatorios (el cliente los debe dar)
                if (!isPropertyVisit && (!effectiveCity || !effectiveAddress)) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Para una revisión de venta necesitas la ciudad y dirección del inmueble del cliente. Pídele amablemente esos datos.'
                    });
                }

                // Para visitas de arriendo/compra, property_reference es obligatorio
                if (isPropertyVisit && (!property_reference || !property_reference.trim())) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'Para agendar una visita de arriendo o compra debes incluir la referencia de la propiedad del catálogo que el cliente quiere visitar. Revisa la conversación y usa el nombre o ID de la propiedad que el cliente eligió.'
                    });
                }

                // ── Validar que el número de teléfono sea válido (10 dígitos colombianos) ──
                const cleanPhone = phone.replace(/\D/g, '');
                const normalizedPhone = (cleanPhone.startsWith('57') && cleanPhone.length === 12)
                    ? cleanPhone.slice(2)
                    : cleanPhone;

                if (normalizedPhone.length !== 10) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'El número de teléfono proporcionado no es válido. Debe ser un número de celular de 10 dígitos (por ejemplo, 3123456789). Dile al cliente que por favor proporcione un número de celular válido de 10 dígitos para continuar.'
                    });
                }

                // ── Verificar si ya hay una cita agendada en la base de datos o en la sesión ──
                if (sessionId) {
                    const hasApp = await checkPendingAppointment(storeId, senderPhone);
                    if (hasApp) {
                        const email = pqrEmail || adminCalendarEmail || 'el correo del administrador';
                        return JSON.stringify({
                            success: false,
                            error: 'Cita ya agendada previamente',
                            instructions_for_ai: `Ya existe una cita agendada previamente en este chat. No puedes agendar otra ni modificarla. Dile al cliente de forma muy amable que para cambiar, cancelar o agendar de nuevo debe contactar al correo del administrador: ${email}`
                        });
                    }
                }

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
                if (hour < 13 || hour > 17 || minute !== 0) {
                    return JSON.stringify({
                        success: false,
                        instructions_for_ai: 'La hora solicitada no es válida. Las citas se programan únicamente en horas exactas (13:00, 14:00, 15:00, 16:00, 17:00) y la última cita disponible para iniciar es a las 5:00 PM (17:00). Dile de forma amable al cliente que por favor proporcione una hora en punto (ej. 2:00 PM o 14:00) dentro de este rango.'
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
                            instructions_for_ai: `El horario de las ${time} del día ${date} ya está reservado por otra persona. Dile de forma muy amable al cliente que ese espacio no está disponible e invítalo a proponer otra hora (en punto entre la 1:00 PM y las 5:00 PM) u otra fecha.`
                        });
                    }

                    // ── Crear evento si el horario está libre ──
                    await calendar.events.insert({
                        calendarId: adminCalendarEmail,
                        requestBody: {
                            summary: `${typeLabels[appointment_type]} (${effectiveCity}) — ${client_name}`,
                            description: [
                                `Cliente: ${client_name}`,
                                `Ciudad: ${effectiveCity}`,
                                phone ? `WhatsApp: ${phone}` : '',
                                property_reference ? `Propiedad: ${property_reference}` : '',
                                effectiveAddress ? `Dirección / referencia: ${effectiveAddress}` : '',
                                `Tipo: ${typeLabels[appointment_type]}`,
                                `Agendado automáticamente vía bot de WhatsApp — SIS Inmobiliaria`,
                            ].filter(Boolean).join('\n'),
                            start: { dateTime: startTime.toISOString(), timeZone: 'America/Bogota' },
                            end: { dateTime: endTime.toISOString(), timeZone: 'America/Bogota' },
                        },
                    });

                    // ── Notificar al administrador por correo ──
                    sendAppointmentNotification({
                        adminEmail: adminCalendarEmail,
                        clientName: client_name,
                        city: effectiveCity,
                        date,
                        time,
                        appointmentType: appointment_type,
                        phone,
                        propertyReference: property_reference,
                        address: effectiveAddress,
                    });

                    // ── Guardar flag de cita agendada en la sesión y base de datos ──
                    if (sessionId) {
                        await setSessionAppointmentFlag(sessionId, true);
                        await saveAppointment(storeId, senderPhone, {
                            clientName: client_name,
                            city: effectiveCity,
                            date,
                            time,
                            appointmentType: appointment_type,
                            propertyReference: property_reference || '',
                            address: effectiveAddress || '',
                            phone: phone || '',
                            status: 'scheduled',
                            createdAt: new Date()
                        });
                    }

                    const contactInfo = pqrEmail
                        ? `Si necesitas cambiar o cancelar, escríbenos al correo ${pqrEmail} o espera a que un asesor te contacte.`
                        : 'Si necesitas cambiar o cancelar, espera a que un asesor de SIS Inmobiliaria te contacte.';

                    return JSON.stringify({
                        success: true,
                        confirmed_date: date,
                        confirmed_time: time,
                        city: effectiveCity,
                        contact_info: contactInfo,
                        instructions_for_ai: `La cita quedó registrada con éxito en la ciudad de ${effectiveCity}. Confirma al cliente: fecha ${date}, hora ${time}, y dile: "${contactInfo}"`
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