import type { Change } from '@donext/shared';

/**
 * How much of sync's own bookkeeping the server keeps. Each table only grows to its cap; the
 * oldest rows go first. Tests lower these to reach the caps quickly.
 */
export const SYNC_LIMITS = {
  /** Deleted items remembered so devices can remove them too. Older ones force a resync. */
  maxDeletions: 10_000,
  /** Operation ids remembered so a retried operation is not applied twice. */
  maxAppliedOps: 10_000,
};

/**
 * Sync's own versioning and bookkeeping, separate from the domain data: the user-wide sequence
 * number, the deletions devices have not necessarily seen yet, and recent operation ids.
 */
export class SyncState {
  constructor(private readonly sql: SqlStorage) {}

  /** The next sequence number. Every write to synced data takes one. */
  nextSeq(): number {
    return this.sql
      .exec<{ value: number }>(
        "UPDATE sync_state SET value = value + 1 WHERE key = 'seq' RETURNING value",
      )
      .one().value;
  }

  latestSeq(): number {
    return this.read('seq');
  }

  /** Identifies this store's history; it changes only if the store starts again from nothing. */
  epoch(): number {
    return this.read('epoch');
  }

  /** The newest deletion that has been forgotten. A device whose cursor is below it may have missed one. */
  watermark(): number {
    return this.read('watermark');
  }

  wasApplied(opId: string): boolean {
    return (
      this.sql.exec('SELECT 1 FROM sync_applied_ops WHERE op_id = ?', opId).toArray().length > 0
    );
  }

  markApplied(opId: string): void {
    this.sql.exec('INSERT INTO sync_applied_ops (op_id) VALUES (?)', opId);
    this.sql.exec(
      `DELETE FROM sync_applied_ops
       WHERE rowid <= (SELECT MAX(rowid) FROM sync_applied_ops) - ?`,
      SYNC_LIMITS.maxAppliedOps,
    );
  }

  recordDeletion(entity: string, id: string, seq: number): void {
    this.sql.exec('INSERT INTO sync_deletions (seq, entity, id) VALUES (?, ?, ?)', seq, entity, id);
    const forgotten = this.sql
      .exec<{ seq: number }>(
        `DELETE FROM sync_deletions
         WHERE seq <= (SELECT seq FROM sync_deletions ORDER BY seq DESC LIMIT 1 OFFSET ?)
         RETURNING seq`,
        SYNC_LIMITS.maxDeletions,
      )
      .toArray();
    if (forgotten.length > 0) {
      const newest = Math.max(...forgotten.map((row) => row.seq));
      this.sql.exec("UPDATE sync_state SET value = MAX(value, ?) WHERE key = 'watermark'", newest);
    }
  }

  deletionsSince(after: number, limit: number): Change[] {
    return this.sql
      .exec<{ seq: number; entity: string; id: string }>(
        'SELECT seq, entity, id FROM sync_deletions WHERE seq > ? ORDER BY seq LIMIT ?',
        after,
        limit,
      )
      .toArray()
      .map((row) => ({ seq: row.seq, entity: row.entity, id: row.id, item: null }));
  }

  private read(key: string): number {
    return this.sql.exec<{ value: number }>('SELECT value FROM sync_state WHERE key = ?', key).one()
      .value;
  }
}
