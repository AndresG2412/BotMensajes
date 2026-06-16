import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

async function runMigration() {
    console.log('Iniciando migracion a SQLite...');
    const dataDir = path.join(process.cwd(), 'data');
    const dbFile = path.join(dataDir, 'database.sqlite');
    
    const sqlite = new Database(dbFile);
    const db = drizzle(sqlite);

    console.log('Ejecutando script de migracion...');
    try {
        await migrate(db, { migrationsFolder: path.join(__dirname, 'drizzle') });
        console.log('Migracion exitosa! Las tablas fueron creadas o actualizadas.');
    } catch (error) {
        console.error('Error durante la migracion:', error);
    } finally {
        sqlite.close();
        process.exit(0);
    }
}

runMigration();
