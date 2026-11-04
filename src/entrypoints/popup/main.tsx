import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigurationManager } from '../../application/config';
import {
  addAuthorizedOrigin,
  loadAuthorizedOrigins,
  removeAuthorizedOrigin,
} from '../../infrastructure/browser';
import { DEFAULT_AUTHORIZED_ORIGINS } from '../../shared/constants';
import type { EnhancerConfig } from '../../shared/types';

export const PopupApp: React.FC = () => {
  const [config, setConfig] = useState<EnhancerConfig | null>(null);
  const [authorizedOrigins, setAuthorizedOrigins] = useState<readonly string[]>([]);
  const [activeTabOrigin, setActiveTabOrigin] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [customUrlInput, setCustomUrlInput] = useState('');
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
              setCustomUrlInput(parsed.origin);
            }
          } catch {
            // Ignore internal browser URLs (e.g. chrome://)
          }
        }
      });
    }
  }, []);

  const authorizeAndInjectOrigin = async (rawOriginInput: string) => {
    let normalizedOrigin: string;
    try {
      const parsed = new URL(rawOriginInput.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        setStatusMessage('Only http:// or https:// URLs are supported.');
        return;
      }
      normalizedOrigin = parsed.origin;
    } catch {
      setStatusMessage('Invalid URL format. Example: https://your-cvat-domain.com');
      return;
    }

    try {
      // 1. Trigger permission request synchronously inside user click gesture
      const permPromise =
        typeof chrome !== 'undefined' && chrome.permissions?.request
          ? chrome.permissions.request({ origins: [`${normalizedOrigin}/*`] }).catch(() => false)
          : Promise.resolve(true);

      // 2. Immediately persist in local storage (never in source code) and notify background worker
      const updated = await addAuthorizedOrigin(normalizedOrigin);
      setAuthorizedOrigins(updated);

      const targetTabId = activeTabOrigin === normalizedOrigin ? activeTabId : undefined;

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'ACTIVATE_ON_TAB',
          tabId: targetTabId,
          origin: normalizedOrigin,
        });
      }

      await permPromise;

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'ACTIVATE_ON_TAB',
          tabId: targetTabId,
          origin: normalizedOrigin,
        });
      }

      setCustomUrlInput('');
      setStatusMessage(`Added & activated ${normalizedOrigin}!`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to add domain.');
    }
  };

  const handleRemoveOrigin = async (origin: string) => {
    const updated = await removeAuthorizedOrigin(origin);
    setAuthorizedOrigins(updated);
    setStatusMessage(`Removed ${origin} from custom origins.`);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customUrlInput.trim()) return;
    void authorizeAndInjectOrigin(customUrlInput);
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

      <div
        style={{
          background: '#1e293b',
          border: '1px solid #38bdf8',
          borderRadius: '8px',
          padding: '10px',
          marginBottom: '10px',
        }}
      >
        <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: '6px', fontSize: '11px' }}>
          ADD PRIVATE CVAT DOMAIN / LINK
        </div>

        <form onSubmit={handleAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <input
            type="text"
            placeholder="https://your-private-cvat-domain.com"
            value={customUrlInput}
            onChange={(e) => setCustomUrlInput(e.target.value)}
            style={{
              width: '100%',
              background: '#0f172a',
              color: '#f8fafc',
              border: '1px solid #334155',
              borderRadius: '6px',
              padding: '6px 8px',
              fontSize: '11px',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="submit"
              style={{
                flex: 1,
                background: '#38bdf8',
                color: '#020617',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 8px',
                fontWeight: 700,
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              + Add & Activate Link
            </button>
            {activeTabOrigin && (
              <button
                type="button"
                onClick={() => void authorizeAndInjectOrigin(activeTabOrigin)}
                style={{
                  background: '#334155',
                  color: '#f8fafc',
                  border: '1px solid #475569',
                  borderRadius: '6px',
                  padding: '6px 8px',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Use Current Tab
              </button>
            )}
          </div>
        </form>

        <div style={{ color: '#94a3b8', fontSize: '10px', marginTop: '5px' }}>
          Stored locally in your browser only — never hardcoded in source code or Git.
        </div>

        {statusMessage && (
          <div style={{ marginTop: '6px', color: '#34d399', fontSize: '11px', fontWeight: 600 }}>
            {statusMessage}
          </div>
        )}
      </div>

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
          AUTHORIZED CVAT LINKS ({authorizedOrigins.length})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {authorizedOrigins.map((origin) => {
            const isDefault = DEFAULT_AUTHORIZED_ORIGINS.includes(origin);
            return (
              <div
                key={origin}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#0f172a',
                  padding: '4px 8px',
                  borderRadius: '5px',
                  border: '1px solid #1e293b',
                }}
              >
                <span style={{ color: '#e2e8f0', fontSize: '11px', wordBreak: 'break-all' }}>
                  {origin}
                </span>
                {!isDefault ? (
                  <button
                    type="button"
                    onClick={() => void handleRemoveOrigin(origin)}
                    style={{
                      background: 'rgba(239, 68, 68, 0.2)',
                      color: '#fca5a5',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      borderRadius: '4px',
                      padding: '1px 6px',
                      fontSize: '10px',
                      cursor: 'pointer',
                      marginLeft: '6px',
                    }}
                  >
                    Remove
                  </button>
                ) : (
                  <span style={{ color: '#64748b', fontSize: '10px', marginLeft: '6px' }}>
                    default
                  </span>
                )}
              </div>
            );
          })}
        </div>
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
