import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  // Each entity type defines its table next to its rules, in the shared package; every
  // source file there is read, so new entity types need no change here.
  schema: '../../packages/shared/src/!(*.test).ts',
  out: './drizzle',
});
