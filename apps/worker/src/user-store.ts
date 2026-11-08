import { DurableObject } from 'cloudflare:workers';
import {
  entities,
  write,
  type ChangeOf,
  type Checked,
  type CodeOf,
  type Entity,
  type EntityOf,
  type Kind,
  type Meta,
} from '@donext/shared';
import { openDb } from './db';
import { DbStore } from './db-store';
import { mappings } from './entities';

/**
 * One user's data. Until sign-in exists, a single shared instance holds everything. It
 * only routes: the kinds of entity and their rules live in @donext/shared, their tables in
 * entities.ts.
 */
export class UserStore extends DurableObject<Env> {
  private store!: DbStore<Entity>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new DbStore(await openDb(ctx.storage), mappings);
    });
  }

  /** Every item's newest version, newest item first. */
  list<K extends Kind>(type: K): EntityOf<K>[] {
    return this.store.list(type);
  }

  /** An item's versions, newest first, older than `before` if given. Null if it does not exist. */
  async versions<K extends Kind>(
    type: K,
    id: string,
    before: number | null,
    limit: number,
  ): Promise<EntityOf<K>[] | null> {
    if (!(await this.store.get(type, id))) return null;
    return this.store.versions(type, id, before ?? Number.MAX_SAFE_INTEGER, limit);
  }

  /** Applies a change and returns the newest version of the item it targets. */
  async write<K extends Kind>(
    type: K,
    change: ChangeOf<K>,
    meta: Meta,
  ): Promise<Checked<EntityOf<K>, CodeOf<K>>> {
    const result = await write(entities[type], this.store, change, meta, Date.now());
    if (!result.ok) return result;
    const entity =
      result.value.find((e) => e.kind === type && e.id === change.id) ??
      (await this.store.get(type, change.id));
    if (!entity) throw new Error(`Writing ${type} ${change.id} left no version of it.`);
    return { ok: true, value: entity as EntityOf<K> };
  }

  /**
   * Deletes every item of a type with all its versions. Lets anyone clear the shared board of unwanted content
   * until sign-in gives each user their own; remove it then.
   */
  deleteAll(type: Kind): number {
    return this.store.deleteAll(type);
  }
}
