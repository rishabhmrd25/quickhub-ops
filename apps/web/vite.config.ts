import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, the browser talks to Vite, and Vite forwards /api and /ws to the server.
// That way there are no CORS issues and no hard-coded server URL in the app.
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': target,
      '/ws': { target, ws: true },
    },
  },
});
