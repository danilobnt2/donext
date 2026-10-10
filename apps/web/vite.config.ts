import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    // `pnpm dev` at the root runs wrangler dev on 8787 alongside this server.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
