import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import * as schema from './schema';

export type Db = DrizzleSqliteDODatabase<typeof schema>;

/** Opens a Durable Object's database and brings its schema up to date. */
export async function openDb(storage: DurableObjectStorage): Promise<Db> {
  discardBootstrapSchema(storage);
  const db = drizzle(storage, { schema });
  await migrate(db, migrations);
  return db;
}

/**
 * Before Drizzle, a hand-written runner created the schema and recorded it in
 * schema_migrations. Drizzle cannot adopt that schema, so an object that still holds it
 * drops it, with its demo data, and migrates from scratch. Remove once every object has
 * started on Drizzle.
 */
function discardBootstrapSchema(storage: DurableObjectStorage): void {
  const legacy = storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .toArray().length;
  if (!legacy) return;
  storage.transactionSync(() => {
    storage.sql.exec('DROP TABLE IF EXISTS work_items');
    storage.sql.exec('DROP TABLE schema_migrations');
  });
}
