import { firebaseAdmin } from '../config/firebase';
import { logger } from '../utils/logger';

export type Product = {
    id: string;
    storeId: string;
    name: string;          // barrio + referencia
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

    const description = [
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
        name: barrio ? `${barrio} — ${referencia}` : referencia,
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

export async function getAllProducts(storeId?: string): Promise<Product[]> {
    if (!firebaseAdmin) return [];
    try {
        const db = firebaseAdmin.firestore();
        const snapshot = await db.collection('Propiedades').get();
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
        };
        await db.collection('Propiedades').doc(id).set(newProduct);
        return { id, storeId, name: id, description: '', productType: 'propiedad', imageUrl: '', checkoutUrl: '', ...newProduct, price: newProduct.precio, imagenes: newProduct.Imagenes, folderCloudinary: newProduct.FolderCloudinary };
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