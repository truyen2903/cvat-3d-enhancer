import { z } from 'zod';
import { DEFAULT_AUTHORIZED_ORIGINS } from '../../../shared/constants';
import { buildSafeCvatApiUrl } from '../../../shared/utils';

const ServerAboutSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().min(1).max(64),
  })
  .passthrough();

export interface CvatVersionInfo {
  readonly serverVersion: string | null;
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly isCompatibleWithTarget: boolean;
}

export class VersionDetector {
  private readonly authorizedOrigins: readonly string[];

  public constructor(authorizedOrigins: readonly string[] = DEFAULT_AUTHORIZED_ORIGINS) {
    this.authorizedOrigins = authorizedOrigins;
  }

  public parseVersionString(versionStr: string | null): CvatVersionInfo {
    if (!versionStr) {
      return {
        serverVersion: null,
        major: null,
        minor: null,
        patch: null,
        isCompatibleWithTarget: false,
      };
    }

    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionStr.trim());
    if (!match) {
      return {
        serverVersion: versionStr,
        major: null,
        minor: null,
        patch: null,
        isCompatibleWithTarget: false,
      };
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = match[3] !== undefined ? Number(match[3]) : 0;

    return {
      serverVersion: versionStr,
      major,
      minor,
      patch,
      isCompatibleWithTarget: major === 2 && minor >= 10,
    };
  }

  public async detectServerVersion(
    origin: string,
    fetchImpl: typeof fetch = globalThis.fetch
  ): Promise<CvatVersionInfo> {
    try {
      const url = buildSafeCvatApiUrl(origin, '/api/server/about', this.authorizedOrigins);
      const response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        return this.parseVersionString(null);
      }
      const raw: unknown = await response.json();
      const parsed = ServerAboutSchema.safeParse(raw);
      if (!parsed.success) {
        return this.parseVersionString(null);
      }
      return this.parseVersionString(parsed.data.version);
    } catch {
      return this.parseVersionString(null);
    }
  }
}
