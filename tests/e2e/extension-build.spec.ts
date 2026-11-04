import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('Manifest V3 build output exists and enforces strict CSP', () => {
  const manifestPath = join(process.cwd(), 'dist', 'manifest.json');
  expect(existsSync(manifestPath)).toBe(true);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    manifest_version: number;
    permissions: string[];
    content_security_policy: { extension_pages: string };
  };

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['storage']);
  expect(manifest.content_security_policy.extension_pages).toContain("script-src 'self'");
  expect(manifest.content_security_policy.extension_pages).not.toContain('unsafe-eval');
});
