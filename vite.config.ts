import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../public/quote-room',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3030',
      '/health': 'http://127.0.0.1:3030',
      '/test': 'http://127.0.0.1:3030',
    },
  },
});
