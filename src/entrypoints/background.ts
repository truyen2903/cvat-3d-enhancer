import { rootLogger } from '../core/logger';
import {
  configureTrustedSessionStorageAccess,
  syncDynamicContentScripts,
} from '../infrastructure/browser';
import { handleBackgroundMessage } from '../infrastructure/messaging';

const log = rootLogger.child('background');

void configureTrustedSessionStorageAccess();
void syncDynamicContentScripts();

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    log.info(`CVAT 3D Enhancer installed/updated (${details.reason})`);
    void configureTrustedSessionStorageAccess();
    void syncDynamicContentScripts();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const senderOrigin = sender.url ? new URL(sender.url).origin : undefined;
    const response = handleBackgroundMessage(message, senderOrigin);
    sendResponse(response);
    return false;
  });
}
