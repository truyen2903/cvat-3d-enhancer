import { describe, expect, it, vi } from 'vitest';
import { VersionDetector } from '../../src/integration/cvat/compatibility';
import { RuntimeDetector } from '../../src/integration/cvat/detector';

describe('CVAT Compatibility & Route Detection', () => {
  it('parses CVAT v2.81.0 server version and flags compatibility accurately', async () => {
    const detector = new VersionDetector(['https://app.cvat.ai']);
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ name: 'Computer Vision Annotation Tool', version: '2.81.0' }), {
        status: 200,
      })
    );

    const info = await detector.detectServerVersion('https://app.cvat.ai', mockFetch);
    expect(info.serverVersion).toBe('2.81.0');
    expect(info.major).toBe(2);
    expect(info.minor).toBe(81);
    expect(info.patch).toBe(0);
    expect(info.isCompatibleWithTarget).toBe(true);
  });

  it('extracts taskId and jobId from CVAT annotation routes', () => {
    document.body.innerHTML = `<div class="cvat-canvas3d-perspective"></div>`;
    const runtimeDetector = new RuntimeDetector(['https://app.cvat.ai']);
    const ctx = runtimeDetector.detectRouteContext(
      { origin: 'https://app.cvat.ai', pathname: '/tasks/104/jobs/209' },
      document
    );

    expect(ctx.isCvatPage).toBe(true);
    expect(ctx.is3DWorkspace).toBe(true);
    expect(ctx.taskId).toBe('104');
    expect(ctx.jobId).toBe('209');
  });
});
