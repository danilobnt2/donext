/**
 * For entity types whose entities are versions of an item, such as To-Do versions: each
 * change appends a version, versions are never edited, and an item keeps only its newest
 * VERSION_LIMIT versions. These are rules, applied by each such entity type's apply.
 */

import type { Meta } from './change';

/** Versions kept per item. Older ones are dropped first; the newest is always kept. */
export const VERSION_LIMIT = 1000;

/** What every version holds, whatever it is a version of. Times are Unix milliseconds. */
export interface VersionFields<Change extends string, Field extends string> extends Meta {
  /** The version number, starting at 1. */
  version: number;
  /** When the item was created; copied into every version, since old ones get dropped. */
  createdAt: number;
  change: Change;
  changedFields: Field[];
  /** When the change was accepted, on the clock of whoever runs the rules. */
  changedAt: number;
}

/** Lowest version number of an item to keep once `newest` is written. */
export function oldestKeptVersion(newest: number): number {
  return Math.max(1, newest - VERSION_LIMIT + 1);
}
