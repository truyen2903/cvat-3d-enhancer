/** Route browser Back/Forward mouse buttons through CVAT's own player controls. */
const JOB_PATH = /^\/tasks\/\d+\/jobs\/\d+\/?$/;
const SELECTORS: Readonly<Record<3 | 4, string>> = {
  3: '.cvat-player-previous-button, .cvat-player-previous-button-filtered, .cvat-player-previous-button-empty, .cvat-player-previous-button-chapter',
  4: '.cvat-player-next-button, .cvat-player-next-button-filtered, .cvat-player-next-button-empty, .cvat-player-next-button-chapter',
};

export function installMouseFrameNavigation(
  doc: Document,
  win: Window,
  isEnabled: () => boolean
): () => void {
  const pressed = new Set<number>();
  const releaseTimers = new Map<number, number>();
  const findControl = (button: 3 | 4): HTMLElement | null => {
    const element = doc.querySelector<HTMLElement>(SELECTORS[button]);
    if (
      !element ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.matches(':disabled, .anticon-disabled, [disabled]') ||
      element.closest('[aria-disabled="true"], .ant-btn-disabled, [inert]')
    )
      return null;
    return element;
  };
  const handle = (event: MouseEvent): void => {
    if (event.button !== 3 && event.button !== 4) return;
    const button = event.button;
    const ending =
      event.type === 'pointerup' || event.type === 'mouseup' || event.type === 'auxclick';
    if (pressed.has(button)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'auxclick') {
        pressed.delete(button);
        const timer = releaseTimers.get(button);
        if (timer !== undefined) win.clearTimeout(timer);
        releaseTimers.delete(button);
      } else if (event.type === 'mouseup' && !releaseTimers.has(button)) {
        releaseTimers.set(
          button,
          win.setTimeout(() => {
            pressed.delete(button);
            releaseTimers.delete(button);
          }, 0)
        );
      }
      return;
    }
    if (
      ending ||
      !isEnabled() ||
      !JOB_PATH.test(win.location.pathname) ||
      !doc.querySelector('.cvat-canvas3d-perspective, .cvat-canvas3d-orthographic-view')
    )
      return;
    const target = event.target as Element | null;
    if (
      target?.closest?.(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], .ant-modal, .ant-drawer, [data-enhancer-workspace-settings], #cvat-3d-enhancer-panel'
      )
    )
      return;
    const control = findControl(button);
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pressed.add(button);
    control.click();
  };
  const clear = () => {
    pressed.clear();
    for (const timer of releaseTimers.values()) win.clearTimeout(timer);
    releaseTimers.clear();
  };
  const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'] as const;
  for (const type of types) win.addEventListener(type, handle, true);
  win.addEventListener('blur', clear);
  return () => {
    for (const type of types) win.removeEventListener(type, handle, true);
    win.removeEventListener('blur', clear);
    clear();
  };
}
