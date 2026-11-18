const SKIPPED_MATRIX_SYM = Symbol('meowSkippedMatrix');

interface DeferrableThreeNode {
  type?: string;
  visible?: boolean;
  children?: readonly unknown[];
  updateMatrixWorld?: MatrixWorldUpdateFn;
  [SKIPPED_MATRIX_SYM]?: boolean;
}

type MatrixWorldUpdateFn = (this: DeferrableThreeNode, force?: boolean) => void;

interface ProtoMatrixHookPlan {
  readonly nativeUpdate: MatrixWorldUpdateFn;
  readonly wrapper: MatrixWorldUpdateFn;
}

const sharedMatrixWorldWrappers = new WeakMap<MatrixWorldUpdateFn, MatrixWorldUpdateFn>();
const protoHookPlanCache = new WeakMap<object, ProtoMatrixHookPlan | null>();

function getOrCreateSharedMatrixWrapper(nativeUpdate: MatrixWorldUpdateFn): MatrixWorldUpdateFn {
  let wrapper = sharedMatrixWorldWrappers.get(nativeUpdate);
  if (!wrapper) {
    wrapper = function (this: DeferrableThreeNode, force?: boolean): void {
      if (this.visible === false) {
        if (this[SKIPPED_MATRIX_SYM] !== true) {
          this[SKIPPED_MATRIX_SYM] = true;
        }
        return;
      }
      // Ancestors may have moved while the object was hidden. Refresh every child
      // before its next draw, even when the caller did not force an update.
      if (this[SKIPPED_MATRIX_SYM] === true) {
        this[SKIPPED_MATRIX_SYM] = false;
        nativeUpdate.call(this, true);
        return;
      }
      nativeUpdate.call(this, Boolean(force));
    };
    sharedMatrixWorldWrappers.set(nativeUpdate, wrapper);
  }
  return wrapper;
}

function getOrResolveProtoHookPlan(node: DeferrableThreeNode): ProtoMatrixHookPlan | null {
  const directProto = Object.getPrototypeOf(node) as object | null;
  if (!directProto) {
    return null;
  }
  const cached = protoHookPlanCache.get(directProto);
  if (cached !== undefined) {
    return cached;
  }

  // Preserve custom subclasses with matrix-update side effects.
  let proto: object | null = directProto;
  while (
    proto &&
    !(Object.hasOwn(proto, 'updateMatrix') && Object.hasOwn(proto, 'updateMatrixWorld'))
  ) {
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  const protoUpdate = (proto as { updateMatrixWorld?: unknown } | null)?.updateMatrixWorld;
  if (typeof protoUpdate !== 'function') {
    protoHookPlanCache.set(directProto, null);
    return null;
  }

  const nativeUpdate = protoUpdate as MatrixWorldUpdateFn;
  const plan: ProtoMatrixHookPlan = {
    nativeUpdate,
    wrapper: getOrCreateSharedMatrixWrapper(nativeUpdate),
  };
  protoHookPlanCache.set(directProto, plan);
  return plan;
}

/** Defer render traversal for CVAT's decorative orientation arrows while hidden. */
export function deferHiddenOrientationArrowUpdates(
  arrow: unknown,
  _hooked?: WeakSet<object>
): void {
  if (!arrow || typeof arrow !== 'object') return;
  const node = arrow as DeferrableThreeNode;
  if (node.type !== 'ArrowHelper') return;
  const plan = getOrResolveProtoHookPlan(node);
  if (!plan || node.updateMatrixWorld !== plan.nativeUpdate) return;
  node.updateMatrixWorld = plan.wrapper;
}

/**
 * Defer `updateMatrixWorld` traversal for a cuboid root mesh (and its entire child subtree:
 * wireframes, edge helpers, resize dots, orientation arrows) while filtered/hidden (`visible === false`),
 * automatically forcing a full subtree matrix refresh on the next frame after becoming visible again.
 */
export function deferHiddenCuboidMeshUpdates(mesh: unknown, _hooked?: WeakSet<object>): void {
  if (!mesh || typeof mesh !== 'object') return;
  const node = mesh as DeferrableThreeNode;
  const isCuboidNode =
    node.type === 'Mesh' ||
    ((node.type === undefined || node.type === 'Group' || node.type === 'Object3D') &&
      Array.isArray(node.children));
  if (!isCuboidNode) return;
  const plan = getOrResolveProtoHookPlan(node);
  if (!plan || node.updateMatrixWorld !== plan.nativeUpdate) return;
  node.updateMatrixWorld = plan.wrapper;
}
