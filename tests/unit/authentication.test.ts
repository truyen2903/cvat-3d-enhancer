import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationManager,
  CvatSessionProvider,
  PersonalAccessTokenProvider,
} from '../../src/infrastructure/authentication';
import { InMemoryStorageAdapter } from '../../src/infrastructure/storage';

describe('CVAT Auto Authentication & PAT Fallback', () => {
  it('prefers existing authenticated CVAT browser session (/api/users/self)', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 7, username: 'lidar_annotator', is_staff: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const sessionProvider = new CvatSessionProvider(mockFetch);
    const patProvider = new PersonalAccessTokenProvider(new InMemoryStorageAdapter(), mockFetch);
    const authManager = new AuthenticationManager({ sessionProvider, patProvider });

    const state = await authManager.detectAuthentication('https://app.cvat.ai');
    expect(state.status).toBe('authenticated');
    expect(state.method).toBe('session');
    expect(state.user?.username).toBe('lidar_annotator');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://app.cvat.ai/api/users/self',
      expect.objectContaining({ credentials: 'same-origin' })
    );
  });

  it('transitions to expired status when a previously active session returns 401', async () => {
    let statusCode = 200;
    const mockFetch = vi.fn(async () =>
      statusCode === 200
        ? new Response(JSON.stringify({ id: 7, username: 'lidar_annotator' }), { status: 200 })
        : new Response(JSON.stringify({ detail: 'Not authenticated' }), { status: 401 })
    );

    const sessionProvider = new CvatSessionProvider(mockFetch);
    const authManager = new AuthenticationManager({ sessionProvider });

    const first = await authManager.detectAuthentication('https://app.cvat.ai');
    expect(first.status).toBe('authenticated');

    statusCode = 401;
    const second = await authManager.detectAuthentication('https://app.cvat.ai');
    expect(second.status).toBe('expired');
    expect(second.errorCode).toBe('SESSION_EXPIRED');
    expect(second.user).toBeNull();
  });

  it('authenticates with optional PAT and clears PAT from session storage upon 401 revocation', async () => {
    const sessionStore = new InMemoryStorageAdapter();
    let patValid = true;

    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization && patValid) {
        return new Response(JSON.stringify({ id: 42, username: 'pat_user' }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: 'Invalid token' }), { status: 401 });
    });

    const sessionProvider = new CvatSessionProvider(mockFetch);
    const patProvider = new PersonalAccessTokenProvider(sessionStore, mockFetch);
    const authManager = new AuthenticationManager({ sessionProvider, patProvider });

    // TEST_FIXTURE_ONLY
    const connected = await authManager.connectWithPersonalAccessToken(
      'https://app.cvat.ai',
      'test_pat_fixture_token_123456'
    );
    expect(connected.status).toBe('authenticated');
    expect(connected.method).toBe('pat');
    expect(await patProvider.hasToken('https://app.cvat.ai')).toBe(true);

    // Simulate token revocation on server
    patValid = false;
    const afterRevoke = await authManager.detectAuthentication('https://app.cvat.ai');
    expect(afterRevoke.status).toBe('expired');
    expect(afterRevoke.errorCode).toBe('TOKEN_REVOKED');
    expect(await patProvider.hasToken('https://app.cvat.ai')).toBe(false);
  });
});
