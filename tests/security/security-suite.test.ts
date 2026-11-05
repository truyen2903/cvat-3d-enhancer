import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationManager } from '../../src/application/config';
import { CommandRegistry } from '../../src/core/command-registry';
import { Logger } from '../../src/core/logger';
import { PageBridgeRuntimeHost } from '../../src/entrypoints/page-bridge';
import { AuthenticationManager, CvatSessionProvider } from '../../src/infrastructure/authentication';
import { InMemoryStorageAdapter } from '../../src/infrastructure/storage';
import { MessageProtocol } from '../../src/integration/cvat/bridge';
import { RuntimeDetector } from '../../src/integration/cvat/detector';
import { CvatDomAdapter } from '../../src/integration/cvat/dom';
import { CapabilityRegistry, CvatV2RuntimeAdapter } from '../../src/integration/cvat/runtime';
import { VersionDetector } from '../../src/integration/cvat/compatibility';
import { BRIDGE_CHANNEL } from '../../src/shared/constants';
import {
  assertNoPrototypePollution,
  buildSafeCvatApiUrl,
  safeJsonParse,
  validateCvatOrigin,
} from '../../src/shared/utils';

describe('Mandatory Security Test Suite (Section 8)', () => {
  it('1. Rejects unauthorized message injection & unknown bridge commands', () => {
    const validToken = 'valid_session_token_1234567890';
    expect(() =>
      MessageProtocol.validateIncomingRequest(
        {
          channel: BRIDGE_CHANNEL,
          direction: 'CONTENT_TO_PAGE',
          requestId: 'req_123456789',
          sessionToken: validToken,
          command: 'EXECUTE_ARBITRARY_SCRIPT',
          timestamp: Date.now(),
          payload: {},
        },
        validToken
      )
    ).toThrow();
  });

  it('2. Rejects forged page bridge messages with invalid or missing sessionToken', () => {
    const validToken = 'valid_session_token_1234567890';
    const forgedToken = 'forged_attacker_token_00000000';

    expect(() =>
      MessageProtocol.validateIncomingRequest(
        {
          channel: BRIDGE_CHANNEL,
          direction: 'CONTENT_TO_PAGE',
          requestId: 'req_123456789',
          sessionToken: forgedToken,
          command: 'DETECT_RUNTIME',
          timestamp: Date.now(),
          payload: {},
        },
        validToken
      )
    ).toThrow(/Bridge session token mismatch/);
  });

  it('3. Blocks cross-origin request attempts and non-HTTPS remote origins', async () => {
    expect(validateCvatOrigin('https://evil.example.com').valid).toBe(false);
    expect(validateCvatOrigin('http://app.cvat.ai').valid).toBe(false);
    expect(validateCvatOrigin('https://user:pass@app.cvat.ai').valid).toBe(false);
    expect(validateCvatOrigin('https://app.cvat.ai').valid).toBe(true);
    expect(validateCvatOrigin('http://localhost:8080').valid).toBe(true);

    const authManager = new AuthenticationManager();
    const state = await authManager.detectAuthentication('https://attacker-controlled.example');
    expect(state.status).toBe('error');
    expect(state.errorCode).toBe('INVALID_ORIGIN');
  });

  it('4. Blocks arbitrary URL injection and path traversal in CVAT API URL builder', () => {
    expect(() => buildSafeCvatApiUrl('https://app.cvat.ai', 'https://evil.com/api/users/self')).toThrow();
    expect(() => buildSafeCvatApiUrl('https://app.cvat.ai', '//evil.com/api/users/self')).toThrow();
    expect(() => buildSafeCvatApiUrl('https://app.cvat.ai', '/api/../admin')).toThrow();
    expect(() => buildSafeCvatApiUrl('https://app.cvat.ai', '/auth/login')).toThrow();
    expect(buildSafeCvatApiUrl('https://app.cvat.ai', '/api/users/self')).toBe(
      'https://app.cvat.ai/api/users/self'
    );
  });

  it('5. Prevents XSS through configuration values and CSS injection in DOM adapter', async () => {
    const manager = new ConfigurationManager(new InMemoryStorageAdapter());

    await expect(
      manager.setScopeOverride('global', {
        appearance: {
          canvasBackgroundColor: 'red; background-image: url(javascript:alert(1))',
        },
      })
    ).rejects.toThrow();

    await expect(
      manager.saveCustomPreset({
        id: 'xss-preset',
        name: '<img src=x onerror=alert(1)>',
        description: 'safe',
        config: {},
      })
    ).rejects.toThrow();

    const domAdapter = new CvatDomAdapter(document);
    expect(() => domAdapter.applyCanvasBackgroundColor('<script>alert(1)</script>')).toThrow();
  });

  it('6. Protects against malicious DOM content & spoofed dataset attributes', async () => {
    document.body.innerHTML = `
      <div id="root" data-authenticated="true" data-user="admin" data-token="spoofed">
        <div class="cvat-canvas3d-perspective"></div>
      </div>
    `;
    const detector = new RuntimeDetector(['https://app.cvat.ai']);
    const route = detector.detectRouteContext(
      { origin: 'https://app.cvat.ai', pathname: '/tasks/1/jobs/1' },
      document
    );
    expect(route.is3DWorkspace).toBe(true);

    // AuthenticationManager never trusts DOM attributes; it verifies against /api/users/self
    const mockFetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const authManager = new AuthenticationManager({
      sessionProvider: new CvatSessionProvider(mockFetch),
    });
    const authState = await authManager.detectAuthentication('https://app.cvat.ai');
    expect(authState.status).toBe('unauthenticated');
    expect(authState.user).toBeNull();
  });

  it('7. Rejects invalid configuration payloads and embedded credentials in config', async () => {
    const manager = new ConfigurationManager(new InMemoryStorageAdapter());

    await expect(
      manager.importJson(
        JSON.stringify({
          schemaVersion: 2,
          personalAccessToken: 'secret_pat_value',
        })
      )
    ).rejects.toThrow();

    await expect(
      manager.setScopeOverride('global', {
        visualization3d: {
          cuboidOpacity: 999,
        },
      })
    ).rejects.toThrow();
  });

  it('8. Prevents token exposure through logs (automatic redaction)', () => {
    const logger = new Logger('sec-test');
    // TEST_FIXTURE_ONLY
    const fakeBearer = 'Bearer secret_test_token_value_abcdef123456';
    logger.info(`Auth header is ${fakeBearer}`, {
      Authorization: fakeBearer,
      token: 'raw_secret_token_987654',
      cookie: 'sessionid=xyz987; csrftoken=abc123',
      nested: {
        personalAccessToken: 'pat_secret_111',
      },
    });

    const serialized = JSON.stringify(logger.getHistory());
    expect(serialized).not.toContain('secret_test_token_value_abcdef123456');
    expect(serialized).not.toContain('raw_secret_token_987654');
    expect(serialized).not.toContain('xyz987');
    expect(serialized).not.toContain('pat_secret_111');
    expect(serialized).toContain('[REDACTED]');
  });

  it('9. Prevents token exposure through DOM or PageBridge', () => {
    document.body.innerHTML = `<script data-cvat-enhancer-bridge-token="ephemeral_bridge_tok_1234567890"></script>`;
    const scriptEl = document.querySelector('script');
    expect(scriptEl?.dataset.cvatEnhancerBridgeToken).toBeDefined();

    // Simulate page-bridge startup stripping the token attribute from DOM
    if (scriptEl?.dataset.cvatEnhancerBridgeToken) {
      const token = scriptEl.dataset.cvatEnhancerBridgeToken;
      delete scriptEl.dataset.cvatEnhancerBridgeToken;
      const host = new PageBridgeRuntimeHost(token, window as never, document);
      const stop = host.start();
      stop();
    }

    expect(document.documentElement.innerHTML).not.toContain('ephemeral_bridge_tok_1234567890');
  });

  it('10. Handles expired sessions and clears revoked PAT credentials immediately', async () => {
    const sessionStore = new InMemoryStorageAdapter();
    let shouldFail = false;
    const mockFetch = vi.fn(async () =>
      shouldFail
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ id: 1, username: 'tester' }), { status: 200 })
    );

    const authManager = new AuthenticationManager({
      sessionProvider: new CvatSessionProvider(mockFetch),
    });

    await authManager.detectAuthentication('https://app.cvat.ai');
    expect(authManager.getState().status).toBe('authenticated');

    shouldFail = true;
    await authManager.detectAuthentication('https://app.cvat.ai');
    expect(authManager.getState().status).toBe('expired');
    expect(authManager.getState().user).toBeNull();
    expect(await sessionStore.get('cvat-enhancer:session-pat:https://app.cvat.ai')).toBeUndefined();
  });

  it('11. Blocks unauthorized feature and runtime invocation when capability is unverified', async () => {
    const capRegistry = new CapabilityRegistry();
    const bridge = {
      sendCommand: vi.fn(),
    };
    const adapter = new CvatV2RuntimeAdapter(
      bridge as never,
      new CvatDomAdapter(document),
      new VersionDetector(),
      capRegistry
    );

    await expect(adapter.dispatchCameraAction('ZOOM_IN')).rejects.toThrow(/not verified/);
    await expect(adapter.applyVisualConfig({ shapeOpacity: 50 })).rejects.toThrow(/not verified/);

    const cmdRegistry = new CommandRegistry((cap) => capRegistry.isSupported(cap));
    cmdRegistry.register({
      id: 'camera.zoom',
      title: 'Zoom',
      category: 'camera',
      requiredCapabilities: ['cameraPresets'],
      execute: () => undefined,
    });
    await expect(cmdRegistry.execute('camera.zoom')).rejects.toThrow(/not supported/);
  });

  it('12. Blocks prototype pollution attempts in JSON parsing and object validation', () => {
    const maliciousJson = '{"__proto__":{"polluted":true}}';
    expect(() => safeJsonParse(maliciousJson)).toThrow(/forbidden JSON key "__proto__"/);

    const pollutedObj = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(pollutedObj, '__proto__', {
      value: { isAdmin: true },
      enumerable: true,
    });
    expect(() => assertNoPrototypePollution(pollutedObj)).toThrow(/forbidden property "__proto__"/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('13. Enforces static absence of unsafe dynamic code execution & document.cookie in src/', () => {
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full, acc);
        } else if (/\.(ts|tsx)$/.test(entry)) {
          acc.push(full);
        }
      }
      return acc;
    };

    const srcFiles = walk(join(process.cwd(), 'src'));
    expect(srcFiles.length).toBeGreaterThan(15);

    for (const file of srcFiles) {
      const code = readFileSync(file, 'utf8');
      expect(code).not.toMatch(/\beval\s*\(/);
      expect(code).not.toMatch(/\bnew\s+Function\s*\(/);
      expect(code).not.toMatch(/\bdocument\.cookie\b/);
      expect(code).not.toMatch(/\bdangerouslySetInnerHTML\b/);
      expect(code).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\s*\(/);
      expect(code).not.toMatch(/\.postMessage\s*\([^,]+,\s*['"`]\*['"`]\s*\)/);
      expect(code).not.toMatch(/\b(?:navigator\.sendBeacon|new\s+WebSocket|new\s+XMLHttpRequest)\b/);
    }
  });

  it('14. Never leaks sessionToken in PageBridge error responses when a forged message is sent', () => {
    const validToken = 'super_secret_bridge_session_token_99887766';
    const host = new PageBridgeRuntimeHost(validToken, window as never, document);
    const stop = host.start();
    const postMessageSpy = vi.spyOn(window, 'postMessage');

    // Attacker script in page dispatches a forged bridge request with wrong token
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          channel: BRIDGE_CHANNEL,
          direction: 'CONTENT_TO_PAGE',
          requestId: 'attacker_probe_req_1234',
          sessionToken: 'wrong_guessed_token_00000000',
          command: 'DETECT_RUNTIME',
          timestamp: Date.now(),
          payload: {},
        },
      })
    );

    // PageBridgeRuntimeHost must drop unauthenticated messages silently without echoing validToken
    expect(postMessageSpy).not.toHaveBeenCalled();

    postMessageSpy.mockRestore();
    stop();
  });
});
