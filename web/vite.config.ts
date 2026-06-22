import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built assets land in web/dist, which the AdScout server serves statically
// (see src/serve.ts → webDir). In dev, `pnpm web:dev` runs Vite on :5173 and
// proxies /api (REST + SSE) to the running server on :8787.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
