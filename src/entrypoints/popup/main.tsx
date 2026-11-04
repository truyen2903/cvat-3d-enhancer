import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigurationManager } from '../../application/config';
import { addAuthorizedOrigin, loadAuthorizedOrigins } from '../../infrastructure/browser';
import type { EnhancerConfig } from '../../shared/types';

export const PopupApp: React.FC = () => {
  const [config, setConfig] = useState<EnhancerConfig | null>(null);
  const [authorizedOrigins, setAuthorizedOrigins] = useState<readonly string[]>([]);
  const [activeTabOrigin, setActiveTabOrigin] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    const manager = new ConfigurationManager();
    void manager.resolveEffectiveConfig().then(setConfig);
    void loadAuthorizedOrigins().then(setAuthorizedOrigins);

    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentTab = tabs[0];
        if (currentTab?.url && currentTab.id !== undefined) {
          try {
            const parsed = new URL(currentTab.url);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
              setActiveTabOrigin(parsed.origin);
              setActiveTabId(currentTab.id);
            }
          } catch {
            // Ignore non-standard browser URLs (e.g. chrome://)
          }
        }
      });
    }
  }, []);

  const handleActivateOnCurrentTab = async () => {
    if (!activeTabOrigin || activeTabId === null) {
      return;
    }
    try {
      // 1. Trigger permission request synchronously inside user click gesture (before any await)
      const permPromise =
        typeof chrome !== 'undefined' && chrome.permissions?.request
          ? chrome.permissions.request({ origins: [`${activeTabOrigin}/*`] }).catch(() => false)
          : Promise.resolve(true);

      // 2. Immediately persist the origin and notify background service worker in parallel
      // so even if Chrome closes the popup when the permission dialog opens, it is already saved!
      const updated = await addAuthorizedOrigin(activeTabOrigin);
      setAuthorizedOrigins(updated);

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'ACTIVATE_ON_TAB',
          tabId: activeTabId,
          origin: activeTabOrigin,
        });
      }

      await permPromise;

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'ACTIVATE_ON_TAB',
          tabId: activeTabId,
          origin: activeTabOrigin,
        });
      }

      setStatusMessage(
        `Activated & persisted on ${activeTabOrigin}! It will now auto-start on F5.`
      );
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Failed to activate on current tab.'
      );
    }
  };

  return (
    <div style={{ padding: '14px', fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <span
          style={{
            width: '9px',
            height: '9px',
            borderRadius: '999px',
            background: '#38bdf8',
            display: 'inline-block',
          }}
        />
        <strong style={{ fontSize: '14px' }}>CVAT 3D Enhancer</strong>
      </div>

      {activeTabOrigin && (
        <div
          style={{
            background: '#1e293b',
            border: '1px solid #38bdf8',
            borderRadius: '8px',
            padding: '10px',
            marginBottom: '10px',
          }}
        >
          <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: '4px', fontSize: '11px' }}>
            CURRENT TAB ORIGIN
          </div>
          <div style={{ color: '#38bdf8', fontWeight: 600, marginBottom: '8px' }}>
            {activeTabOrigin}
          </div>
          <button
            type="button"
            onClick={() => void handleActivateOnCurrentTab()}
            style={{
              width: '100%',
              background: '#38bdf8',
              color: '#020617',
              border: 'none',
              borderRadius: '6px',
              padding: '7px 10px',
              fontWeight: 700,
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            Authorize & Activate on This Tab
          </button>
          {statusMessage && (
            <div style={{ marginTop: '6px', color: '#34d399', fontSize: '11px' }}>
              {statusMessage}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '8px',
          padding: '10px',
          marginBottom: '10px',
        }}
      >
        <div style={{ fontWeight: 700, color: '#94a3b8', marginBottom: '6px', fontSize: '11px' }}>
          AUTHORIZED CVAT ORIGINS
        </div>
        {authorizedOrigins.map((origin) => (
          <div key={origin} style={{ color: '#e2e8f0', fontSize: '11px', marginBottom: '2px' }}>
            • {origin}
          </div>
        ))}
      </div>

      {config && (
        <div
          style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
            padding: '10px',
          }}
        >
          <div style={{ fontWeight: 700, color: '#94a3b8', marginBottom: '6px', fontSize: '11px' }}>
            GLOBAL CONFIGURATION SUMMARY
          </div>
          <div>Theme Preset: {config.appearance.themePreset}</div>
          <div>Cuboid Opacity: {config.visualization3d.cuboidOpacity}%</div>
          <div>Color-By Mode: {config.annotation.colorBy}</div>
          <div>Toggle Shortcut: {config.productivity.togglePanelShortcut}</div>
        </div>
      )}
    </div>
  );
};

const container = document.getElementById('popup-root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <PopupApp />
    </React.StrictMode>
  );
}
