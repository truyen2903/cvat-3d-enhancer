import { rootLogger } from '../../core/logger';
import { DEFAULT_AUTHORIZED_ORIGINS, getSessionPatStorageKey } from '../../shared/constants';
import { CvatUserApiResponseSchema } from '../../shared/schemas';
import type { AuthenticatedUser, AuthenticationState, AuthMethod } from '../../shared/types';
import { buildSafeCvatApiUrl, validateCvatOrigin } from '../../shared/utils';
import { EphemeralSessionStorageAdapter, type KeyValueStorageAdapter } from '../storage';

export type AuthenticationErrorCode =
  | 'INVALID_ORIGIN'
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'INVALID_PAT_FORMAT';

export class AuthenticationError extends Error {
  public readonly code: AuthenticationErrorCode;
  public readonly status?: number;

  public constructor(code: AuthenticationErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuthenticationProvider {
  readonly method: Exclude<AuthMethod, 'none'>;
  verify(origin: string): Promise<AuthenticatedUser>;
  clear(origin: string): Promise<void>;
}

/**
 * Capability interface exposed to read-only consumers so feature modules cannot
 * inspect raw tokens or invoke credential mutations directly.
 */
export interface AuthReadCapability {
  getState(): AuthenticationState;
  isAuthenticated(): boolean;
}

/**
 * Authenticates using the browser's existing same-origin CVAT session.
 * Never reads browser cookies via DOM APIs or localStorage. Uses standard same-origin fetch
 * with `credentials: 'same-origin'`.
 */
export class CvatSessionProvider implements AuthenticationProvider {
  public readonly method = 'session' as const;
  private readonly fetchImpl: FetchLike;
  private readonly authorizedOrigins: readonly string[];

  public constructor(
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
    authorizedOrigins: readonly string[] = DEFAULT_AUTHORIZED_ORIGINS
  ) {
    this.fetchImpl = fetchImpl;
    this.authorizedOrigins = authorizedOrigins;
  }

  public async verify(origin: string): Promise<AuthenticatedUser> {
    const endpoint = buildSafeCvatApiUrl(origin, '/api/users/self', this.authorizedOrigins);

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });
    } catch {
      throw new AuthenticationError(
        'NETWORK_ERROR',
        'Unable to reach CVAT authentication endpoint.'
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(
        'UNAUTHENTICATED',
        'No active CVAT browser session detected. Please sign in to CVAT.',
        response.status
      );
    }

    if (!response.ok) {
      throw new AuthenticationError(
        'NETWORK_ERROR',
        `CVAT endpoint returned HTTP ${response.status}.`,
        response.status
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      throw new AuthenticationError('INVALID_RESPONSE', 'Malformed JSON from /api/users/self.');
    }

    const parsed = CvatUserApiResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new AuthenticationError('INVALID_RESPONSE', 'Unexpected user payload structure.');
    }

    return {
      id: parsed.data.id,
      username: parsed.data.username,
      email: parsed.data.email,
      isStaff: parsed.data.is_staff,
    };
  }

  public async clear(_origin: string): Promise<void> {
    // Browser session cookies are managed exclusively by CVAT itself.
  }
}

/**
 * Optional Personal Access Token (PAT) provider using `Authorization: Bearer <token>`.
 * Stores token only in ephemeral session storage (in-memory / chrome.storage.session).
 * Never logs or exposes the token to page scripts or DOM.
 */
export class PersonalAccessTokenProvider implements AuthenticationProvider {
  public readonly method = 'pat' as const;
  private readonly sessionStore: KeyValueStorageAdapter;
  private readonly fetchImpl: FetchLike;
  private readonly authorizedOrigins: readonly string[];

  public constructor(
    sessionStore: KeyValueStorageAdapter = new EphemeralSessionStorageAdapter(),
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
    authorizedOrigins: readonly string[] = DEFAULT_AUTHORIZED_ORIGINS
  ) {
    this.sessionStore = sessionStore;
    this.fetchImpl = fetchImpl;
    this.authorizedOrigins = authorizedOrigins;
  }

  public async setToken(origin: string, rawToken: string): Promise<void> {
    const check = validateCvatOrigin(origin, this.authorizedOrigins);
    if (!check.valid || !check.normalizedOrigin) {
      throw new AuthenticationError(
        'INVALID_ORIGIN',
        check.reason ?? 'Unauthorized CVAT origin for PAT configuration.'
      );
    }

    const trimmed = rawToken.trim();
    if (trimmed.length < 12 || trimmed.length > 512 || /\s/.test(trimmed)) {
      throw new AuthenticationError(
        'INVALID_PAT_FORMAT',
        'Personal Access Token format is invalid.'
      );
    }

    await this.sessionStore.set(getSessionPatStorageKey(check.normalizedOrigin), trimmed);
  }

