import { DurableObject } from 'cloudflare:workers';
import {
  SCHEMAS,
  TODO_LIMIT,
  checkCreate,
  checkUpdate,
  schemaFor,
  type Change,
  type EntityItem,
  type OpResult,
  type ParsedOp,
  type PullResponse,
  type RejectReason,
  type SyncOp,
  type Todo,
  type TodoState,
} from '@donext/shared';
import { ulid } from 'ulid';
import { MAPPINGS } from './mappings';
import { tableRepository, type EntityRepository } from './repository';
import { migrate } from './schema';
import { SyncState } from './sync-state';

type TodoRow = { id: string; title: string; state: TodoState; created_at: string };

export type CreateTodoResult = { ok: true; todo: Todo } | { ok: false; reason: 'limit_reached' };

/**
 * One user's data. Each kind is kept by its repository, in tables shaped for it; on top of that
 * sits sync's own versioning (`SyncState`). Until sign-in exists, a single shared instance
 * holds every To-Do.
 */
export class UserStore extends DurableObject<Env> {
  private readonly sync: SyncState;
  private readonly repositories = new Map<string, EntityRepository>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.sync = new SyncState(ctx.storage.sql);
    for (const mapping of Object.values(MAPPINGS)) {
      this.repositories.set(mapping.entity, tableRepository(ctx.storage.sql, mapping));
    }
  }

  /**
   * Applies a device's changes in order. Each one is atomic and independent: a rejected change
   * does not stop the rest. Sending a change again is harmless.
   */
  applyOps(ops: ParsedOp[]): OpResult[] {
    return ops.map((parsed) => {
      if (!parsed.ok) return rejected(parsed.opId, 'invalid_op', 'Malformed operation.');
      const { op } = parsed;
      return this.ctx.storage.transactionSync(() => {
        if (this.sync.wasApplied(op.opId)) return { opId: op.opId, status: 'duplicate' };
        const result = this.apply(op);
        if (result.status === 'applied') this.sync.markApplied(op.opId);
        return result;
      });
    });
  }

  /** What changed after `after`, oldest first, or a request to start again from zero. */
  pull(after: number, limit: number): PullResponse {
    const latestSeq = this.sync.latestSeq();
    if (after > latestSeq || (after > 0 && after < this.sync.watermark())) return { resync: true };

    const changes: Change[] = this.sync.deletionsSince(after, limit + 1);
    for (const repository of this.repositories.values()) {
      for (const { seq, item } of repository.changedSince(after, limit + 1)) {
        changes.push({ seq, entity: item.entity, id: item.id, item });
      }
    }
    changes.sort((a, b) => a.seq - b.seq);
    return {
      resync: false,
      epoch: this.sync.epoch(),
      changes: changes.slice(0, limit),
      latestSeq,
      hasMore: changes.length > limit,
    };
  }

  private apply(op: SyncOp): OpResult {
    const schema = schemaFor(SCHEMAS, op.entity);
    if (!schema) return rejected(op.opId, 'unknown_entity', `There is no “${op.entity}”.`);
    const repository = this.repository(op.entity);
    const applied: OpResult = { opId: op.opId, status: 'applied' };
    const now = new Date().toISOString();

    switch (op.kind) {
      case 'create': {
        // Devices make the ids, so an id that exists means this create already went through.
        if (repository.get(op.itemId)) return { opId: op.opId, status: 'duplicate' };
        const checked = checkCreate(schema, op.fields, this.context());
        if (!checked.ok) return rejected(op.opId, checked.reason, checked.message);
        if (schema.limit && repository.count() >= schema.limit.max) {
          return rejected(op.opId, 'limit_reached', schema.limit.message);
        }
        const item: EntityItem = {
          id: op.itemId,
          entity: op.entity,
          rev: 1,
          createdAt: now,
          updatedAt: now,
          fields: checked.fields,
        };
        repository.insert(item, this.sync.nextSeq());
        return applied;
      }

      case 'update': {
        // Fields merge: the ones named are written over the current item, whatever revision
        // the device started from, so the later write wins a field and the others are kept.
        const current = repository.get(op.itemId);
        if (!current) return rejected(op.opId, 'unknown_item', `No such ${schema.label}.`);
        const checked = checkUpdate(schema, current, op.changes, this.context());
        if (!checked.ok) return rejected(op.opId, checked.reason, checked.message);
        if (checked.changedFields.length > 0) {
          const item = { ...current, rev: current.rev + 1, updatedAt: now, fields: checked.fields };
          repository.update(item, this.sync.nextSeq());
        }
        return applied;
      }

      case 'delete': {
        // Deleting what is already gone is fine: the result is the same.
        if (repository.delete(op.itemId)) {
          this.sync.recordDeletion(op.entity, op.itemId, this.sync.nextSeq());
        }
        return applied;
      }
    }
  }

  private repository(entity: string): EntityRepository {
    const repository = this.repositories.get(entity);
    if (!repository) throw new Error(`The “${entity}” schema has no table mapping.`);
    return repository;
  }

  /** Rules may look items up without knowing their kind: ids are unique across kinds. */
  private context() {
    return {
      get: (id: string) => {
        for (const repository of this.repositories.values()) {
          const item = repository.get(id);
          if (item) return item;
        }
        return undefined;
      },
    };
  }

  listTodos(): Todo[] {
    return this.ctx.storage.sql
      .exec<TodoRow>(
        "SELECT id, title, state, created_at FROM work_items WHERE type = 'todo' ORDER BY id DESC",
      )
      .toArray()
      .map(toTodo);
  }

  createTodo(title: string): CreateTodoResult {
    const { count } = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM work_items WHERE type = 'todo'")
      .one();
    if (count >= TODO_LIMIT) return { ok: false, reason: 'limit_reached' };

    const now = new Date().toISOString();
    const row: TodoRow = { id: ulid(), title, state: 'new', created_at: now };
    this.ctx.storage.sql.exec(
      "INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at) VALUES (?, 'todo', ?, ?, 1, ?, ?)",
      row.id,
      row.title,
      row.state,
      now,
      now,
    );
    return { ok: true, todo: toTodo(row) };
  }

  /**
   * Deletes every To-Do. Lets anyone clear the shared board of unwanted content until
   * sign-in gives each user their own; remove it then.
   */
  deleteAllTodos(): number {
    return this.ctx.storage.sql.exec("DELETE FROM work_items WHERE type = 'todo'").rowsWritten;
  }
}

function toTodo(row: TodoRow): Todo {
  return { id: row.id, title: row.title, state: row.state, createdAt: row.created_at };
}

function rejected(opId: string, reason: RejectReason, message: string): OpResult {
  return { opId, status: 'rejected', reason, message };
}
