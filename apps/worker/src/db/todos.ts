import type { Mapping } from '../db-store';
import { workItems } from './schema';

/** To-Dos are the rows of `work_items` whose type is 'todo'. */
export const todos = {
  table: workItems,
  scope: { key: 'type', value: 'todo' },
} as const satisfies Mapping<typeof workItems>;
