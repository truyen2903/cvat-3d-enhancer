import { CVAT_DOM_SELECTORS } from '../../../shared/constants';
import { HexColorSchema } from '../../../shared/schemas';

/**
 * Safe DOM helper for inspecting CVAT 3D viewport containers and applying
 * non-destructive CSS custom properties / filters without modifying annotation data
 * or using innerHTML.
 */
export class CvatDomAdapter {
  private readonly doc: Document;

  public constructor(doc: Document = document) {
    this.doc = doc;
  }

  public has3DWorkspaceDom(): {
    readonly hasPerspective: boolean;
    readonly hasPerspectiveCanvas: boolean;
    readonly hasOrthographicViews: boolean;
  } {
    const perspective = this.doc.querySelector(CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER);
    const perspectiveCanvas = this.doc.querySelector(
      `${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER} canvas`
    );
    const orthoViews = this.doc.querySelectorAll(CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW);

    return {
      hasPerspective: Boolean(perspective),
      hasPerspectiveCanvas: Boolean(perspectiveCanvas),
      hasOrthographicViews: orthoViews.length >= 3,
    };
  }

  public applyCanvasBackgroundColor(hexColor: string): boolean {
    const parsed = HexColorSchema.safeParse(hexColor);
    if (!parsed.success) {
      throw new Error(`Invalid canvas background hex color: "${hexColor}"`);
    }

    const containers = this.doc.querySelectorAll<HTMLElement>(
      `${CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER}, ${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER}, ${CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW}`
    );

    if (containers.length === 0) {
      return false;
    }

    containers.forEach((el) => {
      el.style.setProperty('background-color', parsed.data, 'important');
    });
    return true;
  }

  public applyViewportVisualFilter(brightnessPercent: number, contrastPercent: number): boolean {
    const safeBrightness = Math.max(50, Math.min(180, Math.round(brightnessPercent)));
    const safeContrast = Math.max(50, Math.min(180, Math.round(contrastPercent)));

    const canvases = this.doc.querySelectorAll<HTMLCanvasElement>(
      `${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER} canvas, ${CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW} canvas`
    );

    if (canvases.length === 0) {
      return false;
    }

    const filterValue =
      safeBrightness === 100 && safeContrast === 100
        ? 'none'
        : `brightness(${safeBrightness}%) contrast(${safeContrast}%)`;

    canvases.forEach((canvas) => {
      canvas.style.filter = filterValue;
    });
    return true;
  }

  public resetDomEnhancements(): void {
    const containers = this.doc.querySelectorAll<HTMLElement>(
      `${CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER}, ${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER}, ${CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW}`
    );
    containers.forEach((el) => {
      el.style.removeProperty('background-color');
    });

    const canvases = this.doc.querySelectorAll<HTMLCanvasElement>(
      `${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER} canvas, ${CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW} canvas`
    );
    canvases.forEach((canvas) => {
      canvas.style.removeProperty('filter');
    });
  }
}
