import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'CVAT 3D Enhancer',
  version: '0.1.0',
  description:
    'Security-first 3D/LiDAR annotation workspace enhancer for CVAT with capability-verified runtime controls and hierarchical presets.',
  minimum_chrome_version: '114',
  permissions: ['storage'],
  host_permissions: [
    'https://app.cvat.ai/*',
    'http://localhost:8080/*',
    'http://127.0.0.1:8080/*',
  ],
  background: {
    service_worker: 'src/entrypoints/background.ts',
    type: 'module',
  },
  action: {
    default_title: 'CVAT 3D Enhancer',
    default_popup: 'src/entrypoints/popup/index.html',
  },
  content_scripts: [
    {
      matches: [
        'https://app.cvat.ai/*',
        'http://localhost:8080/*',
        'http://127.0.0.1:8080/*',
      ],
      js: ['src/entrypoints/content.ts'],
      run_at: 'document_idle',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['assets/page-bridge.js'],
      matches: [
        'https://app.cvat.ai/*',
        'http://localhost:8080/*',
        'http://127.0.0.1:8080/*',
      ],
    },
  ],
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
  },
});
