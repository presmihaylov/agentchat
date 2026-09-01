import { defineConfig } from 'vite';

// Dev flow: run the Go server on :8090, then `npm run dev` here; the proxy
// forwards everything non-UI. Prod serves the built dist/ from the Go binary.
const backend = 'http://localhost:8090';

export default defineConfig({
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': backend,
      '/healthz': backend,
      '/skill': backend,
    },
  },
});
