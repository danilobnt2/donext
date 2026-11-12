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
  type FieldOf,
  type Meta,
} from '@donext/shared';
import { openDb } from './db';
import { DbStore } from './db-store';
import { mappings } from './entities';

/**
 * One user's data. Until sign-in exists, a single shared instance holds everything. It
 * knows no kind of entity: the kinds and their rules live in @donext/shared, their tables
 * in entities.ts, and what a request means in the HTTP layer.
 */
export class UserStore extends DurableObject<Env> {
  private store!: DbStore<Entity>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new DbStore(await openDb(ctx.storage), mappings);
    });
  }

  count<K extends Kind>(kind: K, distinct?: FieldOf<EntityOf<K>>): number {
    return this.store.countSync(kind, distinct as FieldOf<Extract<Entity, { kind: K }>>);
  }

  newestPer<K extends Kind>(
    kind: K,
    groupBy: FieldOf<EntityOf<K>>,
    orderBy: FieldOf<EntityOf<K>>,
  ): EntityOf<K>[] {
    type Field = FieldOf<Extract<Entity, { kind: K }>>;
    return this.store.newestPerSync(kind, groupBy as Field, orderBy as Field);
  }

  /** Applies a change with its kind's rules and returns what it wrote. */
  write<K extends Kind>(
    kind: K,
    change: ChangeOf<K>,
    meta: Meta,
  ): Promise<Checked<Entity[], CodeOf<K>>> {
    return write(entities[kind], this.store, change, meta, Date.now());
  }

  /**
   * Deletes every entity of a kind and returns how many there were. Lets anyone clear the
   * shared board of unwanted content until sign-in gives each user their own; remove it then.
   */
  deleteAll(kind: Kind): number {
    return this.store.deleteAll(kind);
  }
}
