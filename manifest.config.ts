import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'meow',
  version: '0.1.0',
  description:
    'Security-first 3D/LiDAR annotation workspace enhancer for CVAT with capability-verified runtime controls and hierarchical presets.',
  minimum_chrome_version: '114',
  permissions: ['storage', 'activeTab', 'scripting'],
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  host_permissions: [
    'https://*.cvat.ai/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  background: {
    service_worker: 'src/entrypoints/background.ts',
    type: 'module',
  },
  action: {
    default_title: 'meow',
    default_popup: 'src/entrypoints/popup/index.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  content_scripts: [
    {
      matches: [
        'https://*.cvat.ai/*',
        'http://localhost/*',
        'http://127.0.0.1/*',
      ],
      js: ['src/entrypoints/content.ts'],
      run_at: 'document_start',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['assets/*', 'icons/*'],
      matches: ['https://*/*', 'http://*/*'],
    },
  ],
    content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
  },
} as never);
