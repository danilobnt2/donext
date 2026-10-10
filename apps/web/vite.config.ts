import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  // `pnpm --filter @donext/worker dev` serves the API on 8787.
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
