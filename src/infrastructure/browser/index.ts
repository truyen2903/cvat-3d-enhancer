import { rootLogger } from '../../core/logger';
import { DEFAULT_AUTHORIZED_ORIGINS, STORAGE_KEYS } from '../../shared/constants';
import { ChromeLocalStorageAdapter, type KeyValueStorageAdapter } from '../storage';

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

export async function loadAuthorizedOrigins(
  storage: KeyValueStorageAdapter = new ChromeLocalStorageAdapter()
): Promise<readonly string[]> {
  try {
    const custom = await storage.get<unknown>(STORAGE_KEYS.AUTHORIZED_ORIGINS);
    if (Array.isArray(custom)) {
      const validCustom = custom.filter((item): item is string => typeof item === 'string');
      return Array.from(new Set([...DEFAULT_AUTHORIZED_ORIGINS, ...validCustom]));
    }
  } catch (err) {
    log.warn('Failed to read custom authorized origins from storage', err);
  }
  return [...DEFAULT_AUTHORIZED_ORIGINS];
}

export async function addAuthorizedOrigin(
  newOrigin: string,
  storage: KeyValueStorageAdapter = new ChromeLocalStorageAdapter()
): Promise<readonly string[]> {
  const parsed = new URL(newOrigin.trim());
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP/HTTPS origins can be authorized.');
  }
  const normalized = parsed.origin;
  const current = await loadAuthorizedOrigins(storage);
  const updated = Array.from(new Set([...current, normalized]));
  const customOnly = updated.filter((o) => !DEFAULT_AUTHORIZED_ORIGINS.includes(o));
  await storage.set(STORAGE_KEYS.AUTHORIZED_ORIGINS, customOnly);
  await syncDynamicContentScripts(storage);
  return updated;
}

export async function removeAuthorizedOrigin(
  originToRemove: string,
  storage: KeyValueStorageAdapter = new ChromeLocalStorageAdapter()
): Promise<readonly string[]> {
  const custom = await storage.get<unknown>(STORAGE_KEYS.AUTHORIZED_ORIGINS);
  const customOrigins = Array.isArray(custom)
    ? custom.filter((item): item is string => typeof item === 'string')
    : [];
  const nextCustom = customOrigins.filter((o) => o !== originToRemove);
  await storage.set(STORAGE_KEYS.AUTHORIZED_ORIGINS, nextCustom);
  await syncDynamicContentScripts(storage);
  return Array.from(new Set([...DEFAULT_AUTHORIZED_ORIGINS, ...nextCustom]));
}

/**
 * Registers persistent Manifest V3 dynamic content scripts for all user-authorized custom origins
 * so that refreshing (F5) or opening new tabs on that domain automatically runs the extension.
 */
export async function syncDynamicContentScripts(
  storage: KeyValueStorageAdapter = new ChromeLocalStorageAdapter()
): Promise<void> {
  if (
    typeof chrome === 'undefined' ||
    !chrome.scripting?.registerContentScripts ||
    !chrome.runtime?.getManifest
  ) {
    return;
  }

  try {
    const manifest = chrome.runtime.getManifest();
    const contentScriptFiles = manifest.content_scripts?.[0]?.js ?? [];
    if (contentScriptFiles.length === 0) {
      return;
    }

    const custom = await storage.get<unknown>(STORAGE_KEYS.AUTHORIZED_ORIGINS);
    const customOrigins = Array.isArray(custom)
      ? custom.filter((item): item is string => typeof item === 'string')
      : [];

    const scriptId = 'cvat-enhancer-dynamic-origins';
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    } catch {
      // Ignore if not previously registered
    }

    if (customOrigins.length === 0) {
      return;
    }

    const matches = customOrigins.map((origin) => `${origin}/*`);
    await chrome.scripting.registerContentScripts([
      {
        id: scriptId,
        js: contentScriptFiles,
        matches,
        runAt: 'document_start',
        persistAcrossSessions: true,
      },
    ]);
    log.info(`Registered persistent dynamic content scripts for ${matches.length} custom origin(s)`);
  } catch (err) {
    log.warn('Could not register dynamic content scripts (host permission may be required)', err);
  }
}

