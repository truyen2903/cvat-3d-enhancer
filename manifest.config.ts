import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Meow',
  version: '0.1.0',
  description:
    'Meow — make your workspace feel like home.',
  icons: { 16: 'assets/meow-16.png', 32: 'assets/meow-32.png', 48: 'assets/meow-48.png', 128: 'assets/meow-128.png' },
  minimum_chrome_version: '114',
  permissions: ['storage', 'activeTab', 'scripting'],
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
    default_title: 'Meow',
    default_icon: { 16: 'assets/meow-16.png', 32: 'assets/meow-32.png', 48: 'assets/meow-48.png', 128: 'assets/meow-128.png' },
    default_popup: 'src/entrypoints/popup/index.html',
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
      resources: ['assets/*'],
      matches: ['https://*/*', 'http://*/*'],
    },
  ],
    content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none';",
  },
} as never);
