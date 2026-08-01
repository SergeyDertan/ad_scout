import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Two builds from one source tree:
//
//   default            the operator console. Assets land in web/dist, which the
//                      AdScout server serves statically (src/serve.ts → webDir).
//                      In dev, `pnpm web:dev` runs Vite on :5173 and proxies
//                      /api (REST + SSE) to the running server on :8787.
//
//   VITE_TARGET=viewer the shared read-only viewer, deployed to Firebase
//                      Hosting from web/dist-viewer. It has no server: './api'
//                      is aliased to api.snapshot.ts, which reads published JSON
//                      out of Cloud Storage. Aliasing the module — rather than
//                      branching inside the components — is what lets
//                      DomainsView/ResponsesView and the whole export pipeline
//                      run in both builds without a second implementation.
const viewer = process.env.VITE_TARGET === 'viewer';

const resolvePath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Swap the data layer for the viewer build: any import that resolves to
 * src/api.ts gets src/api.snapshot.ts instead.
 *
 * This is a resolver, not a `resolve.alias`, on purpose — alias matches the
 * IMPORT SPECIFIER, and the components import '../api' from several different
 * directories, so no single alias pattern catches them all. Resolving first and
 * comparing the final path catches every spelling, and fails loudly (build
 * error) rather than silently shipping the HTTP client to a viewer with no
 * server to talk to.
 */
function swapApiForSnapshot(): Plugin {
  const target = resolvePath('./src/api.ts');
  const replacement = resolvePath('./src/api.snapshot.ts');
  return {
    name: 'adscout-viewer-api',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return resolved.id.split('?')[0] === target ? replacement : null;
    },
  };
}

export default defineConfig({
  plugins: [react(), ...(viewer ? [swapApiForSnapshot()] : [])],
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
    outDir: viewer ? 'dist-viewer' : 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // The viewer's entry is viewer.html; index.html would pull in the operator
      // console, server calls and all.
      ...(viewer ? { input: resolvePath('./viewer.html') } : {}),
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
