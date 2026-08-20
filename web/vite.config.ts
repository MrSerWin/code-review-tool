import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiPort = process.env.PORT ?? '5178';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5179,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
