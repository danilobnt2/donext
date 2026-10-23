import { DurableObject } from 'cloudflare:workers';
import {
  TODO_LIMIT,
  checkTitle,
  type CreateTodoOp,
  type OpResult,
  type ParsedOp,
  type PullResponse,
  type RejectReason,
  type Revision,
  type Todo,
  type TodoState,
  type UpdateTodoOp,
} from '@donext/shared';
import { migrate } from './schema';

type TodoRow = {
  id: string;
  title: string;
  state: TodoState;
  rev: number;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  seq: number;
  item_id: string;
  rev: number;
  changed_at: string;
  changed_fields: string;
  snapshot: string;
};

const REVISION_COLUMNS = 'seq, item_id, rev, changed_at, changed_fields, snapshot';

/** One user's data. Until sign-in exists, a single shared instance holds every To-Do. */
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
        return op.kind === 'create_todo'
          ? this.applyCreate(source, op)
          : this.applyUpdate(source, op);
      });
    });
  }

  /** Revisions after `after`, oldest first, for a device catching up. */
  pull(after: number, limit: number): PullResponse {
    const rows = this.ctx.storage.sql
      .exec<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM work_item_revisions WHERE seq > ? ORDER BY seq LIMIT ?`,
        after,
        limit + 1,
      )
      .toArray();
    const { latest } = this.ctx.storage.sql
      .exec<{ latest: number }>('SELECT COALESCE(MAX(seq), 0) AS latest FROM work_item_revisions')
      .one();
    return {
      revisions: rows.slice(0, limit).map(toRevision),
      latestSeq: latest,
      hasMore: rows.length > limit,
    };
  }

  private applyCreate(source: string, op: CreateTodoOp): OpResult {
    const title = checkTitle(op.title);
    if (!title.ok) return rejected(op.opId, 'invalid_title', title.message);
    if (this.todoRow(op.itemId)) {
      return rejected(op.opId, 'item_exists', 'A To-Do with this id already exists.');
    }
    // Abandoned To-Dos are hidden, so they do not count against the board's limit.
    const { count } = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM work_items WHERE type = 'todo' AND state != 'abandoned'",
      )
      .one();
    if (count >= TODO_LIMIT) return rejected(op.opId, 'todo_limit_reached', 'This board is full.');

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO work_items (id, type, title, state, rev, created_at, updated_at) VALUES (?, 'todo', ?, 'new', 1, ?, ?)",
      op.itemId,
      title.title,
      now,
      now,
    );
    const todo: Todo = {
      id: op.itemId,
      title: title.title,
      state: 'new',
      rev: 1,
      createdAt: now,
      updatedAt: now,
    };
    const revision = this.recordRevision(source, op, 0, now, ['title', 'state'], todo);
    return { opId: op.opId, status: 'applied', revision };
  }

  /**
   * Changes merge per field: whatever the device's base revision, the fields it names are
   * written on top of the current To-Do, and the others are left alone. Because changes are
   * applied in arrival order, the later write wins a field, and the earlier value stays in
   * that revision's snapshot.
   */
  private applyUpdate(source: string, op: UpdateTodoOp): OpResult {
    const row = this.todoRow(op.itemId);
    if (!row) return rejected(op.opId, 'unknown_item', 'No such To-Do.');

    const { changes } = op;
    if (row.state === 'abandoned') {
      // Abandoning twice (from two devices) is not an error; anything else is.
      if (changes.title === undefined) return { opId: op.opId, status: 'applied', revision: null };
      return rejected(op.opId, 'item_abandoned', 'This To-Do was abandoned and cannot be edited.');
    }

    const changedFields: string[] = [];
    let title = row.title;
    if (changes.title !== undefined) {
      const check = checkTitle(changes.title);
      if (!check.ok) return rejected(op.opId, 'invalid_title', check.message);
      if (check.title !== row.title) {
        title = check.title;
        changedFields.push('title');
      }
    }
    let state: TodoState = row.state;
    if (changes.state === 'abandoned') {
      state = 'abandoned';
      changedFields.push('state');
    }
    if (changedFields.length === 0) return { opId: op.opId, status: 'applied', revision: null };

    const now = new Date().toISOString();
    const rev = row.rev + 1;
    this.ctx.storage.sql.exec(
      'UPDATE work_items SET title = ?, state = ?, rev = ?, updated_at = ? WHERE id = ?',
      title,
      state,
      rev,
      now,
      row.id,
    );
    const todo: Todo = { ...toTodo(row), title, state, rev, updatedAt: now };
    const revision = this.recordRevision(source, op, op.baseRev, now, changedFields, todo);
    return { opId: op.opId, status: 'applied', revision };
  }

  private recordRevision(
    source: string,
    op: CreateTodoOp | UpdateTodoOp,
    baseRev: number,
    changedAt: string,
    changedFields: string[],
    todo: Todo,
  ): Revision {
    const { seq } = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `INSERT INTO work_item_revisions
           (item_id, rev, op_id, base_rev, changed_at, client_changed_at, source, changed_fields, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
        todo.id,
        todo.rev,
        op.opId,
        baseRev,
        changedAt,
        op.clientChangedAt,
        source,
        JSON.stringify(changedFields),
        JSON.stringify(todo),
      )
      .one();
    return { seq, itemId: todo.id, rev: todo.rev, changedAt, changedFields, todo };
  }

  private revisionForOp(opId: string): Revision | null {
    const row = this.ctx.storage.sql
      .exec<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM work_item_revisions WHERE op_id = ?`,
        opId,
      )
      .toArray()[0];
    return row ? toRevision(row) : null;
  }

  private todoRow(id: string): TodoRow | undefined {
    return this.ctx.storage.sql
      .exec<TodoRow>(
        "SELECT id, title, state, rev, created_at, updated_at FROM work_items WHERE id = ? AND type = 'todo'",
        id,
      )
      .toArray()[0];
  }
}

function rejected(opId: string, reason: RejectReason, message: string): OpResult {
  return { opId, status: 'rejected', reason, message };
}

function toRevision(row: RevisionRow): Revision {
  return {
    seq: row.seq,
    itemId: row.item_id,
    rev: row.rev,
    changedAt: row.changed_at,
    changedFields: JSON.parse(row.changed_fields) as string[],
    todo: JSON.parse(row.snapshot) as Todo,
  };
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