  public async hasToken(origin: string): Promise<boolean> {
    const check = validateCvatOrigin(origin, this.authorizedOrigins);
    if (!check.valid || !check.normalizedOrigin) {
      return false;
    }
    const token = await this.sessionStore.get<string>(
      getSessionPatStorageKey(check.normalizedOrigin)
    );
    return typeof token === 'string' && token.length > 0;
  }

  public async verify(origin: string): Promise<AuthenticatedUser> {
    const check = validateCvatOrigin(origin, this.authorizedOrigins);
    if (!check.valid || !check.normalizedOrigin) {
      throw new AuthenticationError('INVALID_ORIGIN', check.reason ?? 'Unauthorized CVAT origin.');
    }

    const token = await this.sessionStore.get<string>(
      getSessionPatStorageKey(check.normalizedOrigin)
    );
    if (!token) {
      throw new AuthenticationError('UNAUTHENTICATED', 'No Personal Access Token configured.');
    }

    const endpoint = buildSafeCvatApiUrl(
      check.normalizedOrigin,
      '/api/users/self',
      this.authorizedOrigins
    );

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new AuthenticationError('NETWORK_ERROR', 'Network error while verifying PAT.');
    }

    if (response.status === 401 || response.status === 403) {
      await this.clear(check.normalizedOrigin);
      throw new AuthenticationError(
        'TOKEN_REVOKED',
        'Personal Access Token is expired or revoked. It has been cleared from session memory.',
        response.status
      );
    }

    if (!response.ok) {
      throw new AuthenticationError(
        'NETWORK_ERROR',
        `CVAT endpoint returned HTTP ${response.status}.`,
        response.status
      );
    }

    const rawJson: unknown = await response.json();
    const parsed = CvatUserApiResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new AuthenticationError('INVALID_RESPONSE', 'Unexpected user payload structure.');
    }

    return {
      id: parsed.data.id,
      username: parsed.data.username,
      email: parsed.data.email,
      isStaff: parsed.data.is_staff,
    };
  }

  public async clear(origin: string): Promise<void> {
    const check = validateCvatOrigin(origin, this.authorizedOrigins);
    if (check.normalizedOrigin) {
      await this.sessionStore.remove(getSessionPatStorageKey(check.normalizedOrigin));
    }
  }
}

export interface AuthenticationManagerOptions {
  readonly sessionProvider?: CvatSessionProvider;
  readonly patProvider?: PersonalAccessTokenProvider;
  readonly authorizedOrigins?: readonly string[];
  readonly onStateChange?: (state: AuthenticationState) => void;
}

/**
 * Coordinates CVAT authentication detection:
 * 1. Validates current CVAT origin against allowlist & HTTPS policy.
 * 2. Prefers existing authenticated CVAT browser session (/api/users/self).
 * 3. Falls back to optional Personal Access Token (PAT) if configured for the session.
 * 4. Clears sensitive data upon expiration, revocation, or explicit disconnect.
 */
export class AuthenticationManager {
  private readonly sessionProvider: CvatSessionProvider;
  private readonly patProvider: PersonalAccessTokenProvider;
  private readonly authorizedOrigins: readonly string[];
  private readonly onStateChange?: (state: AuthenticationState) => void;
  private readonly log = rootLogger.child('auth-manager');
  private state: AuthenticationState = {
    status: 'unauthenticated',
    method: 'none',
    origin: null,
    user: null,
    lastCheckedAt: null,
    errorCode: null,
    errorMessage: null,
  };

  public constructor(options: AuthenticationManagerOptions = {}) {
    this.authorizedOrigins = options.authorizedOrigins ?? DEFAULT_AUTHORIZED_ORIGINS;
    this.sessionProvider =
      options.sessionProvider ?? new CvatSessionProvider(undefined, this.authorizedOrigins);
    this.patProvider =
      options.patProvider ??
      new PersonalAccessTokenProvider(undefined, undefined, this.authorizedOrigins);
    this.onStateChange = options.onStateChange;
  }

  public getState(): AuthenticationState {
    return { ...this.state };
  }

  public getReadCapability(): AuthReadCapability {
    return Object.freeze({
      getState: () => this.getState(),
      isAuthenticated: () => this.state.status === 'authenticated',
    });
  }

