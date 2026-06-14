import { firebaseAdmin } from '../config/firebase';
import { logger } from '../utils/logger';

export type Categoria = {
    id: string;
    nombre: string;
};

export async function getAllCategorias(): Promise<Categoria[]> {
    if (!firebaseAdmin) return [];
    try {
        const db = firebaseAdmin.firestore();
        const snapshot = await db.collection('Categorias').get();
        if (snapshot.empty) {
            logger.info('Collection "Categorias" is empty. Seeding initial categories...');
            const initialCats = [
                { id: 'generales', nombre: 'Propiedades Generales' },
                { id: 'lotes_1', nombre: 'Lotes Etapa 1' },
                { id: 'lotes_2_3', nombre: 'Lotes Etapa 2 y 3' }
            ];
            for (const cat of initialCats) {
                await db.collection('Categorias').doc(cat.id).set(cat);
            }
            return initialCats;
        }
        return snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                nombre: data.nombre || doc.id
            };
        });
    } catch (e) {
        logger.error(`Error getting all categories: ${e}`);
        return [];
    }
}

export async function createCategoria(nombre: string): Promise<Categoria | null> {
    if (!firebaseAdmin) return null;
    try {
        const db = firebaseAdmin.firestore();
        const id = nombre.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)+/g, '');
        const finalId = id || `cat_${Date.now()}`;
        const newCat = { id: finalId, nombre };
        await db.collection('Categorias').doc(finalId).set(newCat);
        return newCat;
    } catch (e) {
        logger.error(`Error creating category: ${e}`);
        return null;
    }
}

export type Product = {
    id: string;
    storeId: string;
    nombre: string;
    name: string;          // nombre real
    description: string;   // características formateadas
    productType: string;   // siempre 'propiedad'
    price: number;         // precio
    imageUrl: string;      // primera imagen
    checkoutUrl: string;   // vacío por ahora
    // Campos específicos de propiedades
    barrio: string;
    baños: string;
    caracteristicas: string[];
    ciudad: string;
    habitaciones: number;
    metros_cuadrados: number;
    pisos: number;
    referencia: string;
    imagenes: string[];
    folderCloudinary: string;
    tipo_propiedad: string;
    categoriaId: string;
};

export async function searchProducts(query: string, storeId: string): Promise<Product[]> {
    const products = await getAllProducts(storeId);
    const lowerQuery = query.toLowerCase();
    return products.filter(p =>
        p.name.toLowerCase().includes(lowerQuery) ||
        p.description.toLowerCase().includes(lowerQuery) ||
        p.ciudad.toLowerCase().includes(lowerQuery) ||
        p.barrio.toLowerCase().includes(lowerQuery) ||
        p.caracteristicas.some(c => c.toLowerCase().includes(lowerQuery))
    ).slice(0, 5);
}

