import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'es2022',
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'page-bridge': resolve(__dirname, 'src/entrypoints/page-bridge.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'page-bridge') {
            return 'assets/page-bridge.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
