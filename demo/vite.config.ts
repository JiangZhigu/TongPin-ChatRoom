import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: './', plugins: [react()],
  resolve: { alias: { 'socket.io-client': fileURLToPath(new URL('./src/sandbox/socket.ts', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { outDir: 'dist', assetsInlineLimit: 10000000, cssCodeSplit: false, chunkSizeWarningLimit: 3000,
    rolldownOptions: { input: fileURLToPath(new URL('./app.html', import.meta.url)), output: { codeSplitting: false } } }
});
