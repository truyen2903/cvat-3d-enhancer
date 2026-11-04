import React, { useState } from 'react';
import type { ConfigurationScopeLevel } from '../../application/config';
import type { CapabilityDescriptor, CapabilitySupportStatus } from '../../shared/types';
import { useEnhancerUiStore } from '../settings/store';

export const CapabilityBadge: React.FC<{ readonly status: CapabilitySupportStatus }> = ({
  status,
}) => {
  const cls =
    status === 'supported'
      ? 'enhancer-badge badge-supported'
      : status === 'unsupported'
        ? 'enhancer-badge badge-unsupported'
        : 'enhancer-badge badge-unverified';

  return <span className={cls}>{status}</span>;
};

export const CapabilityStatusRow: React.FC<{ readonly cap: CapabilityDescriptor }> = ({ cap }) => (
  <div
    style={{
      borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
      paddingBottom: '6px',
      marginBottom: '4px',
    }}
  >
    <div className="enhancer-row">
      <span style={{ fontWeight: 600 }}>{cap.name}</span>
      <CapabilityBadge status={cap.status} />
    </div>
    <div className="enhancer-muted" style={{ marginTop: '2px' }}>
      {cap.reason}
    </div>
  </div>
);

export const ScopeSelectorBar: React.FC = () => {
  const activeScopeLevel = useEnhancerUiStore((s) => s.activeScopeLevel);
  const setActiveScopeLevel = useEnhancerUiStore((s) => s.setActiveScopeLevel);
  const routeContext = useEnhancerUiStore((s) => s.routeContext);

  const scopes: { readonly id: ConfigurationScopeLevel; readonly label: string; readonly disabled: boolean }[] = [
    { id: 'global', label: 'Global', disabled: false },
    {
      id: 'project',
      label: routeContext.projectId ? `Project #${routeContext.projectId}` : 'Project (N/A)',
      disabled: !routeContext.projectId,
    },
    {
      id: 'task',
      label: routeContext.taskId ? `Task #${routeContext.taskId}` : 'Task (N/A)',
      disabled: !routeContext.taskId,
    },
  ];

  return (
    <div className="enhancer-row" style={{ gap: '4px' }}>
      <span className="enhancer-muted">Scope:</span>
      <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
        {scopes.map((sc) => (
          <button
            key={sc.id}
            type="button"
            disabled={sc.disabled}
            onClick={() => setActiveScopeLevel(sc.id)}
            className={`enhancer-btn ${activeScopeLevel === sc.id ? 'enhancer-btn-primary' : ''}`}
            style={{ flex: 1, padding: '3px 6px', fontSize: '10px' }}
          >
            {sc.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export const AuthStatusCard: React.FC = () => {
  const authState = useEnhancerUiStore((s) => s.authState);
  const handlers = useEnhancerUiStore((s) => s.handlers);
  const [patInput, setPatInput] = useState('');
  const [showPatForm, setShowPatForm] = useState(false);

  const handlePatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handlers || !patInput.trim()) {
      return;
    }
    const tokenToSubmit = patInput;
    setPatInput('');
    setShowPatForm(false);
    await handlers.connectPat(tokenToSubmit);
  };

  return (
    <div className="enhancer-card">
      <div className="enhancer-row">
        <span className="enhancer-card-title">CVAT Authentication</span>
        <span
          className={`enhancer-badge ${
            authState.status === 'authenticated'
              ? 'badge-supported'
              : authState.status === 'checking'
                ? 'badge-unverified'
                : 'badge-unsupported'
          }`}
        >
          {authState.status}
        </span>
      </div>

      {authState.status === 'authenticated' && authState.user ? (
        <div className="enhancer-row">
          <div>
            <div style={{ fontWeight: 600 }}>User: {authState.user.username}</div>
            <div className="enhancer-muted">
              Method: {authState.method === 'session' ? 'CVAT Browser Session' : 'Session PAT'}
            </div>
          </div>
          {authState.method === 'pat' && handlers && (
            <button
              type="button"
              className="enhancer-btn enhancer-btn-danger"
              onClick={() => void handlers.disconnectAuth()}
            >
              Clear PAT
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="enhancer-muted">
            {authState.errorMessage ?? 'Not authenticated with current CVAT origin.'}
          </div>
          <div className="enhancer-row" style={{ marginTop: '6px' }}>
            <button
              type="button"
              className="enhancer-btn"
              onClick={() => handlers && void handlers.refreshAuthAndRuntime()}
            >
              Re-check Session
            </button>
            <button
              type="button"
              className="enhancer-btn"
              onClick={() => setShowPatForm((prev) => !prev)}
            >
              {showPatForm ? 'Cancel PAT' : 'Use Optional PAT'}
            </button>
          </div>

          {showPatForm && (
            <form onSubmit={(e) => void handlePatSubmit(e)} style={{ marginTop: '6px' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder="Paste CVAT Personal Access Token..."
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
                className="enhancer-input"
              />
              <div className="enhancer-muted" style={{ marginTop: '3px', fontSize: '10px' }}>
                Stored only in ephemeral session memory. Never written to local disk or DOM.
              </div>
              <button
                type="submit"
                className="enhancer-btn enhancer-btn-primary"
                style={{ marginTop: '6px', width: '100%' }}
              >
                Verify & Connect PAT
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
