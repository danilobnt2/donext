import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  // Each entity type defines its table next to its rules, in the shared package.
  schema: '../../packages/shared/src/todo.ts',
  out: './drizzle',
});
