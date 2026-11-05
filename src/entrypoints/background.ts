import { rootLogger } from '../core/logger';
import {
  configureTrustedSessionStorageAccess,
  syncDynamicContentScripts,
} from '../infrastructure/browser';
import { handleBackgroundMessage } from '../infrastructure/messaging';

const log = rootLogger.child('background');

void configureTrustedSessionStorageAccess();
void syncDynamicContentScripts();

if (typeof chrome !== 'undefined' && chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    void syncDynamicContentScripts();
  });
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes['cvat-enhancer:authorized-origins']) {
      void syncDynamicContentScripts();
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    log.info(`CVAT 3D Enhancer installed/updated (${details.reason})`);
    void configureTrustedSessionStorageAccess();
    void syncDynamicContentScripts();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Reject messages from other extensions
    if (chrome.runtime?.id && sender.id && sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: 'Unauthorized sender extension' });
      return false;
    }

    if (
      typeof message === 'object' &&
      message !== null &&
      (message as Record<string, unknown>).type === 'ACTIVATE_ON_TAB'
    ) {
      // Only trusted extension pages (e.g. popup, where sender.tab is undefined) may trigger script injection
      if (sender.tab !== undefined) {
        sendResponse({ ok: false, error: 'ACTIVATE_ON_TAB requires a trusted extension page context' });
        return false;
      }
      const msg = message as { tabId?: number; origin?: string };
      void (async () => {
        try {
          await syncDynamicContentScripts();
          if (
            typeof msg.tabId === 'number' &&
            Number.isInteger(msg.tabId) &&
            msg.tabId >= 0 &&
            chrome.scripting &&
            chrome.runtime?.getManifest
          ) {
            const manifest = chrome.runtime.getManifest();
            const files = manifest.content_scripts?.[0]?.js ?? [];
            if (files.length > 0) {
              await chrome.scripting.executeScript({
                target: { tabId: msg.tabId },
                files,
              });
            }
          }
          sendResponse({ ok: true });
        } catch (err) {
          log.error('Failed to activate on tab from background', err);
          sendResponse({ ok: false });
        }
      })();
      return true;
    }

    const senderOrigin = sender.url ? new URL(sender.url).origin : undefined;
    const response = handleBackgroundMessage(message, senderOrigin);
    sendResponse(response);
    return false;
  });
}
