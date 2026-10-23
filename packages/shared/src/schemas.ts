import type { Schemas } from './entity';
import { todoSchema } from './todo';

/** Every kind of data that syncs, by name. A new kind is one more line here. */
export const SCHEMAS: Schemas = {
  todo: todoSchema,
};