  public async detectAuthentication(origin: string): Promise<AuthenticationState> {
    const originCheck = validateCvatOrigin(origin, this.authorizedOrigins);
    if (!originCheck.valid || !originCheck.normalizedOrigin) {
      return this.updateState({
        status: 'error',
        method: 'none',
        origin: null,
        user: null,
        lastCheckedAt: Date.now(),
        errorCode: 'INVALID_ORIGIN',
        errorMessage: originCheck.reason ?? 'Untrusted origin.',
      });
    }

    const normalizedOrigin = originCheck.normalizedOrigin;
    const previouslyAuthenticated =
      this.state.status === 'authenticated' && this.state.origin === normalizedOrigin;

    this.updateState({
      ...this.state,
      status: 'checking',
      origin: normalizedOrigin,
      errorCode: null,
      errorMessage: null,
    });

    // 1. Prefer existing CVAT browser session
    try {
      const sessionUser = await this.sessionProvider.verify(normalizedOrigin);
      this.log.info(`Authenticated via CVAT session as user #${sessionUser.id}`);
      return this.updateState({
        status: 'authenticated',
        method: 'session',
        origin: normalizedOrigin,
        user: sessionUser,
        lastCheckedAt: Date.now(),
        errorCode: null,
        errorMessage: null,
      });
    } catch (sessionErr) {
      // If session is not active, check if an optional PAT is present
      const hasPat = await this.patProvider.hasToken(normalizedOrigin);
      if (hasPat) {
        try {
          const patUser = await this.patProvider.verify(normalizedOrigin);
          this.log.info(`Authenticated via Personal Access Token as user #${patUser.id}`);
          return this.updateState({
            status: 'authenticated',
            method: 'pat',
            origin: normalizedOrigin,
            user: patUser,
            lastCheckedAt: Date.now(),
            errorCode: null,
            errorMessage: null,
          });
        } catch (patErr) {
          const authErr =
            patErr instanceof AuthenticationError
              ? patErr
              : new AuthenticationError('NETWORK_ERROR', 'PAT verification failed');
          return this.updateState({
            status: authErr.code === 'TOKEN_REVOKED' ? 'expired' : 'error',
            method: 'none',
            origin: normalizedOrigin,
            user: null,
            lastCheckedAt: Date.now(),
            errorCode: authErr.code,
            errorMessage: authErr.message,
          });
        }
      }

      const sErr =
        sessionErr instanceof AuthenticationError
          ? sessionErr
          : new AuthenticationError('NETWORK_ERROR', 'Session check failed');

      if (sErr.code === 'UNAUTHENTICATED') {
        return this.updateState({
          status: previouslyAuthenticated ? 'expired' : 'unauthenticated',
          method: 'none',
          origin: normalizedOrigin,
          user: null,
          lastCheckedAt: Date.now(),
          errorCode: previouslyAuthenticated ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED',
          errorMessage: previouslyAuthenticated
            ? 'Your CVAT session has expired. Please sign in to CVAT again.'
            : sErr.message,
        });
      }

      return this.updateState({
        status: 'error',
        method: 'none',
        origin: normalizedOrigin,
        user: null,
        lastCheckedAt: Date.now(),
        errorCode: sErr.code,
        errorMessage: sErr.message,
      });
    }
  }

  public async connectWithPersonalAccessToken(
    origin: string,
    rawToken: string
  ): Promise<AuthenticationState> {
    try {
      await this.patProvider.setToken(origin, rawToken);
      const user = await this.patProvider.verify(origin);
      const normalizedOrigin = validateCvatOrigin(origin, this.authorizedOrigins).normalizedOrigin;
      return this.updateState({
        status: 'authenticated',
        method: 'pat',
        origin: normalizedOrigin,
        user,
        lastCheckedAt: Date.now(),
        errorCode: null,
        errorMessage: null,
      });
    } catch (err) {
      const authErr =
        err instanceof AuthenticationError
          ? err
          : new AuthenticationError('NETWORK_ERROR', 'Failed to authenticate with PAT.');
      await this.patProvider.clear(origin);
      return this.updateState({
        status: 'error',
        method: 'none',
        origin: validateCvatOrigin(origin, this.authorizedOrigins).normalizedOrigin,
        user: null,
        lastCheckedAt: Date.now(),
        errorCode: authErr.code,
        errorMessage: authErr.message,
      });
    }
  }

  public async disconnect(origin?: string): Promise<AuthenticationState> {
    const targetOrigin = origin ?? this.state.origin;
    if (targetOrigin) {
      await this.patProvider.clear(targetOrigin);
      await this.sessionProvider.clear(targetOrigin);
    }
    return this.updateState({
      status: 'unauthenticated',
      method: 'none',
      origin: targetOrigin ?? null,
      user: null,
      lastCheckedAt: Date.now(),
      errorCode: null,
      errorMessage: null,
    });
  }

  private updateState(next: AuthenticationState): AuthenticationState {
    this.state = Object.freeze({ ...next });
    this.onStateChange?.(this.state);
    return this.state;
  }
}
