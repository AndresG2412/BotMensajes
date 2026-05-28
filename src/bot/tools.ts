import OpenAI from 'openai';
import { searchProducts, getProductById, getAllProducts, getProductRawImages } from '../data/catalog';
import { getOrderById } from '../data/orders';
import { clearSession } from '../data/database';
import { logger } from '../utils/logger';

// Cola temporal de imágenes pendientes para enviar al cliente
export type PendingImage = { mimetype: string; base64: string; caption?: string };
let pendingImages: PendingImage[] = [];

export function getPendingImages(): PendingImage[] {
    const images = [...pendingImages];
    pendingImages = [];
    return images;
}

function queueImage(base64DataUri: string, caption?: string) {
    // Parsear "data:image/jpeg;base64,/9j/4Q..." 
    const match = base64DataUri.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
        pendingImages.push({ mimetype: match[1], base64: match[2], caption });
    }
}

export const botTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'search_products',
            description: 'Busca productos en el catálogo de la tienda de acuerdo a una búsqueda (query). Retorna una lista de productos.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'El término de búsqueda (por ejemplo: "audífonos bluetooth", "bicicleta urbana").'
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
            description: 'Obtiene la lista completa de todos los productos disponibles en la tienda. Úsalo cuando el cliente pregunte "qué productos tienes" o si quieres ver todo el catálogo para recomendar algo.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_product_details',
            description: 'Obtiene toda la información (incluyendo stock, precio, descripciones, tallas) de un producto específico dado su ID.',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'El ID exacto del producto (por ejemplo: "audifonos-pro").'
                    }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_order_status',
            description: 'Consulta el estado de un pedido del cliente usando el ID de la orden.',
            parameters: {
                type: 'object',
                properties: {
                    order_id: {
                        type: 'string',
                        description: 'El número de orden. Ejemplo: "ORD-12345".'
                    }
                },
                required: ['order_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'generate_payment_link',
            description: 'Genera un link de pago seguro (Stripe/MercadoPago) para un producto. Úsalo SÓLO cuando el cliente quiera pagar con tarjeta.',
            parameters: {
                type: 'object',
                properties: {
                    product_id: {
                        type: 'string',
                        description: 'El ID del producto a comprar.'
                    }
                },
                required: ['product_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'close_conversation',
            description: 'Cierra y reinicia la conversación actual. Úsalo ÚNICAMENTE cuando el cliente indique claramente que ha terminado, se despida ("gracias, eso es todo", "adiós", "ya no necesito nada más", "chao", etc.), o confirme que no necesita más ayuda. NO lo uses si el cliente solo dice "gracias" en medio de la conversación mientras sigue haciendo preguntas.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Razón breve del cierre (ej: "cliente se despidió", "compra completada").'
                    }
                },
                required: ['reason']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_product_image',
            description: 'Envía la imagen de un producto al cliente por WhatsApp. Úsalo cuando el cliente pida ver un producto, pregunte cómo se ve, o cuando le estés recomendando algo y quieras mostrarle la foto. Puedes usarlo junto con tu respuesta de texto.',
            parameters: {
                type: 'object',
                properties: {
                    product_id: {
                        type: 'string',
                        description: 'El ID del producto cuya imagen quieres enviar.'
                    }
                },
                required: ['product_id']
            }
        }
    }
];