function mapDocToProduct(doc: FirebaseFirestore.DocumentSnapshot): Product {
    const data = doc.data() || {};
    const barrio = data.barrio || '';
    const referencia = data.referencia || doc.id;
    const imagenes: string[] = Array.isArray(data.Imagenes) ? data.Imagenes : [];
    const caracteristicas: string[] = Array.isArray(data.caracteristicas) ? data.caracteristicas : [];
    const nombre = data.nombre || data.name || (barrio ? `${barrio} — ${referencia}` : referencia);

    const description = [
        data.tipo_propiedad ? `Tipo de propiedad: ${data.tipo_propiedad}` : '',
        data.ciudad ? `Ciudad: ${data.ciudad}` : '',
        data.habitaciones ? `Habitaciones: ${data.habitaciones}` : '',
        data.baños ? `Baños: ${data.baños}` : '',
        data.metros_cuadrados ? `Metros cuadrados: ${data.metros_cuadrados}` : '',
        data.pisos ? `Pisos: ${data.pisos}` : '',
        caracteristicas.length > 0 ? `Características: ${caracteristicas.join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    return {
        id: doc.id,
        storeId: data.storeId || 'default',
        nombre,
        name: nombre,
        description,
        productType: 'propiedad',
        price: data.precio || 0,
        imageUrl: imagenes[0] || '',
        checkoutUrl: data.checkoutUrl || '',
        barrio,
        baños: data.baños || '',
        caracteristicas,
        ciudad: data.ciudad || '',
        habitaciones: data.habitaciones || 0,
        metros_cuadrados: data.metros_cuadrados || 0,
        pisos: data.pisos || 0,
        referencia,
        imagenes,
        folderCloudinary: data.FolderCloudinary || '',
        tipo_propiedad: data.tipo_propiedad || '',
        categoriaId: data.categoriaId || 'generales',
    };
}

export async function getProductById(id: string, storeId: string): Promise<Product | null> {
    if (!firebaseAdmin) return null;
    try {
        const db = firebaseAdmin.firestore();
        const doc = await db.collection('Propiedades').doc(id).get();
        if (!doc.exists) return null;
        return mapDocToProduct(doc);
    } catch (e) {
        logger.error(`Error getting product by id: ${e}`);
        return null;
    }
}

export async function getProductRawImages(id: string, storeId: string): Promise<string[]> {
    if (!firebaseAdmin) return [];
    try {
        const db = firebaseAdmin.firestore();
        const doc = await db.collection('Propiedades').doc(id).get();
        if (!doc.exists) return [];
        const data = doc.data() || {};
        if (Array.isArray(data.Imagenes) && data.Imagenes.length > 0) return data.Imagenes;
        return [];
    } catch (e) {
        logger.error(`Error getting product images: ${e}`);
        return [];
    }
}

export async function getAllProducts(storeId?: string, categoriaId?: string): Promise<Product[]> {
    if (!firebaseAdmin) return [];
    try {
        const db = firebaseAdmin.firestore();
        let query: FirebaseFirestore.Query = db.collection('Propiedades');
        if (categoriaId) {
            query = query.where('categoriaId', '==', categoriaId);
        }
        const snapshot = await query.get();
        return snapshot.docs.map(doc => mapDocToProduct(doc));
    } catch (e) {
        logger.error(`Error getting all products: ${e}`);
        return [];
    }
}

// Las funciones de escritura se mantienen pero no se usan desde el bot
export async function createProduct(product: Partial<Product>, storeId: string): Promise<Product | null> {
    if (!firebaseAdmin) return null;
    const id = product.referencia || product.id || 'SIS0000';
    try {
        const db = firebaseAdmin.firestore();
        const newProduct = {
            nombre: product.nombre || product.name || '',
            barrio: product.barrio || '',
            baños: product.baños || '',
            caracteristicas: product.caracteristicas || [],
            ciudad: product.ciudad || '',
            habitaciones: product.habitaciones || 0,
            metros_cuadrados: product.metros_cuadrados || 0,
            pisos: product.pisos || 0,
            precio: product.price || 0,
            referencia: product.referencia || id,
            Imagenes: product.imagenes || [],
            FolderCloudinary: product.folderCloudinary || '',
            tipo_propiedad: product.tipo_propiedad || '',
            categoriaId: product.categoriaId || 'generales',
        };
        await db.collection('Propiedades').doc(id).set(newProduct);
        return { id, storeId, name: newProduct.nombre, description: '', productType: 'propiedad', imageUrl: '', checkoutUrl: '', ...newProduct, price: newProduct.precio, imagenes: newProduct.Imagenes, folderCloudinary: newProduct.FolderCloudinary };
    } catch (e) {
        logger.error(`Error creating product: ${e}`);
        return null;
    }
}

export async function updateProduct(id: string, updates: Partial<Product>, storeId: string): Promise<Product | null> {
    if (!firebaseAdmin) return null;
    try {
        const db = firebaseAdmin.firestore();
        const docRef = db.collection('Propiedades').doc(id);
        const doc = await docRef.get();
        if (!doc.exists) return null;

        const dbUpdates: any = {};
        if (updates.nombre !== undefined) dbUpdates.nombre = updates.nombre;
        if (updates.name !== undefined) dbUpdates.nombre = updates.nombre || updates.name;
        if (updates.barrio !== undefined) dbUpdates.barrio = updates.barrio;
        if (updates.baños !== undefined) dbUpdates.baños = updates.baños;
        if (updates.caracteristicas !== undefined) dbUpdates.caracteristicas = updates.caracteristicas;
        if (updates.ciudad !== undefined) dbUpdates.ciudad = updates.ciudad;
        if (updates.habitaciones !== undefined) dbUpdates.habitaciones = updates.habitaciones;
        if (updates.metros_cuadrados !== undefined) dbUpdates.metros_cuadrados = updates.metros_cuadrados;
        if (updates.pisos !== undefined) dbUpdates.pisos = updates.pisos;
        if (updates.price !== undefined) dbUpdates.precio = updates.price;
        if (updates.referencia !== undefined) dbUpdates.referencia = updates.referencia;
        if (updates.imagenes !== undefined) dbUpdates.Imagenes = updates.imagenes;
        if (updates.folderCloudinary !== undefined) dbUpdates.FolderCloudinary = updates.folderCloudinary;
        if (updates.checkoutUrl !== undefined) dbUpdates.checkoutUrl = updates.checkoutUrl;
        if (updates.tipo_propiedad !== undefined) dbUpdates.tipo_propiedad = updates.tipo_propiedad;
        if (updates.categoriaId !== undefined) dbUpdates.categoriaId = updates.categoriaId;

        logger.info(`Firestore updating product ${id} with: ${JSON.stringify(dbUpdates)}`);
        await docRef.update(dbUpdates);
        const updated = await docRef.get();
        return mapDocToProduct(updated);
    } catch (e) {
        logger.error(`Error updating product: ${e}`);
        return null;
    }
}

export async function deleteProduct(id: string, storeId: string): Promise<boolean> {
    if (!firebaseAdmin) return false;
    try {
        const db = firebaseAdmin.firestore();
        await db.collection('Propiedades').doc(id).delete();
        return true;
    } catch (e) {
        logger.error(`Error deleting product: ${e}`);
        return false;
    }
}