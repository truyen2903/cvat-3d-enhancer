import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigurationManager } from '../../application/config';
import { DEFAULT_AUTHORIZED_ORIGINS } from '../../shared/constants';
import type { EnhancerConfig } from '../../shared/types';

export const PopupApp: React.FC = () => {
  const [config, setConfig] = useState<EnhancerConfig | null>(null);

  useEffect(() => {
    const manager = new ConfigurationManager();
    void manager.resolveEffectiveConfig().then(setConfig);
  }, []);

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

      <p style={{ color: '#94a3b8', margin: '0 0 10px 0', lineHeight: 1.45 }}>
        Open an authorized CVAT 3D annotation workspace to access the Shadow DOM Floating Panel,
        capability matrix, and runtime controls.
      </p>

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
        {DEFAULT_AUTHORIZED_ORIGINS.map((origin) => (
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
