import { CVAT_DOM_SELECTORS, DEFAULT_AUTHORIZED_ORIGINS } from '../../../shared/constants';
import type { CvatRouteContext } from '../../../shared/types';
import { validateCvatOrigin } from '../../../shared/utils';

const TASK_JOB_ROUTE_REGEX = /^\/tasks\/(\d+)\/jobs\/(\d+)(?:\/|$)/;
const TASK_ROUTE_REGEX = /^\/tasks\/(\d+)(?:\/|$)/;
const PROJECT_ROUTE_REGEX = /^\/projects\/(\d+)(?:\/|$)/;

/**
 * Inspects URL and DOM structure to determine whether the current page is a CVAT instance
 * and whether the 3D annotation workspace is active.
 * Never trusts DOM attributes as authenticated state.
 */
export class RuntimeDetector {
  private readonly authorizedOrigins: readonly string[];

  public constructor(authorizedOrigins: readonly string[] = DEFAULT_AUTHORIZED_ORIGINS) {
    this.authorizedOrigins = authorizedOrigins;
  }

  public detectRouteContext(
    locationObj: Pick<Location, 'origin' | 'pathname'> = window.location,
    doc: Document = document
  ): CvatRouteContext {
    const originValidation = validateCvatOrigin(locationObj.origin, this.authorizedOrigins);
    const pathname = locationObj.pathname;

    let projectId: string | null = null;
    let taskId: string | null = null;
    let jobId: string | null = null;

    const jobMatch = TASK_JOB_ROUTE_REGEX.exec(pathname);
    if (jobMatch) {
      taskId = jobMatch[1] ?? null;
      jobId = jobMatch[2] ?? null;
    } else {
      const taskMatch = TASK_ROUTE_REGEX.exec(pathname);
      if (taskMatch) {
        taskId = taskMatch[1] ?? null;
      }
      const projMatch = PROJECT_ROUTE_REGEX.exec(pathname);
      if (projMatch) {
        projectId = projMatch[1] ?? null;
      }
    }

    const hasPerspectiveDom = Boolean(doc.querySelector(CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER));
    const hasCvatHeader = Boolean(doc.querySelector(CVAT_DOM_SELECTORS.ANNOTATION_HEADER));
    const isCvatPage =
      originValidation.valid &&
      (hasPerspectiveDom ||
        hasCvatHeader ||
        jobId !== null ||
        taskId !== null ||
        projectId !== null ||
        Boolean(doc.querySelector(CVAT_DOM_SELECTORS.ROOT_CONTAINER)));

    return {
      origin: locationObj.origin,
      pathname,
      isCvatPage,
      is3DWorkspace: originValidation.valid && hasPerspectiveDom,
      projectId,
      taskId,
      jobId,
    };
  }
}