export async function executeTool(name: string, args: any, storeId: string, senderPhone: string, sessionId?: string, systemPrompt?: string): Promise<string> {
    logger.info(`Ejecutando tool: ${name}`, args);
    try {
        switch (name) {
            case 'search_products':
                const products = await searchProducts(args.query, storeId);
                if (products.length === 0) {
                    const allProd = await getAllProducts(storeId);
                    if (allProd.length > 0) {
                        return JSON.stringify({ 
                            nota: "No hay coincidencias exactas para esa palabra, pero aquí tienes otros productos disponibles en la tienda para que analices si alguno le sirve:", 
                            productos: allProd.slice(0, 10) 
                        });
                    }
                    return JSON.stringify({ error: "No se encontraron productos y el catálogo está vacío." });
                }
                return JSON.stringify(products);
                
            case 'list_all_products':
                const all = await getAllProducts(storeId);
                return JSON.stringify(all);
            
            case 'get_product_details':
                const product = await getProductById(args.id, storeId);
                if (!product) return JSON.stringify({ error: "No se encontró el producto con ese ID." });
                return JSON.stringify(product);
 
            case 'get_order_status':
                const order = await getOrderById(args.order_id, senderPhone);
                if (!order) return JSON.stringify({ error: "No se encontró la orden con ese ID o no pertenece a tu número de teléfono." });
                return JSON.stringify(order);
 
            case 'generate_payment_link':
                // Simulamos un enlace seguro de Stripe o MercadoPago para cumplir con PCI-DSS
                return JSON.stringify({
                    success: true,
                    link: `https://pagos.mitienda.com/checkout-seguro?item=${args.product_id}&gateway=stripe`,
                    instructions_for_ai: "IMPORTANTE: NO expliques el proceso de pago paso a paso. Envía EXACTAMENTE este aviso al cliente, sin modificarlo: '⚠️ Aviso importante sobre el pago: El proceso de pago se realiza en nuestra plataforma segura. Haz clic en el enlace y sigue las instrucciones que aparecen en pantalla. Por tu seguridad, NUNCA compartas los datos de tu tarjeta por este chat. Si tienes problemas con el pago, contáctanos por este mismo medio y te ayudaremos. 🔒'"
                });

            case 'send_product_image':
                try {
                    const images = await getProductRawImages(args.product_id, storeId);
                    if (!images || images.length === 0) {
                        return JSON.stringify({ success: false, error: 'Esta propiedad no tiene imágenes disponibles.' });
                    }
                    const product_info = await getProductById(args.product_id, storeId);
                    const baseName = product_info ? product_info.name : 'Propiedad';
                    
                    const axios = (await import('axios')).default;
                    let sent = 0;
                    
                    for (let i = 0; i < images.length; i++) {
                        const imageUrl = images[i];
                        const caption = i === 0 ? `📸 ${baseName} (${images.length} fotos)` : undefined;
                        try {
                            if (imageUrl.startsWith('data:')) {
                                queueImage(imageUrl, caption);
                            } else {
                                const response = await axios.get(imageUrl, { 
                                    responseType: 'arraybuffer',
                                    timeout: 15000 
                                });
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
                        message: `Se enviaron ${sent} imagen(es) de ${baseName} al cliente.`,
                        instructions_for_ai: 'Las imágenes ya fueron enviadas al cliente. Continúa tu respuesta de texto normalmente, no necesitas describir las imágenes.'
                    });
                } catch (imgErr: any) {
                    logger.error(`Error enviando imágenes de propiedad: ${imgErr.message}`);
                    return JSON.stringify({ success: false, error: 'No se pudieron enviar las imágenes de la propiedad.' });
                }

            case 'close_conversation':
                logger.info(`Cerrando conversación ${sessionId}: ${args.reason}`);
                if (sessionId && systemPrompt) {
                    await clearSession(sessionId, storeId, senderPhone, systemPrompt);
                }
                return JSON.stringify({
                    success: true,
                    message: 'Conversación cerrada exitosamente.',
                    instructions_for_ai: 'La conversación ha sido reiniciada. Despídete amablemente del cliente y dile que puede escribir cuando quiera para una nueva consulta.'
                });

            default:
                return JSON.stringify({ error: "Función no reconocida." });
        }
    } catch (error: any) {
        logger.error(`Error ejecutando la tool ${name}: ${error.message}`);
        return JSON.stringify({ error: `Hubo un error inesperado al procesar la tool ${name}` });
    }
}
