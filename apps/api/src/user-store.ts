import { DurableObject } from 'cloudflare:workers'
import { createTodoInput, type Todo, type TodoState } from '@donext/shared'

/**
 * Schema migrations for the per-user SQLite database, applied in order.
 * Never edit a released entry; append a new one instead.
 */
const MIGRATIONS = [
  `
  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('todo', 'task')),
    title TEXT NOT NULL,
    notes TEXT,
    state TEXT NOT NULL,
    due_date TEXT,
    rev INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE TABLE work_item_revisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    changed_at TEXT NOT NULL,
    client_changed_at TEXT,
    source TEXT NOT NULL,
    reason TEXT,
    changed_fields TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    UNIQUE (item_id, rev)
  );
  `,
]

type WorkItemRow = {
  id: string
  title: string
  notes: string | null
  state: string
  due_date: string | null
  rev: number
  created_at: string
  updated_at: string
  done_at: string | null
}

export type CreateTodoResult =
  | { ok: true; created: boolean; todo: Todo }
  | { ok: false; error: { code: 'invalid'; issues: { path: string; message: string }[] } }

function toTodo(row: WorkItemRow): Todo {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    state: row.state as TodoState,
    dueDate: row.due_date,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
  }
}

/** One instance per user: that user's work items and their append-only revision log. */
export class UserStore extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => this.migrate())
  }

  private migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)')
    const row = this.sql.exec<{ version: number }>('SELECT version FROM _schema').toArray()[0]
    const current = row?.version ?? 0
    if (current >= MIGRATIONS.length) return
    this.ctx.storage.transactionSync(() => {
      for (const migration of MIGRATIONS.slice(current)) this.sql.exec(migration)
      if (row) this.sql.exec('UPDATE _schema SET version = ?', MIGRATIONS.length)
      else this.sql.exec('INSERT INTO _schema (version) VALUES (?)', MIGRATIONS.length)
    })
  }

  listTodos(): Todo[] {
    return this.sql
      .exec<WorkItemRow>(
        "SELECT * FROM work_items WHERE type = 'todo' AND state != 'abandoned' ORDER BY id DESC",
      )
      .toArray()
      .map(toTodo)
  }

  /**
   * Creates a To-Do and its first revision. Replaying the same id returns the
   * stored item unchanged, so a client can safely retry after a lost response.
   */
  createTodo(input: unknown, source: string): CreateTodoResult {
    const parsed = createTodoInput.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'invalid',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      }
    }
    const { id, title, notes, dueDate, clientChangedAt } = parsed.data

    const existing = this.getTodo(id)
    if (existing) return { ok: true, created: false, todo: existing }

    const now = new Date().toISOString()
    const todo: Todo = {
      id,
      title,
      notes,
      state: 'new',
      dueDate,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO work_items (id, type, title, notes, state, due_date, rev, created_at, updated_at, done_at)
         VALUES (?, 'todo', ?, ?, ?, ?, ?, ?, ?, NULL)`,
        todo.id,
        todo.title,
        todo.notes,
        todo.state,
        todo.dueDate,
        todo.rev,
        todo.createdAt,
        todo.updatedAt,
      )
      this.sql.exec(
        `INSERT INTO work_item_revisions (item_id, rev, changed_at, client_changed_at, source, changed_fields, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        todo.id,
        todo.rev,
        now,
        clientChangedAt ?? null,
        source,
        JSON.stringify(['title', 'notes', 'state', 'dueDate']),
        JSON.stringify(todo),
      )
    })
    return { ok: true, created: true, todo }
  }

  private getTodo(id: string): Todo | null {
    const row = this.sql
      .exec<WorkItemRow>("SELECT * FROM work_items WHERE id = ? AND type = 'todo'", id)
      .toArray()[0]
    return row ? toTodo(row) : null
  }
}
