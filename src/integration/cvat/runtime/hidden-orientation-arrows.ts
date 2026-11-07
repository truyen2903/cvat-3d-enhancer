/** Defer render traversal for CVAT's decorative orientation arrows while hidden. */
export function deferHiddenOrientationArrowUpdates(arrow: unknown, hooked: WeakSet<object>): void {
  if (!arrow || typeof arrow !== 'object' || hooked.has(arrow)) return;
  const node = arrow as {
    type?: string;
    visible?: boolean;
    updateMatrixWorld?: (force?: boolean) => void;
  };
  if (node.type !== 'ArrowHelper' || typeof node.updateMatrixWorld !== 'function') return;
  // Preserve custom subclasses with matrix-update side effects.
  let proto = Object.getPrototypeOf(node);
  while (
    proto &&
    !(Object.hasOwn(proto, 'updateMatrix') && Object.hasOwn(proto, 'updateMatrixWorld'))
  ) {
    proto = Object.getPrototypeOf(proto);
  }
  if (node.updateMatrixWorld !== proto?.updateMatrixWorld) return;
  const nativeUpdate = node.updateMatrixWorld;
  let skipped = false;
  node.updateMatrixWorld = function (force?: boolean): void {
    if (this.visible === false) {
      skipped = true;
      return;
    }
    // Ancestors may have moved while the arrow was hidden. Refresh every child
    // before its next draw, even when the caller did not force an update.
    nativeUpdate.call(this, Boolean(force) || skipped);
    skipped = false;
  };
  hooked.add(arrow);
}
