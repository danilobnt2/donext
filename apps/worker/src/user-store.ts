import { DurableObject } from 'cloudflare:workers';
import {
  SCHEMAS,
  checkCreate,
  checkUpdate,
  type CreateOp,
  type EntityItem,
  type OpResult,
  type ParsedOp,
  type PullResponse,
  type RejectReason,
  type Revision,
  type UpdateOp,
} from '@donext/shared';
import { MAPPINGS } from './mappings';
import { tableRepository, type EntityRepository } from './repository';
import { migrate } from './schema';

type RevisionRow = {
  seq: number;
  item_id: string;
  entity: string;
  rev: number;
  changed_at: string;
  changed_fields: string;
  snapshot: string;
};

const REVISION_COLUMNS = 'seq, item_id, entity, rev, changed_at, changed_fields, snapshot';

/**
 * One user's data. Items are kept by their kind's repository, in tables shaped for that kind;
 * what this class adds is the log of every change, which is what devices sync from. The schemas
 * say what each kind may contain and which changes are allowed. Until sign-in exists, a single
 * shared instance holds everything.
 */
export class UserStore extends DurableObject<Env> {
  private readonly repositories = new Map<string, EntityRepository>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    for (const mapping of Object.values(MAPPINGS)) {
      this.repositories.set(mapping.entity, tableRepository(ctx.storage.sql, mapping));
    }
  }

  /**
   * Applies a device's changes in order. Each change is atomic and independent: a rejected
   * one does not stop the rest. Replaying a change that was already applied is harmless.
   */
  applyOps(deviceId: string, ops: ParsedOp[]): OpResult[] {
    const source = `app:${deviceId}`;
    return ops.map((parsed) => {
      if (!parsed.ok) return rejected(parsed.opId, 'invalid_op', 'Malformed operation.');
      const { op } = parsed;
      return this.ctx.storage.transactionSync(() => {
        const earlier = this.revisionForOp(op.opId);
        if (earlier) return { opId: op.opId, status: 'duplicate', revision: earlier };
        return op.kind === 'create' ? this.applyCreate(source, op) : this.applyUpdate(source, op);
      });
    });
  }

  /** Revisions after `after`, oldest first, for a device catching up. */
  pull(after: number, limit: number): PullResponse {
    const rows = this.ctx.storage.sql
      .exec<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM entity_revisions WHERE seq > ? ORDER BY seq LIMIT ?`,
        after,
        limit + 1,
      )
      .toArray();
    const { latest } = this.ctx.storage.sql
      .exec<{ latest: number }>('SELECT COALESCE(MAX(seq), 0) AS latest FROM entity_revisions')
      .one();
    return {
      revisions: rows.slice(0, limit).map(toRevision),
      latestSeq: latest,
      hasMore: rows.length > limit,
    };
  }

  private applyCreate(source: string, op: CreateOp): OpResult {
    const schema = Object.hasOwn(SCHEMAS, op.entity) ? SCHEMAS[op.entity] : undefined;
    if (!schema) return rejected(op.opId, 'unknown_entity', `There is no “${op.entity}”.`);
    const repository = this.repository(op.entity);
    if (this.findItem(op.itemId)) {
      return rejected(op.opId, 'item_exists', 'An item with this id already exists.');
    }

    const checked = checkCreate(schema, op.fields, this.context());
    if (!checked.ok) return rejected(op.opId, checked.reason, checked.message);
    if (schema.limit && repository.count(schema.terminal) >= schema.limit.max) {
      return rejected(op.opId, 'limit_reached', schema.limit.message);
    }

    const now = new Date().toISOString();
    const item: EntityItem = {
      id: op.itemId,
      entity: op.entity,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      fields: checked.fields,
    };
    repository.insert(item);
    const revision = this.recordRevision(source, op, 0, now, Object.keys(checked.fields), item);
    return { opId: op.opId, status: 'applied', revision };
  }

  /**
   * Changes merge per field: whatever the device's base revision, the fields it names are
   * written on top of the current item, and the others are left alone. Because changes are
   * applied in arrival order, the later write wins a field, and the earlier value stays in
   * that revision's snapshot.
   */
  private applyUpdate(source: string, op: UpdateOp): OpResult {
    const current = this.findItem(op.itemId);
    if (!current) return rejected(op.opId, 'unknown_item', 'No such item.');
    const schema = Object.hasOwn(SCHEMAS, current.entity) ? SCHEMAS[current.entity] : undefined;
    if (!schema) return rejected(op.opId, 'unknown_entity', `There is no “${current.entity}”.`);

    const checked = checkUpdate(schema, current, op.changes, this.context());
    if (!checked.ok) return rejected(op.opId, checked.reason, checked.message);
    if (checked.changedFields.length === 0)
      return { opId: op.opId, status: 'applied', revision: null };

    const now = new Date().toISOString();
    const item: EntityItem = {
      ...current,
      rev: current.rev + 1,
      updatedAt: now,
      fields: checked.next,
    };
    this.repository(item.entity).update(item);
    const revision = this.recordRevision(source, op, op.baseRev, now, checked.changedFields, item);
    return { opId: op.opId, status: 'applied', revision };
  }

  private recordRevision(
    source: string,
    op: CreateOp | UpdateOp,
    baseRev: number,
    changedAt: string,
    changedFields: string[],
    item: EntityItem,
  ): Revision {
    const { seq } = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `INSERT INTO entity_revisions
           (item_id, entity, rev, op_id, base_rev, changed_at, client_changed_at, source, changed_fields, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
        item.id,
        item.entity,
        item.rev,
        op.opId,
        baseRev,
        changedAt,
        op.clientChangedAt,
        source,
        JSON.stringify(changedFields),
        JSON.stringify(item),
      )
      .one();
    return {
      seq,
      itemId: item.id,
      entity: item.entity,
      rev: item.rev,
      changedAt,
      changedFields,
      item,
    };
  }

  private revisionForOp(opId: string): Revision | null {
    const row = this.ctx.storage.sql
      .exec<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM entity_revisions WHERE op_id = ?`, opId)
      .toArray()[0];
    return row ? toRevision(row) : null;
  }

  private repository(entity: string): EntityRepository {
    const repository = this.repositories.get(entity);
    if (!repository) throw new Error(`The “${entity}” schema has no table mapping.`);
    return repository;
  }

  /** Looks an item up without knowing its kind: ids are unique across kinds. */
  private findItem(id: string): EntityItem | undefined {
    for (const repository of this.repositories.values()) {
      const item = repository.get(id);
      if (item) return item;
    }
    return undefined;
  }

  private context() {
    return { get: (id: string) => this.findItem(id) };
  }
}

function rejected(opId: string, reason: RejectReason, message: string): OpResult {
  return { opId, status: 'rejected', reason, message };
}

function toRevision(row: RevisionRow): Revision {
  return {
    seq: row.seq,
    itemId: row.item_id,
    entity: row.entity,
    rev: row.rev,
    changedAt: row.changed_at,
    changedFields: JSON.parse(row.changed_fields) as string[],
    item: JSON.parse(row.snapshot) as EntityItem,
  };
}
