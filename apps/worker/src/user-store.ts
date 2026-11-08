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
} from '@donext/shared';
import { openDb } from './db';
import { DbStore } from './db-store';

/**
 * One user's data. Until sign-in exists, a single shared instance holds everything. It
 * only routes: the kinds of entity, their rules and their tables live in @donext/shared.
 */
export class UserStore extends DurableObject<Env> {
  private store!: DbStore<Entity>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new DbStore<Entity>(await openDb(ctx.storage), entities);
    });
  }

  /** Every entity of a type, newest first. */
  list<K extends Kind>(type: K): EntityOf<K>[] {
    return this.store.list(type);
  }

  /** Applies a change and returns the entity it targets as it now stands. */
  async write<K extends Kind>(
    type: K,
    change: ChangeOf<K>,
  ): Promise<Checked<EntityOf<K>, CodeOf<K>>> {
    const result = await write(entities[type], this.store, change, Date.now());
    if (!result.ok) return result;
    const entity = result.value.find((e) => e.kind === type && e.id === change.id);
    if (!entity) throw new Error(`Writing ${type} ${change.id} did not produce it.`);
    return { ok: true, value: entity as EntityOf<K> };
  }

  /**
   * Deletes every entity of a type. Lets anyone clear the shared board of unwanted content
   * until sign-in gives each user their own; remove it then.
   */
  deleteAll(type: Kind): number {
    return this.store.deleteAll(type);
  }
}
