import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The operator console. Assets land in web/dist, which the AdScout server serves
// statically (src/serve.ts → webDir). In dev, `pnpm web:dev` runs Vite on :5173
// and proxies /api (REST + SSE) to the running server on :8787.

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
    rollupOptions: {
      output: {
        // vite 8's rolldown bundler only accepts the function form of
        // manualChunks (the object/array form throws "Expected Function").
        manualChunks(id) {
          if (id.includes('node_modules/@chakra-ui/') || id.includes('node_modules/@emotion/'))
            return 'chakra';
          if (id.includes('node_modules/react-window')) return 'react-window';
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase/'))
            return 'firebase';
          return undefined;
        },
      },
    },
  },
});
