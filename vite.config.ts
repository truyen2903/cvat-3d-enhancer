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
const isFirefox = process.env.BUILD_TARGET === 'firefox';
const outDir = isFirefox ? 'dist-firefox' : 'dist';

function allowDynamicOriginResourcesPlugin(): Plugin {
  return {
    name: 'allow-dynamic-origin-resources',
    closeBundle() {
      const manifestPath = resolve(__dirname, outDir, 'manifest.json');
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          web_accessible_resources?: {
            matches?: string[];
            resources?: string[];
            use_dynamic_url?: boolean;
          }[];
        };
        if (Array.isArray(raw.web_accessible_resources)) {
          raw.web_accessible_resources = raw.web_accessible_resources.map((entry) => {
            const next = {
              ...entry,
              matches: ['https://*/*', 'http://*/*'],
              use_dynamic_url: false,
            };
            // use_dynamic_url is Chrome-only; Firefox warns on unknown keys.
            if (isFirefox) delete (next as { use_dynamic_url?: boolean }).use_dynamic_url;
            return next;
          });
        }
        if (isFirefox) {
          const ff = raw as Record<string, unknown>;
          const bg = ff.background as { service_worker?: string } | undefined;
          // Firefox MV3 uses event-page scripts instead of a service worker.
          ff.background = {
            scripts: [bg?.service_worker ?? 'service-worker-loader.js'],
            type: 'module',
          };
          delete ff.minimum_chrome_version;
          ff.browser_specific_settings = {
            gecko: {
              id: 'meow@cvat-3d-enhancer',
              strict_min_version: '128.0',
              data_collection_permissions: { required: ['none'] },
            },
          };
        }
        writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
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
    outDir,
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
