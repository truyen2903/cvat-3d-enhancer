import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

/**
 * Ensures CRXJS-generated web_accessible_resources allow dynamic import() of content script
 * chunks on user-authorized custom domains (via optional_host_permissions) without hardcoding
 * private domains into source code.
 */
function allowDynamicOriginResourcesPlugin(): Plugin {
  return {
    name: 'allow-dynamic-origin-resources',
    closeBundle() {
      const manifestPath = resolve(__dirname, 'dist/manifest.json');
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          web_accessible_resources?: {
            matches?: string[];
            resources?: string[];
            use_dynamic_url?: boolean;
          }[];
        };
        if (Array.isArray(raw.web_accessible_resources)) {
          raw.web_accessible_resources = raw.web_accessible_resources.map((entry) => ({
            ...entry,
            matches: ['https://*/*', 'http://*/*'],
            use_dynamic_url: false,
          }));
          writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
        }
      } catch {
        // Ignore if dist/manifest.json is not present during partial runs
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [react(), crx({ manifest }), allowDynamicOriginResourcesPlugin()],
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
