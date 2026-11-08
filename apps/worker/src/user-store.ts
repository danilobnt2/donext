import { DurableObject } from 'cloudflare:workers';
import { write, type Checked } from '@donext/shared';
import { openDb } from './db';
import { DbStore } from './db-store';
import {
  mappings,
  rules,
  type ChangeOf,
  type CodeOf,
  type Entity,
  type EntityOf,
  type Type,
} from './entities';

/**
 * One user's data. Until sign-in exists, a single shared instance holds everything. It
 * only routes: the rules live in @donext/shared, the entity types in entities.ts.
 */
export class UserStore extends DurableObject<Env> {
  private store!: DbStore<Entity>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new DbStore(await openDb(ctx.storage), mappings);
    });
  }

  /** Every entity of a type, newest first. */
  list<K extends Type>(type: K): EntityOf<K>[] {
    return this.store.list(type);
  }

  /** Applies a change and returns the entity it targets as it now stands. */
  async write<K extends Type>(
    type: K,
    change: ChangeOf<K>,
  ): Promise<Checked<EntityOf<K>, CodeOf<K>>> {
    const result = await write(rules[type], this.store, change, Date.now());
    if (!result.ok) return result;
    const entity = result.value.find((e) => e.kind === type && e.id === change.id);
    if (!entity) throw new Error(`Writing ${type} ${change.id} did not produce it.`);
    return { ok: true, value: entity as EntityOf<K> };
  }

  /**
   * Deletes every entity of a type. Lets anyone clear the shared board of unwanted content
   * until sign-in gives each user their own; remove it then.
   */
  deleteAll(type: Type): number {
    return this.store.deleteAll(type);
  }
}
