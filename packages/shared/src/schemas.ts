import type { Schemas } from './entity';
import { todoSchema } from './todo';

/** Every kind of data that syncs, by name. */
export const SCHEMAS: Schemas = {
  todo: todoSchema,
};
