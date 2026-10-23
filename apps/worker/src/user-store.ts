import { DurableObject } from 'cloudflare:workers';
import {
  SCHEMAS,
  checkCreate,
  checkUpdate,
  type CreateOp,
  type EntityItem,
  type EntitySchema,
  type OpResult,
  type ParsedOp,
  type PullResponse,
  type RejectReason,
  type Revision,
  type UpdateOp,
} from '@donext/shared';
import { migrate } from './schema';

type ItemRow = {
  id: string;
  entity: string;
  rev: number;
  created_at: string;
  updated_at: string;
  fields: string;
};

type RevisionRow = {
  seq: number;
  item_id: string;
  entity: string;
  rev: number;
  changed_at: string;
  changed_fields: string;
  snapshot: string;
};

const ITEM_COLUMNS = 'id, entity, rev, created_at, updated_at, fields';
const REVISION_COLUMNS = 'seq, item_id, entity, rev, changed_at, changed_fields, snapshot';

/**
 * One user's data: entity items and the log of every change to them. Until sign-in exists, a
 * single shared instance holds everything. It knows nothing about what the items are; the
 * schemas say what they may contain and which changes are allowed.
 */
export class UserStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
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
    if (this.item(op.itemId)) {
      return rejected(op.opId, 'item_exists', 'An item with this id already exists.');
    }

    const checked = checkCreate(schema, op.fields, this.context());
    if (!checked.ok) return rejected(op.opId, checked.reason, checked.message);
    if (schema.limit && this.liveCount(schema) >= schema.limit.max) {
      return rejected(op.opId, 'limit_reached', schema.limit.message);
    }

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO entities (${ITEM_COLUMNS}) VALUES (?, ?, 1, ?, ?, ?)`,
      op.itemId,
      op.entity,
      now,
      now,
      JSON.stringify(checked.fields),
    );
    const item: EntityItem = {
      id: op.itemId,
      entity: op.entity,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      fields: checked.fields,
    };
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
    const current = this.item(op.itemId);
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
    this.ctx.storage.sql.exec(
      'UPDATE entities SET fields = ?, rev = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(item.fields),
      item.rev,
      now,
      item.id,
    );
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

  private item(id: string): EntityItem | undefined {
    const row = this.ctx.storage.sql
      .exec<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM entities WHERE id = ?`, id)
      .toArray()[0];
    return row ? toItem(row) : undefined;
  }

  /** How many items of this kind count against its limit: those not yet finished. */
  private liveCount(schema: EntitySchema): number {
    const { terminal } = schema;
    const { count } = terminal
      ? this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM entities WHERE entity = ? AND json_extract(fields, ?) IS NOT ?',
            schema.name,
            `$.${terminal.field}`,
            terminal.value,
          )
          .one()
      : this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM entities WHERE entity = ?',
            schema.name,
          )
          .one();
    return count;
  }

  private context() {
    return { get: (id: string) => this.item(id) };
  }
}

function rejected(opId: string, reason: RejectReason, message: string): OpResult {
  return { opId, status: 'rejected', reason, message };
}

function toItem(row: ItemRow): EntityItem {
  return {
    id: row.id,
    entity: row.entity,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fields: JSON.parse(row.fields) as EntityItem['fields'],
  };
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
