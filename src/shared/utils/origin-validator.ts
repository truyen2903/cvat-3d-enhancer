import { DEFAULT_AUTHORIZED_ORIGINS } from '../constants';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isPrivateOrLocalHostname(hostname: string): boolean {
  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return true;
  }
  // RFC1918 private IPv4 ranges for local self-hosted CVAT deployments
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  return false;
}

export interface OriginValidationResult {
  readonly valid: boolean;
  readonly normalizedOrigin: string | null;
  readonly isLocalDev: boolean;
  readonly reason?: string;
}

/**
 * Validates that a URL or origin is safe for CVAT API communication.
 * Enforces HTTPS for all remote origins (allowing HTTP for localhost/private LAN self-hosted CVAT)
 * and requires membership in the authorized origin allowlist (supporting *.cvat.ai and any localhost port).
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

  const isLocalDev = isPrivateOrLocalHostname(parsed.hostname);

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalDev)) {
    return {
      valid: false,
      normalizedOrigin: null,
      isLocalDev,
      reason: 'Credentials may only be transmitted over HTTPS (or local/LAN HTTP for development).',
    };
  }

  const normalizedOrigin = parsed.origin;
  const allowlist = new Set(authorizedOrigins);

  const isDefaultCvatCloud =
    authorizedOrigins === DEFAULT_AUTHORIZED_ORIGINS &&
    parsed.protocol === 'https:' &&
    (parsed.hostname === 'cvat.ai' || parsed.hostname.endsWith('.cvat.ai'));

  const isDefaultLocalhost =
    authorizedOrigins === DEFAULT_AUTHORIZED_ORIGINS &&
    LOCALHOST_HOSTNAMES.has(parsed.hostname);

  if (!allowlist.has(normalizedOrigin) && !isDefaultCvatCloud && !isDefaultLocalhost) {
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
