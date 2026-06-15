import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The /anki proxy forwards browser requests to the user's local AnkiConnect.
// Server-to-localhost requests carry no browser Origin header, so AnkiConnect
// accepts them without any webCorsOriginList configuration (the same reason
// curl works against it). This is the preferred, zero-config transport.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/anki': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/anki/, ''),
      },
      // Forwards browser calls to OpenAI server-side, avoiding CORS. The API key
      // travels in the Authorization header set by the app (from .env); it is
      // never committed. Only used by the AI tagging feature.
      '/openai': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/openai/, ''),
      },
    },
  },
});
