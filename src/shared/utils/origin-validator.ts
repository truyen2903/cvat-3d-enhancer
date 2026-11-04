import { DEFAULT_AUTHORIZED_ORIGINS } from '../constants';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface OriginValidationResult {
  readonly valid: boolean;
  readonly normalizedOrigin: string | null;
  readonly isLocalDev: boolean;
  readonly reason?: string;
}

/**
 * Validates that a URL or origin is safe for CVAT API communication.
 * Enforces HTTPS for all non-local origins and requires membership in the authorized origin allowlist.
 */
export function validateCvatOrigin(
  rawUrlOrOrigin: string,
  authorizedOrigins: readonly string[] = DEFAULT_AUTHORIZED_ORIGINS
): OriginValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrlOrOrigin);
  } catch {
    return {
      valid: false,
      normalizedOrigin: null,
      isLocalDev: false,
      reason: 'Malformed URL or origin.',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalizedOrigin: null,
      isLocalDev: false,
      reason: 'Embedded credentials in URLs are forbidden.',
    };
  }

  const isLocalDev = LOCALHOST_HOSTNAMES.has(parsed.hostname);

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalDev)) {
    return {
      valid: false,
      normalizedOrigin: null,
      isLocalDev,
      reason: 'Credentials may only be transmitted over HTTPS (or localhost HTTP for development).',
    };
  }

  const normalizedOrigin = parsed.origin;
  const allowlist = new Set(authorizedOrigins);

  if (!allowlist.has(normalizedOrigin)) {
    return {
      valid: false,
      normalizedOrigin,
      isLocalDev,
      reason: `Origin "${normalizedOrigin}" is not in the authorized CVAT origins allowlist.`,
    };
  }

  return {
    valid: true,
    normalizedOrigin,
    isLocalDev,
  };
}

/**
 * Builds a strict same-origin CVAT API endpoint and rejects path traversal or cross-origin redirects.
 */
export function buildSafeCvatApiUrl(
  origin: string,
  apiPath: string,
  authorizedOrigins: readonly string[] = DEFAULT_AUTHORIZED_ORIGINS
): string {
  const originCheck = validateCvatOrigin(origin, authorizedOrigins);
  if (!originCheck.valid || !originCheck.normalizedOrigin) {
    throw new Error(originCheck.reason ?? 'Unauthorized CVAT origin');
  }

  if (!apiPath.startsWith('/api/') || apiPath.includes('..') || apiPath.includes('//')) {
    throw new Error(`Invalid CVAT API path: "${apiPath}"`);
  }

  const resolved = new URL(apiPath, originCheck.normalizedOrigin);
  if (resolved.origin !== originCheck.normalizedOrigin) {
    throw new Error('Cross-origin URL resolution attempt blocked.');
  }

  return resolved.toString();
}
