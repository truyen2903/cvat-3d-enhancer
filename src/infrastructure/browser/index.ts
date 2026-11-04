import { rootLogger } from '../../core/logger';

const log = rootLogger.child('browser-runtime');

export function getExtensionRuntimeUrl(assetPath: string): string | null {
  if (assetPath.includes('..') || /^https?:/i.test(assetPath)) {
    throw new Error(`Unsafe extension asset path rejected: "${assetPath}"`);
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(assetPath);
  }
  return null;
}

export async function configureTrustedSessionStorageAccess(): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.setAccessLevel) {
    try {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_CONTEXTS',
      });
      log.info('Configured chrome.storage.session accessLevel to TRUSTED_CONTEXTS');
    } catch (err) {
      log.warn('Failed to set chrome.storage.session accessLevel', err);
    }
  }
}
