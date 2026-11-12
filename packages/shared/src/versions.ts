/**
 * For entity types whose entities are versions of an item, such as To-Do versions: each
 * change appends a version, versions are never edited, and an item keeps only its newest
 * VERSION_LIMIT versions. These are rules, applied by each such entity type's apply.
 */

/** Versions kept per item. Older ones are dropped first; the newest is always kept. */
export const VERSION_LIMIT = 1000;

/** Lowest version number of an item to keep once `newest` is written. */
export function oldestKeptVersion(newest: number): number {
  return Math.max(1, newest - VERSION_LIMIT + 1);
}
