/**
 * Real-time 3D Canvas QA Warning Overlay for the currently active object (track ID).
 *
 * Evaluates the active 3D cuboid on the current frame against project annotation specifications
 * (`labels_job_1867.json` & `guide_13.json`):
 * - Resolves the object's Label (`vehicles`, `two-wheels`, `pedestrian`, `Animal`, `Obstacle`)
 *   and checks its current-frame Attributes (`type`, `ride_state`, `pose`, `age`, `species`) FIRST.
 * - Checks all 10 QA error codes:
 *   - `K`: Kích thước ngoài ngưỡng (L, W, H vs attribute subtype threshold table)
 *   - `S`: Không đồng bộ kích thước (L, W, H mismatch across same-attribute keyframes of the track)
 *   - `Z`: Độ cao ngoài ngưỡng / box bị bay, bị âm đường
 *   - `H`: Sai hướng (heading/yaw mismatch with trajectory or sudden 180° flip)
 *   - `J`: Nhảy ID (position jump anomaly or reuse of track_id after >= 6 outside frames)
 *   - `T`: Sai kích thước (box excessively loose compared to internal LiDAR point cluster)
 *   - `P`: Lỗi sai vị trí (box cutting into adjacent mid-body LiDAR points or shifted off-cluster)
 *   - `D`: Khoảng cách quá xa (distance from sensor > threshold)
 *   - `F`: Thừa box (duplicate overlapping box on same frame or sparse < 6 LiDAR points)
 *   - `M`: Missing (frames where track is marked outside/missing within its active span)
 * - Renders a non-intrusive HUD overlay (`pointer-events: none`) inside `.cvat-canvas3d-perspective`.
 */

import {
  type CvatDrawnObjectEntry,
  type CvatInternalViewLike,
  type CvatObjectStateLike,
  type CvatSerializedTrack,
  type CvatSerializedTrackShape,
  findPointsObjectsInScene,
  haveIdenticalAttributes,
} from './pre-render-enhancer';

export type QaWarningCode = 'S' | 'K' | 'Z' | 'H' | 'J' | 'T' | 'D' | 'F' | 'M' | 'P';

export type QaWarningSeverity = 'error' | 'warning';

export interface QaWarningItem {
  readonly code: QaWarningCode;
  readonly severity: QaWarningSeverity;
  readonly title: string;
  readonly detail: string;
}

export interface DimensionThresholdRule {
  readonly category: 'vehicles' | 'two-wheels' | 'pedestrian' | 'animal' | 'obstacle' | 'unknown';
  readonly subtypeLabel: string;
  readonly minL?: number;
  readonly maxL?: number;
  readonly minW?: number;
  readonly maxW?: number;
  readonly minH?: number;
  readonly maxH?: number;
}

export interface ActiveObjectQaReport {
  readonly clientID: number;
  readonly frame: number;
  readonly labelName: string;
  readonly subtypeLabel: string;
  readonly dimensions: { readonly L: number; readonly W: number; readonly H: number };
  readonly distanceMeters: number;
  readonly bottomZ: number;
  readonly lidarPointCount: number | null;
  readonly thresholdRule: DimensionThresholdRule;
  readonly warnings: readonly QaWarningItem[];
}

interface LabelAttributeSpecLike {
  readonly id?: number;
  readonly name?: string;
  readonly defaultValue?: string;
  readonly default_value?: string;
}

interface CvatLabelLike {
  readonly id?: number;
  readonly name?: string;
  readonly attributes?: readonly LabelAttributeSpecLike[];
}

/**
 * Fallback attribute spec ID map from `labels_job_1867.json` so attribute resolution works
 * even if `state.label.attributes` is not attached to a serialized/mock state object.
 */
const KNOWN_ATTRIBUTE_SPEC_ID_TO_NAME: Readonly<Record<number, string>> = Object.freeze({
  6257: 'type', // vehicles.type: car, truck, bus, van, contruction, pickup, Trailer, Tricycle, Stroller, Wheelchair, other
  6258: 'age', // pedestrian.age: child, adult
  6259: 'pose', // pedestrian.pose: standing, sitting, bending
  6260: 'ride_state', // two-wheels.ride_state: "true" / "false"
  6261: 'type', // two-wheels.type: motorcycle, bicycle
  6262: 'species', // Animal.species: cat, dog, cow, buffalow, other
  6263: 'type', // Obstacle.type: traffic barrier, traffic cone, brick, ...
});

const KNOWN_LABEL_ID_TO_NAME: Readonly<Record<number, string>> = Object.freeze({
  36190: 'vehicles',
  36191: 'pedestrian',
  36192: 'two-wheels',
  36193: 'Animal',
  36194: 'Obstacle',
});

/**
 * Fallback helper that inspects CVAT's Objects Sidebar DOM (`#cvat-objects-sidebar-state-item-${clientID}`)
 * to read the object's selected Label name and any visible attribute controls in real time.
 */
export function extractSidebarDomLabelAndAttributes(
  doc: Document,
  clientID: number
): {
  readonly labelName?: string;
  readonly domAttributes: Record<string, string>;
  readonly isOutsideInDom: boolean;
  readonly domPos?: { readonly x: number; readonly y: number; readonly z: number } | null;
} {
  let domPos: { readonly x: number; readonly y: number; readonly z: number } | null = null;
  const hudCandidates = doc.querySelectorAll<HTMLElement>(
    '.cvat-canvas3d-perspective [class*="hud"], .cvat-canvas3d-perspective [class*="info"], .cvat-canvas3d-perspective div'
  );
  for (const el of hudCandidates) {
    if (el.id === 'cvat-3d-enhancer-active-qa-overlay' || el.children.length > 8) {
      continue;
    }
    const txt = el.textContent ?? '';
    if (!/pos/i.test(txt)) continue;
    const m = /pos(?:ition)?\s*[:=]?\s*\(?\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)(?:\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?))?\s*\)?/i.exec(
      txt
    );
    if (m) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      const z = m[3] !== undefined && Number.isFinite(Number(m[3])) ? Number(m[3]) : 0;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        domPos = { x, y, z };
        break;
      }
    }
  }

  const domAttributes: Record<string, string> = {};
  const itemEl = doc.getElementById(`cvat-objects-sidebar-state-item-${clientID}`);
  if (!itemEl) {
    return { domAttributes, isOutsideInDom: false, domPos };
  }

  const isOutsideInDom = Boolean(
    itemEl.querySelector(
      '.cvat-object-item-button-outside-enabled, [class*="button-outside-enabled"]'
    )
  );

  const labelSelectText = itemEl
    .querySelector('.cvat-objects-sidebar-state-item-label-selector .ant-select-selection-item')
    ?.textContent?.trim();
  const fallbackSelectText = itemEl
    .querySelector('.ant-select-selection-item')
    ?.textContent?.trim();
  const labelName = labelSelectText || fallbackSelectText || undefined;

  // Inspect attribute rows inside the collapsed/expanded details section if present
  const attrRows = itemEl.querySelectorAll('.cvat-object-item-attribute-wrapper');
  for (const row of attrRows) {
    const attrNameEl = row.querySelector('.ant-typography, label');
    const rawAttrName = attrNameEl?.textContent?.trim().replace(/:$/, '').toLowerCase();
    if (!rawAttrName) continue;

    const checkedRadio = row.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    if (checkedRadio) {
      const radioLabel = checkedRadio.closest('label')?.textContent?.trim();
      if (radioLabel) {
        domAttributes[rawAttrName] = radioLabel;
      } else if (checkedRadio.value) {
        domAttributes[rawAttrName] = checkedRadio.value;
      }
      continue;
    }

    const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) {
      domAttributes[rawAttrName] = checkbox.checked ? 'true' : 'false';
      continue;
    }

    const selectItem = row.querySelector('.ant-select-selection-item')?.textContent?.trim();
    if (selectItem) {
      domAttributes[rawAttrName] = selectItem;
    }
  }

  return { labelName, domAttributes, isOutsideInDom, domPos };
}

/**
 * Extracts normalized attribute map `{ [lowercaseAttributeName]: trimmedValue }` for an object state.
 */
export function extractNamedAttributes(
  state?: (CvatObjectStateLike & { label?: CvatLabelLike; label_id?: number }) | null,
  domAttributes?: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};

  const specIdToName = new Map<string, string>();
  for (const [id, name] of Object.entries(KNOWN_ATTRIBUTE_SPEC_ID_TO_NAME)) {
    specIdToName.set(String(id), name.toLowerCase());
  }

  const labelAttrs = state?.label?.attributes;
  if (Array.isArray(labelAttrs)) {
    for (const spec of labelAttrs) {
      if (spec && spec.id !== undefined && typeof spec.name === 'string') {
        const cleanName = spec.name.trim().toLowerCase();
        specIdToName.set(String(spec.id), cleanName);
        const defVal = spec.defaultValue ?? spec.default_value;
        if (typeof defVal === 'string' && !(cleanName in result)) {
          result[cleanName] = defVal.trim();
        }
      }
    }
  }

  const rawAttrs = state?.attributes;
  if (rawAttrs && typeof rawAttrs === 'object') {
    for (const [key, val] of Object.entries(rawAttrs)) {
      const strVal = String(val ?? '').trim();
      const mappedName = specIdToName.get(String(key)) ?? key.trim().toLowerCase();
      result[mappedName] = strVal;
    }
  }

  if (domAttributes && typeof domAttributes === 'object') {
    for (const [key, val] of Object.entries(domAttributes)) {
      const strVal = String(val ?? '').trim();
      if (strVal !== '') {
        const mappedName = specIdToName.get(String(key)) ?? key.trim().toLowerCase();
        result[mappedName] = strVal;
      }
    }
  }

  return result;
}

/**
 * Resolves the object's category (`vehicles`, `two-wheels`, `pedestrian`, etc.),
 * its active attribute subtype (`car, van`, `other`, `rider`, `without rider`, `standing`, `bending`, `sitting`),
 * and the corresponding `[L, W, H]` min/max threshold rule from the specification table.
 */
export function resolveDimensionThresholdRule(
  state?: (CvatObjectStateLike & { label?: CvatLabelLike; label_id?: number }) | null,
  fallbackLabelName?: string,
  domAttributes?: Record<string, string>
): {
  readonly labelName: string;
  readonly namedAttributes: Record<string, string>;
  readonly rule: DimensionThresholdRule;
} {
  const labelId = state?.label?.id ?? state?.label_id;
  const rawLabelName =
    state?.label?.name ??
    (typeof labelId === 'number' ? KNOWN_LABEL_ID_TO_NAME[labelId] : undefined) ??
    fallbackLabelName ??
    'unknown';
  const cleanLabel = rawLabelName.trim().toLowerCase();
  const namedAttributes = extractNamedAttributes(state, domAttributes);

  // 1. Vehicles (`vehicles` / `vehicle`)
  if (cleanLabel === 'vehicles' || cleanLabel === 'vehicle') {
    const rawType = (namedAttributes.type ?? namedAttributes.subtype ?? 'car').toLowerCase();
    const isCarOrVan = rawType === 'car' || rawType === 'van';
    return {
      labelName: rawLabelName,
      namedAttributes,
      rule: isCarOrVan
        ? {
            category: 'vehicles',
            subtypeLabel: rawType,
            minL: 3.2,
            maxL: 5.5,
            minW: 1.6,
            maxW: 2.2,
            minH: 1.5,
            maxH: 1.9,
          }
        : {
            category: 'vehicles',
            subtypeLabel: rawType || 'other',
            minL: 3.2,
            minW: 1.6,
            minH: 1.5,
          },
    };
  }

  // 2. Two-wheels (`two-wheels` / `two-wheel` / `twowheels`)
  if (
    cleanLabel === 'two-wheels' ||
    cleanLabel === 'two-wheel' ||
    cleanLabel === 'twowheels' ||
    cleanLabel === 'two_wheels'
  ) {
    const rawRide = (
      namedAttributes.ride_state ??
      namedAttributes.rider_state ??
      namedAttributes.subtype ??
      'false'
    ).toLowerCase();
    const hasRider =
      rawRide === 'true' ||
      rawRide === '1' ||
      rawRide === 'rider' ||
      rawRide === 'with_rider' ||
      rawRide === 'with rider';
    const vehicleType = namedAttributes.type ? ` • ${namedAttributes.type}` : '';
    return {
      labelName: rawLabelName,
      namedAttributes,
      rule: hasRider
        ? {
            category: 'two-wheels',
            subtypeLabel: `rider${vehicleType}`,
            minL: 1.5,
            maxL: 2.0,
            minW: 0.6,
            maxW: 0.9,
            minH: 1.5,
            maxH: 1.8,
          }
        : {
            category: 'two-wheels',
            subtypeLabel: `without rider${vehicleType}`,
            minL: 1.5,
            maxL: 2.0,
            minW: 0.6,
            maxW: 0.9,
            minH: 1.2,
            maxH: 1.8,
          },
    };
  }

  // 3. Pedestrian (`pedestrian`)
  if (cleanLabel === 'pedestrian' || cleanLabel === 'pedestrians') {
    const rawPose = (namedAttributes.pose ?? namedAttributes.subtype ?? 'standing').toLowerCase();
    const ageSuffix = namedAttributes.age ? ` • ${namedAttributes.age}` : '';
    if (rawPose === 'bending' || rawPose === 'blending') {
      return {
        labelName: rawLabelName,
        namedAttributes,
        rule: {
          category: 'pedestrian',
          subtypeLabel: `bending${ageSuffix}`,
          minL: 0.65,
          maxL: 1.0,
          minW: 0.65,
          maxW: 1.0,
          minH: 1.2,
          maxH: 1.9,
        },
      };
    }
    if (rawPose === 'sitting') {
      return {
        labelName: rawLabelName,
        namedAttributes,
        rule: {
          category: 'pedestrian',
          subtypeLabel: `sitting${ageSuffix}`,
          minL: 0.65,
          maxL: 1.0,
          minW: 0.65,
          maxW: 1.0,
          maxH: 1.2,
        },
      };
    }
    return {
      labelName: rawLabelName,
      namedAttributes,
      rule: {
        category: 'pedestrian',
        subtypeLabel: `standing${ageSuffix}`,
        minL: 0.65,
        maxL: 1.0,
        minW: 0.65,
        maxW: 1.0,
        minH: 1.5,
        maxH: 1.9,
      },
    };
  }

  // 4. Animal / Obstacle
  if (cleanLabel === 'animal') {
    return {
      labelName: rawLabelName,
      namedAttributes,
      rule: {
        category: 'animal',
        subtypeLabel: namedAttributes.species ?? 'animal',
      },
    };
  }
  if (cleanLabel === 'obstacle') {
    return {
      labelName: rawLabelName,
      namedAttributes,
      rule: {
        category: 'obstacle',
        subtypeLabel: namedAttributes.type ?? 'obstacle',
      },
    };
  }

  return {
    labelName: rawLabelName,
    namedAttributes,
    rule: {
      category: 'unknown',
      subtypeLabel: Object.values(namedAttributes).join(', ') || 'default',
    },
  };
}

/**
 * Checks `[K] Kích thước ngoài ngưỡng` against the resolved (Label + Attribute) threshold rule.
 */
export function checkDimensionThresholdViolation(
  L: number,
  W: number,
  H: number,
  rule: DimensionThresholdRule
): QaWarningItem | null {
  const eps = 1e-3;
  const violations: string[] = [];

  if (rule.minL !== undefined && L < rule.minL - eps) {
    violations.push(`L=${L.toFixed(2)}m < min ${rule.minL}m`);
  } else if (rule.maxL !== undefined && L > rule.maxL + eps) {
    violations.push(`L=${L.toFixed(2)}m > max ${rule.maxL}m`);
  }

  if (rule.minW !== undefined && W < rule.minW - eps) {
    violations.push(`W=${W.toFixed(2)}m < min ${rule.minW}m`);
  } else if (rule.maxW !== undefined && W > rule.maxW + eps) {
    violations.push(`W=${W.toFixed(2)}m > max ${rule.maxW}m`);
  }

  if (rule.minH !== undefined && H < rule.minH - eps) {
    violations.push(`H=${H.toFixed(2)}m < min ${rule.minH}m`);
  } else if (rule.maxH !== undefined && H > rule.maxH + eps) {
    violations.push(`H=${H.toFixed(2)}m > max ${rule.maxH}m`);
  }

  if (violations.length === 0) {
    return null;
  }

  return {
    code: 'K',
    severity: 'error',
    title: 'Kích thước ngoài ngưỡng',
    detail: `(${rule.category} • ${rule.subtypeLabel}): ${violations.join(', ')}`,
  };
}

function normalizeAngleRad(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function radToDeg(rad: number): number {
  return (Math.abs(rad) * 180) / Math.PI;
}

interface ResolvedKeyframeShape {
  readonly frame: number;
  readonly outside: boolean;
  readonly occluded: boolean;
  readonly points: readonly number[];
  readonly attributes: Record<number | string, string>;
}

/**
 * Extracts sorted keyframes with cumulative per-frame attributes from a track.
 */
export function extractTrackKeyframes(
  state: CvatObjectStateLike,
  serializedTrack?: CvatSerializedTrack | null
): ResolvedKeyframeShape[] {
  let track = serializedTrack ?? null;
  if (!track && typeof state.__internal?.export === 'function') {
    try {
      track = state.__internal.export();
    } catch {
      track = null;
    }
  }

  let rawShapes: CvatSerializedTrackShape[] = Array.isArray(track?.shapes)
    ? [...track.shapes].sort((a, b) => Number(a.frame) - Number(b.frame))
    : [];

  if (rawShapes.length === 0) {
    const fallbackKeyframes = (state as { keyframes?: Record<string, CvatSerializedTrackShape> })
      .keyframes;
    if (fallbackKeyframes && typeof fallbackKeyframes === 'object') {
      rawShapes = Object.entries(fallbackKeyframes)
        .map(([frameKey, val]) => ({
          ...val,
          frame: Number(val?.frame ?? frameKey),
        }))
        .sort((a, b) => Number(a.frame) - Number(b.frame));
    }
  }

  if (rawShapes.length === 0) {
    return [];
  }

  const rollingAttrs: Record<number | string, string> = {};
  const labelAttrs = (state as { label?: CvatLabelLike }).label?.attributes;
  if (Array.isArray(labelAttrs)) {
    for (const spec of labelAttrs) {
      if (spec && spec.id !== undefined) {
        const defVal = spec.defaultValue ?? spec.default_value;
        if (defVal !== undefined) {
          rollingAttrs[spec.id] = String(defVal);
        }
      }
    }
  }
  if (Array.isArray(track?.attributes)) {
    for (const attr of track.attributes) {
      rollingAttrs[attr.spec_id] = String(attr.value ?? '');
    }
  }
  if (state.attributes) {
    for (const [k, v] of Object.entries(state.attributes)) {
      if (!(k in rollingAttrs)) {
        rollingAttrs[k] = String(v ?? '');
      }
    }
  }

  const result: ResolvedKeyframeShape[] = [];
  for (const sh of rawShapes) {
    const f = Number(sh.frame);
    if (!Number.isInteger(f)) continue;
    if (Array.isArray(sh.attributes)) {
      for (const attr of sh.attributes) {
        rollingAttrs[attr.spec_id] = String(attr.value ?? '');
      }
    }
    result.push({
      frame: f,
      outside: Boolean(sh.outside),
      occluded: Boolean(sh.occluded),
      points: Array.isArray(sh.points) ? sh.points : [],
      attributes: { ...rollingAttrs },
    });
  }

  return result;
}

/**
 * Checks track-level QA rules:
 * - `S`: Không đồng bộ kích thước (across keyframes with identical attributes)
 * - `H`: Sai hướng (heading vs movement vector or sudden yaw flip)
 * - `J`: Nhảy ID (sudden position jump or reuse of track_id after >= 6 outside frames)
 * - `M`: Missing (short outside gaps within track lifetime)
 */
export function evaluateTrackHistoryWarnings(
  currentFrame: number,
  currentPoints: readonly number[],
  currentAttributes: Record<number | string, string>,
  keyframes: readonly ResolvedKeyframeShape[],
  category: DimensionThresholdRule['category']
): QaWarningItem[] {
  const warnings: QaWarningItem[] = [];
  if (keyframes.length === 0 || currentPoints.length < 9) {
    return warnings;
  }

  const curX = Number(currentPoints[0]);
  const curY = Number(currentPoints[1]);
  const curZ = Number(currentPoints[2]);
  const curYaw = Number(currentPoints[5]);
  const curL = Number(currentPoints[6]);
  const curW = Number(currentPoints[7]);
  const curH = Number(currentPoints[8]);

  // 1. [S] Không đồng bộ kích thước
  // - Standard categories: compare L, W, H across active keyframes with 100% matching attributes.
  // - `two-wheels`: when `ride_state` is present/active, `W` is allowed to change size across frames,
  //   while `H` and `L` must ALWAYS fit across frames (L across all active frames, H across matching ride_state frames).
  const unsyncedDims = new Set<'L' | 'W' | 'H'>();
  const unsyncedFrames: number[] = [];
  const dimTol = 0.015;
  const isTwoWheels = category === 'two-wheels';

  for (const kf of keyframes) {
    if (kf.outside || kf.frame === currentFrame || kf.points.length < 9) {
      continue;
    }
    const sameAttrs = haveIdenticalAttributes(currentAttributes, kf.attributes);
    if (!sameAttrs && !isTwoWheels) {
      continue;
    }
    const dL = Math.abs(Number(kf.points[6]) - curL);
    const dW = Math.abs(Number(kf.points[7]) - curW);
    const dH = Math.abs(Number(kf.points[8]) - curH);

    if (isTwoWheels) {
      // For two-wheels: W is allowed to vary across frames; both L and H must ALWAYS fit across frames
      if (dL > dimTol || dH > dimTol) {
        if (dL > dimTol) unsyncedDims.add('L');
        if (dH > dimTol) unsyncedDims.add('H');
        unsyncedFrames.push(kf.frame);
      }
    } else if (dL > dimTol || dW > dimTol || dH > dimTol) {
      if (dL > dimTol) unsyncedDims.add('L');
      if (dW > dimTol) unsyncedDims.add('W');
      if (dH > dimTol) unsyncedDims.add('H');
      unsyncedFrames.push(kf.frame);
    }
  }

  if (unsyncedFrames.length > 0) {
    const previewFrames = unsyncedFrames.slice(0, 5).join(', ');
    const more = unsyncedFrames.length > 5 ? ` (+${unsyncedFrames.length - 5} frame)` : '';
    warnings.push({
      code: 'S',
      severity: 'error',
      title: 'Không đồng bộ kích thước',
      detail: `Lệch ${Array.from(unsyncedDims).join('/')} tại frame ${previewFrames}${more} (cùng attribute)`,
    });
  }

  // 2. [M] Missing & [J] Long occlusion >= 6 frames reuse check
  const activeKeyframes = keyframes.filter((k) => !k.outside && k.points.length >= 9);
  if (activeKeyframes.length >= 2) {
    const firstActiveFrame = activeKeyframes[0]!.frame;
    const lastActiveFrame = activeKeyframes[activeKeyframes.length - 1]!.frame;

    const shortMissingRanges: string[] = [];
    const longOcclusionRanges: string[] = [];

    for (let i = 0; i < keyframes.length; i += 1) {
      const kf = keyframes[i]!;
      if (kf.outside && kf.frame > firstActiveFrame && kf.frame < lastActiveFrame) {
        const nextKf = keyframes[i + 1];
        if (nextKf && !nextKf.outside) {
          const gapLen = nextKf.frame - kf.frame;
          const rangeLabel =
            gapLen === 1 ? `${kf.frame}` : `${kf.frame}..${nextKf.frame - 1} (${gapLen}f)`;
          if (gapLen >= 6) {
            longOcclusionRanges.push(rangeLabel);
          } else if (gapLen >= 1) {
            shortMissingRanges.push(rangeLabel);
          }
        }
      }
    }

    if (longOcclusionRanges.length > 0) {
      warnings.push({
        code: 'J',
        severity: 'error',
        title: 'Nhảy ID (che khuất >= 6 frame)',
        detail: `Ẩn (outside) quá 6 frame tại ${longOcclusionRanges.join(', ')} rồi dùng lại ID cũ`,
      });
    }

    if (shortMissingRanges.length > 0) {
      warnings.push({
        code: 'M',
        severity: 'warning',
        title: 'Missing (thiếu/ẩn box giữa chuỗi)',
        detail: `Outside tại frame: ${shortMissingRanges.join(', ')}`,
      });
    }
  }

  // Find adjacent active keyframes around currentFrame for [J] position jump & [H] heading checks
  let prevKf: ResolvedKeyframeShape | null = null;
  let nextKf: ResolvedKeyframeShape | null = null;
  for (const kf of activeKeyframes) {
    if (kf.frame < currentFrame) {
      prevKf = kf;
    } else if (kf.frame > currentFrame && !nextKf) {
      nextKf = kf;
    }
  }

  // In VinFast dataset, frames are spaced far apart in time (ego + target relative shift is commonly 6m–25m/frame).
  // Only flag [J] when displacement between adjacent frames is an extreme outlier indicating a swapped/jumped ID.
  const maxSpeedPerFrame =
    category === 'pedestrian' ? 16 : category === 'two-wheels' ? 28 : 36;
  const neighborForJump = prevKf ?? nextKf;
  if (neighborForJump) {
    const dt = Math.max(1, Math.abs(currentFrame - neighborForJump.frame));
    const dx = curX - Number(neighborForJump.points[0]);
    const dy = curY - Number(neighborForJump.points[1]);
    const dz = curZ - Number(neighborForJump.points[2]);
    const distPerFrame = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    if (distPerFrame > maxSpeedPerFrame && dt <= 5) {
      warnings.push({
        code: 'J',
        severity: 'error',
        title: 'Nhảy ID / Nhảy vị trí đột ngột',
        detail: `Dịch chuyển ${distPerFrame.toFixed(1)}m/frame giữa frame ${neighborForJump.frame} và ${currentFrame} (> ${maxSpeedPerFrame}m/frame)`,
      });
    }
  }

  // 3. [H] Sai hướng: chỉ cần tính hướng Yaw lệch quá 90° so với frame trước hoặc frame sau
  const yawJumpNeighbors: { frame: number; diffDeg: number }[] = [];
  if (prevKf) {
    const prevDiffDeg = radToDeg(normalizeAngleRad(curYaw - Number(prevKf.points[5])));
    if (prevDiffDeg > 90) {
      yawJumpNeighbors.push({ frame: prevKf.frame, diffDeg: prevDiffDeg });
    }
  }
  if (nextKf) {
    const nextDiffDeg = radToDeg(normalizeAngleRad(curYaw - Number(nextKf.points[5])));
    if (nextDiffDeg > 90) {
      yawJumpNeighbors.push({ frame: nextKf.frame, diffDeg: nextDiffDeg });
    }
  }
  if (yawJumpNeighbors.length > 0) {
    const detailParts = yawJumpNeighbors.map(
      (n) => `${n.diffDeg.toFixed(0)}° so với frame ${n.frame}`
    );
    warnings.push({
      code: 'H',
      severity: 'error',
      title: 'Sai hướng (lệch góc Yaw > 90°)',
      detail: `Góc hướng lệch ${detailParts.join(', ')}`,
    });
  }

  return warnings;
}

export const MAX_SENSOR_DISTANCE_METERS = 80;

/**
 * Calculates distance `d` (in meters) from sensor origin `(0, 0, 0)` given `pos` `(x, y, z)`.
 * Falls back to 2D `hypot(x, y)` if `z` is omitted or non-finite.
 */
export function computeDistanceFromPos(cx: number, cy: number, cz?: number): number {
  if (typeof cz === 'number' && Number.isFinite(cz)) {
    return Math.hypot(cx, cy, cz);
  }
  return Math.hypot(cx, cy);
}

/**
 * Extracts `(x, y, z)` position from any supported `pos` / `position` / `points` structure,
 * including `{ x, y, z }`, `[x, y, z]`, `cuboid.perspective.position`, or HUD text `Pos: (x, y, z)`.
 */
export function extractPosCoordinates(
  source?: unknown,
  drawnEntry?: CvatDrawnObjectEntry | null,
  fallbackPos?: readonly number[] | { readonly x: number; readonly y: number; readonly z?: number } | null
): { readonly x: number; readonly y: number; readonly z: number } | null {
  const tryVec = (val: unknown): { readonly x: number; readonly y: number; readonly z: number } | null => {
    if (!val) return null;
    if (Array.isArray(val) && val.length >= 2) {
      const x = Number(val[0]);
      const y = Number(val[1]);
      const z = val.length >= 3 && Number.isFinite(Number(val[2])) ? Number(val[2]) : 0;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y, z };
      }
    } else if (typeof val === 'object') {
      const rec = val as Record<string, unknown>;
      const x = Number(rec.x ?? rec[0]);
      const y = Number(rec.y ?? rec[1]);
      const rawZ = Number(rec.z ?? rec[2]);
      const z = Number.isFinite(rawZ) ? rawZ : 0;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y, z };
      }
    }
    return null;
  };

  if (source && typeof source === 'object') {
    const rec = source as Record<string, unknown>;
    const fromPoints = tryVec(rec.points);
    if (fromPoints) return fromPoints;
    const fromPos = tryVec(rec.pos ?? rec.position);
    if (fromPos) return fromPos;
  }

  if (drawnEntry) {
    const fromDataPoints = tryVec(drawnEntry.data?.points);
    if (fromDataPoints) return fromDataPoints;
    const fromDataPos = tryVec(
      (drawnEntry.data as { pos?: unknown; position?: unknown } | undefined)?.pos ??
        (drawnEntry.data as { pos?: unknown; position?: unknown } | undefined)?.position
    );
    if (fromDataPos) return fromDataPos;
    const fromCuboidPos = tryVec(drawnEntry.cuboid?.perspective?.position);
    if (fromCuboidPos) return fromCuboidPos;
  }

  return tryVec(fallbackPos);
}

/**
 * Evaluates spatial & LiDAR point cloud geometry warnings on the current frame:
 * - `Z`: Độ cao ngoài ngưỡng / box bị bay, bị âm đường
 * - `F`: Thừa box (overlapping box on same frame or < 6 LiDAR points inside box)
 * - `T`: Sai kích thước (box too loose around internal LiDAR points)
 * - `P`: Lỗi sai vị trí (box wall cutting into mid-body LiDAR points or off-center)
 * - `D`: Khoảng cách quá xa (> 80m, tự tính `d` từ `pos` nếu chỉ có `pos`)
 */
export function evaluateSpatialAndPointCloudWarnings(params: {
  readonly clientID: number;
  readonly currentPoints: readonly number[];
  readonly pos?: readonly number[] | { readonly x: number; readonly y: number; readonly z?: number } | null;
  readonly occluded?: boolean;
  readonly outside?: boolean;
  readonly drawnObjects?: Record<number | string, CvatDrawnObjectEntry | undefined>;
  readonly positionArray?: Float32Array | number[] | null;
}): {
  readonly lidarPointCount: number | null;
  readonly warnings: QaWarningItem[];
} {
  const { clientID, currentPoints, pos, occluded, outside, drawnObjects, positionArray } = params;
  const warnings: QaWarningItem[] = [];
  if (outside) {
    return { lidarPointCount: null, warnings };
  }

  const resolvedPos =
    currentPoints.length >= 2
      ? {
          x: Number(currentPoints[0]),
          y: Number(currentPoints[1]),
          z: currentPoints.length >= 3 && Number.isFinite(Number(currentPoints[2])) ? Number(currentPoints[2]) : 0,
        }
      : extractPosCoordinates({ pos }, drawnObjects?.[clientID] ?? null, pos);

  if (!resolvedPos || !Number.isFinite(resolvedPos.x) || !Number.isFinite(resolvedPos.y)) {
    return { lidarPointCount: null, warnings };
  }

  const cx = resolvedPos.x;
  const cy = resolvedPos.y;
  const cz = resolvedPos.z;
  const distanceMeters = computeDistanceFromPos(cx, cy, cz);

  // 1. [D] Khoảng cách quá xa (> 80m, tự tính d từ pos)
  if (distanceMeters > MAX_SENSOR_DISTANCE_METERS) {
    warnings.push({
      code: 'D',
      severity: 'warning',
      title: 'Khoảng cách quá xa',
      detail: `Cách cảm biến d=${distanceMeters.toFixed(1)}m (> ${MAX_SENSOR_DISTANCE_METERS}m)`,
    });
  }

  if (currentPoints.length < 9) {
    return { lidarPointCount: null, warnings };
  }

  const rx = Number(currentPoints[3]) || 0;
  const ry = Number(currentPoints[4]) || 0;
  const rz = Number(currentPoints[5]) || 0;
  const L = Number(currentPoints[6]);
  const W = Number(currentPoints[7]);
  const H = Number(currentPoints[8]);

  const hx = L * 0.5;
  const hy = W * 0.5;
  const hz = H * 0.5;
  const bottomZ = cz - hz;

  // 2. [F] Check overlapping / duplicate box on the same frame
  if (drawnObjects) {
    for (const [otherKey, otherEntry] of Object.entries(drawnObjects)) {
      const otherId = Number(otherEntry?.data?.clientID ?? otherEntry?.state?.clientID ?? otherKey);
      if (otherId === clientID || otherEntry?.data?.hidden || otherEntry?.data?.outside) {
        continue;
      }
      const otherPts = otherEntry?.state?.points ?? otherEntry?.data?.points;
      if (!Array.isArray(otherPts) || otherPts.length < 9) {
        continue;
      }
      const ox = Number(otherPts[0]);
      const oy = Number(otherPts[1]);
      const oz = Number(otherPts[2]);
      const oL = Number(otherPts[6]);
      const oW = Number(otherPts[7]);
      const oH = Number(otherPts[8]);

      const centerDistXY = Math.hypot(cx - ox, cy - oy);
      const centerDistZ = Math.abs(cz - oz);
      const minSpanXY = Math.min(Math.hypot(L, W), Math.hypot(oL, oW));
      if (centerDistXY < minSpanXY * 0.45 && centerDistZ < (H + oH) * 0.4) {
        warnings.push({
          code: 'F',
          severity: 'error',
          title: 'Thừa box / Trùng lặp vị trí (đang tắt Outside)',
          detail: `Chồng lấn với Box ID #${otherId} (tâm cách ${centerDistXY.toFixed(2)}m)`,
        });
        break;
      }
    }
  }

  if (!positionArray || positionArray.length < 3) {
    // Fallback absolute Z check when point cloud buffer is not present
    if (bottomZ > 2.2) {
      warnings.push({
        code: 'Z',
        severity: 'error',
        title: 'Độ cao ngoài ngưỡng (Box bị bay)',
        detail: `Đáy box z=${bottomZ.toFixed(2)}m cao bất thường`,
      });
    } else if (bottomZ < -2.8) {
      warnings.push({
        code: 'Z',
        severity: 'error',
        title: 'Độ cao ngoài ngưỡng (Box bị âm đường)',
        detail: `Đáy box z=${bottomZ.toFixed(2)}m thấp bất thường`,
      });
    }
    return { lidarPointCount: null, warnings };
  }

  // Rotation matrix R^T (world -> local box coordinates) for Euler XYZ
  const c1 = Math.cos(rx);
  const s1 = Math.sin(rx);
  const c2 = Math.cos(ry);
  const s2 = Math.sin(ry);
  const c3 = Math.cos(rz);
  const s3 = Math.sin(rz);

  const r00 = c2 * c3;
  const r01 = c1 * s3 + s1 * s2 * c3;
  const r02 = s1 * s3 - c1 * s2 * c3;
  const r10 = -c2 * s3;
  const r11 = c1 * c3 - s1 * s2 * s3;
  const r12 = s1 * c3 + c1 * s2 * s3;
  const r20 = s2;
  const r21 = -s1 * c2;
  const r22 = c1 * c2;

  // Expanded AABB for fast point scanning (includes 1.4m ring around box for ground Z & boundary cut checks)
  const marginXY = 1.4;
  const marginZ = 1.0;
  const maxHalfSpan = Math.hypot(hx + marginXY, hy + marginXY, hz + marginZ);

  let insideCount = 0;
  let minLx = Infinity;
  let maxLx = -Infinity;
  let minLy = Infinity;
  let maxLy = -Infinity;
  let sumLx = 0;
  let sumLy = 0;
  let boundaryCutCount = 0;
  const innerHRelSamples: number[] = [];
  const underBoxHRelSamples: number[] = [];
  const ringGroundHRelSamples: number[] = [];

  const len = positionArray.length;
  for (let i = 0; i < len; i += 3) {
    const px = positionArray[i] ?? 0;
    const py = positionArray[i + 1] ?? 0;
    const pz = positionArray[i + 2] ?? 0;

    const dx = px - cx;
    const dy = py - cy;
    const dz = pz - cz;

    if (
      Math.abs(dx) > maxHalfSpan ||
      Math.abs(dy) > maxHalfSpan ||
      Math.abs(dz) > maxHalfSpan
    ) {
      continue;
    }

    const lx = r00 * dx + r01 * dy + r02 * dz;
    const ly = r10 * dx + r11 * dy + r12 * dz;
    const lz = r20 * dx + r21 * dy + r22 * dz;
    // Height relative to the box's bottom face (hRel = 0 at bottomZ, hRel = H at topZ)
    const hRel = lz + hz;

    const insideX = Math.abs(lx) <= hx;
    const insideY = Math.abs(ly) <= hy;
    const insideZ = Math.abs(lz) <= hz;

    if (insideX && insideY && insideZ) {
      insideCount += 1;
      innerHRelSamples.push(hRel);
      if (lx < minLx) minLx = lx;
      if (lx > maxLx) maxLx = lx;
      if (ly < minLy) minLy = ly;
      if (ly > maxLy) maxLy = ly;
      sumLx += lx;
      sumLy += ly;
    } else if (insideX && insideY && hRel >= -0.85 && hRel < -0.03) {
      // Points directly underneath the box footprint
      underBoxHRelSamples.push(hRel);
    } else if (
      (!insideX || !insideY) &&
      Math.abs(lx) <= hx + marginXY &&
      Math.abs(ly) <= hy + marginXY &&
      hRel >= -0.9 &&
      hRel <= 0.45
    ) {
      // Ground ring strictly outside the box footprint (never polluted by upper object body points)
      ringGroundHRelSamples.push(hRel);
    }

    if (
      !(insideX && insideY && insideZ) &&
      // Check mid-body points (at least 0.25m above box bottom so road points are excluded)
      // that sit right outside the box wall (within 20% or 0.28m of the wall) -> box cuts into object points!
      lz > -hz + 0.25 &&
      lz < hz - 0.05 &&
      Math.abs(lx) <= hx + Math.min(0.28, hx * 0.22) &&
      Math.abs(ly) <= hy + Math.min(0.28, hy * 0.22)
    ) {
      boundaryCutCount += 1;
    }
  }

  // 3. [F] Sparse point cloud check (< 6 points inside box when outside is OFF per guide_13.json section 4.2)
  if (!outside && insideCount < 6 && !occluded) {
    warnings.push({
      code: 'F',
      severity: 'error',
      title: 'Thừa box (đang tắt Outside)',
      detail: `Đang tắt Outside khi trong box chỉ có ${insideCount} điểm LiDAR (quy chuẩn >= 6 điểm)`,
    });
  }

  // 4. [Z] Smart Ground Contact Check:
  // A correct box sits RIGHT ON TOP OF ground points (hRel ~ -0.06m..+0.04m), neither pressing down
  // onto the ground (`đè lên point đất` / âm đất) nor leaving excess empty space / floating (`bay / dư đáy`).
  innerHRelSamples.sort((a, b) => a - b);
  underBoxHRelSamples.sort((a, b) => a - b);
  ringGroundHRelSamples.sort((a, b) => a - b);

  const minInnerHRel =
    innerHRelSamples.length >= 4
      ? innerHRelSamples[Math.floor(innerHRelSamples.length * 0.05)]!
      : innerHRelSamples[0] ?? null;

  let zWarned = false;

  if (ringGroundHRelSamples.length >= 6) {
    const nRing = ringGroundHRelSamples.length;
    const ringP15 = ringGroundHRelSamples[Math.floor(nRing * 0.15)]!;
    const ringP30 = ringGroundHRelSamples[Math.floor(nRing * 0.3)]!;
    const ringP80 = ringGroundHRelSamples[Math.floor(nRing * 0.8)]!;
    const ringSpread = ringP80 - ringP15;
    const isUnevenGround = ringSpread > 0.22; // `đất lôm côm` (sloped/curb/noisy ground)

    // `groundHRel` = groundZ - bottomZ:
    // - Positive (> 0): ground is ABOVE bottomZ -> box is pressing into / below ground (`đè lên point đất` / âm đất)
    // - Negative (< 0): ground is BELOW bottomZ -> box bottom is above ground (`bay` if too negative)
    const groundHRel = ringP30;
    const zDeltaFromGround = -groundHRel; // bottomZ - groundZ

    const tolUnderground = isUnevenGround ? 0.22 : 0.11;
    const tolFloating = isUnevenGround ? 0.26 : 0.16;
    const terrainNote = isUnevenGround ? ' [nền đất gồ ghề]' : '';

    if (zDeltaFromGround < -tolUnderground) {
      zWarned = true;
      warnings.push({
        code: 'Z',
        severity: 'error',
        title: `Box bị âm đất / đè lên point đất${terrainNote}`,
        detail: `Đáy box chìm thấp hơn lớp point đất xung quanh ${zDeltaFromGround.toFixed(2)}m`,
      });
    } else if (zDeltaFromGround > tolFloating) {
      zWarned = true;
      warnings.push({
        code: 'Z',
        severity: 'error',
        title: `Box bị bay khỏi point đất${terrainNote}`,
        detail: `Đáy box cao hơn lớp point đất xung quanh +${zDeltaFromGround.toFixed(2)}m`,
      });
    }
  }

  // Direct under-footprint check (catches floating box even when surrounding ring has no ground points)
  if (!zWarned && underBoxHRelSamples.length >= 4) {
    const underMed = underBoxHRelSamples[Math.floor(underBoxHRelSamples.length * 0.5)]!;
    const gapBelow = -underMed;
    if (gapBelow > 0.12) {
      zWarned = true;
      warnings.push({
        code: 'Z',
        severity: 'error',
        title: 'Box bị bay (chưa chạm point đất dưới đáy)',
        detail: `Đáy box còn cách lớp điểm ngay dưới đáy +${gapBelow.toFixed(2)}m`,
      });
    }
  }

  // Excess bottom gap inside the box (`dư khoảng trống dưới đáy`: bottomZ pulled lower than lowest object points)
  if (
    !zWarned &&
    minInnerHRel !== null &&
    innerHRelSamples.length >= 6 &&
    underBoxHRelSamples.length === 0 &&
    minInnerHRel > Math.max(0.26, H * 0.22)
  ) {
    zWarned = true;
    warnings.push({
      code: 'Z',
      severity: 'warning',
      title: 'Dư khoảng trống dưới đáy box',
      detail: `Đáy box thấp hơn điểm thấp nhất của vật thể ${minInnerHRel.toFixed(2)}m (chưa ôm sát đáy)`,
    });
  }

  // Fallback when NO ground points exist around/under box (`ko có đất`):
  // Compare bottomZ against nearby boxes on the same frame (`drawnObjects`) or global road envelope
  if (!zWarned && ringGroundHRelSamples.length < 6 && underBoxHRelSamples.length < 4) {
    const neighborBottomZs: number[] = [];
    if (drawnObjects) {
      for (const [otherKey, otherEntry] of Object.entries(drawnObjects)) {
        const otherId = Number(
          otherEntry?.data?.clientID ?? otherEntry?.state?.clientID ?? otherKey
        );
        if (otherId === clientID || otherEntry?.data?.hidden || otherEntry?.data?.outside) {
          continue;
        }
        const otherPts = otherEntry?.state?.points ?? otherEntry?.data?.points;
        if (!Array.isArray(otherPts) || otherPts.length < 9) {
          continue;
        }
        const ox = Number(otherPts[0]);
        const oy = Number(otherPts[1]);
        const oz = Number(otherPts[2]);
        const oH = Number(otherPts[8]);
        const distXY = Math.hypot(cx - ox, cy - oy);
        if (distXY <= 22 && Number.isFinite(oz) && Number.isFinite(oH)) {
          neighborBottomZs.push(oz - oH * 0.5);
        }
      }
    }

    if (neighborBottomZs.length >= 1) {
      neighborBottomZs.sort((a, b) => a - b);
      const refBottomZ = neighborBottomZs[Math.floor(neighborBottomZs.length * 0.5)]!;
      const diffNeighborZ = bottomZ - refBottomZ;
      if (diffNeighborZ > 0.42) {
        zWarned = true;
        warnings.push({
          code: 'Z',
          severity: 'warning',
          title: 'Box nghi bị bay (vùng không có point đất)',
          detail: `Đáy box cao hơn mặt đáy các box lân cận +${diffNeighborZ.toFixed(2)}m`,
        });
      } else if (diffNeighborZ < -0.42) {
        zWarned = true;
        warnings.push({
          code: 'Z',
          severity: 'warning',
          title: 'Box nghi bị âm đất (vùng không có point đất)',
          detail: `Đáy box thấp hơn mặt đáy các box lân cận ${diffNeighborZ.toFixed(2)}m`,
        });
      }
    } else if (bottomZ > 2.2 || bottomZ < -2.8) {
      warnings.push({
        code: 'Z',
        severity: 'error',
        title: 'Độ cao ngoài ngưỡng (vùng không có point đất)',
        detail: `Đáy box z=${bottomZ.toFixed(2)}m ngoài ngưỡng mặt đường`,
      });
    }
  }

  // 5. [T] Sai kích thước & [P] Lỗi sai vị trí (when enough points exist to evaluate fit)
  if (insideCount >= 12 && !occluded) {
    const spanX = maxLx - minLx;
    const spanY = maxLy - minLy;
    const fillRatioX = L > 0 ? spanX / L : 1;
    const fillRatioY = W > 0 ? spanY / W : 1;

    if (fillRatioX < 0.52 && fillRatioY < 0.52) {
      warnings.push({
        code: 'T',
        severity: 'warning',
        title: 'Sai kích thước (dư khoảng trống lớn)',
        detail: `Cụm điểm chỉ chiếm ${(fillRatioX * 100).toFixed(0)}% chiều dài & ${(fillRatioY * 100).toFixed(0)}% chiều rộng box`,
      });
    }

    const meanLx = sumLx / insideCount;
    const meanLy = sumLy / insideCount;
    const isOffCenter = Math.abs(meanLx) > hx * 0.42 || Math.abs(meanLy) > hy * 0.42;
    const hasWallCut = boundaryCutCount >= Math.max(5, Math.floor(insideCount * 0.15));

    if (hasWallCut || (isOffCenter && boundaryCutCount >= 3)) {
      warnings.push({
        code: 'P',
        severity: 'error',
        title: 'Lỗi sai vị trí (cắt điểm / lệch cụm LiDAR)',
        detail: hasWallCut
          ? `Cạnh box cắt qua ${boundaryCutCount} điểm LiDAR sát vách ngoài`
          : `Tâm cụm điểm lệch (${meanLx.toFixed(2)}m, ${meanLy.toFixed(2)}m) so với tâm box`,
      });
    }
  } else if (insideCount >= 4 && boundaryCutCount >= 6) {
    warnings.push({
      code: 'P',
      severity: 'error',
      title: 'Lỗi sai vị trí (lệch khỏi cụm điểm LiDAR)',
      detail: `Có ${boundaryCutCount} điểm LiDAR nằm sát ngoài vách box (trong box chỉ có ${insideCount} điểm)`,
    });
  }

  return { lidarPointCount: insideCount, warnings };
}

/**
 * Computes the complete QA report for the currently active 3D object on the current frame.
 */
export function evaluateActiveObjectQaReport(params: {
  readonly clientID: number;
  readonly frame: number;
  readonly drawnEntry?: CvatDrawnObjectEntry | null;
  readonly stateOnCurrentFrame?: (CvatObjectStateLike & {
    label?: CvatLabelLike;
    label_id?: number;
    pos?: readonly number[] | { readonly x: number; readonly y: number; readonly z?: number };
    position?: readonly number[] | { readonly x: number; readonly y: number; readonly z?: number };
  }) | null;
  readonly drawnObjects?: Record<number | string, CvatDrawnObjectEntry | undefined>;
  readonly positionArray?: Float32Array | number[] | null;
  readonly fallbackLabelName?: string;
  readonly domAttributes?: Record<string, string>;
  readonly isOutsideOnCurrentFrame?: boolean;
  readonly fallbackPos?:
    | readonly number[]
    | { readonly x: number; readonly y: number; readonly z?: number }
    | null;
}): ActiveObjectQaReport | null {
  const {
    clientID,
    frame,
    drawnEntry,
    stateOnCurrentFrame,
    drawnObjects,
    positionArray,
    fallbackLabelName,
    domAttributes,
    isOutsideOnCurrentFrame,
    fallbackPos,
  } = params;

  const state = stateOnCurrentFrame ?? drawnEntry?.state ?? null;
  if (
    Boolean(isOutsideOnCurrentFrame) ||
    Boolean(state?.outside) ||
    Boolean(drawnEntry?.data?.outside) ||
    Boolean(drawnEntry?.state?.outside)
  ) {
    return null;
  }

  const keyframes = state ? extractTrackKeyframes(state) : [];
  let effectiveKf: ResolvedKeyframeShape | undefined;
  for (const k of keyframes) {
    if (k.frame <= frame) {
      effectiveKf = k;
    } else {
      break;
    }
  }
  const firstKf = keyframes[0];
  if (effectiveKf?.outside || (firstKf !== undefined && frame < firstKf.frame)) {
    return null;
  }

  const meshPersp = drawnEntry?.cuboid?.perspective;
  const meshPoints =
    meshPersp?.position && meshPersp?.scale
      ? [
          Number(meshPersp.position.x),
          Number(meshPersp.position.y),
          Number(meshPersp.position.z),
          Number(meshPersp.rotation?.x ?? 0),
          Number(meshPersp.rotation?.y ?? 0),
          Number(meshPersp.rotation?.z ?? 0),
          Number(meshPersp.scale.x),
          Number(meshPersp.scale.y),
          Number(meshPersp.scale.z),
        ]
      : null;

  const points =
    Array.isArray(state?.points) && state.points.length >= 9
      ? state.points
      : Array.isArray(drawnEntry?.data?.points) && drawnEntry.data.points.length >= 9
        ? drawnEntry.data.points
        : meshPoints;

  const posOnly = extractPosCoordinates(state, drawnEntry, fallbackPos);
  if (!points && !posOnly) {
    return null;
  }

  // Step 1: Check Label & Attributes FIRST to determine the exact threshold rule
  const { labelName, rule } = resolveDimensionThresholdRule(
    state,
    fallbackLabelName,
    domAttributes
  );
  const warnings: QaWarningItem[] = [];

  if (!points && posOnly) {
    // Only `pos` is available -> calculate `d` from `pos` and evaluate [D] (> 80m)
    const distanceMeters = computeDistanceFromPos(posOnly.x, posOnly.y, posOnly.z);
    const spatial = evaluateSpatialAndPointCloudWarnings({
      clientID,
      currentPoints: [posOnly.x, posOnly.y, posOnly.z],
      pos: posOnly,
      outside: false,
      drawnObjects,
      positionArray: null,
    });
    warnings.push(...spatial.warnings);

    return {
      clientID,
      frame,
      labelName,
      subtypeLabel: rule.subtypeLabel,
      dimensions: { L: 0, W: 0, H: 0 },
      distanceMeters,
      bottomZ: posOnly.z,
      lidarPointCount: null,
      thresholdRule: rule,
      warnings,
    };
  }

  const L = Number(points![6]);
  const W = Number(points![7]);
  const H = Number(points![8]);
  const cx = Number(points![0]);
  const cy = Number(points![1]);
  const cz = Number(points![2]);

  if (!Number.isFinite(L) || !Number.isFinite(W) || !Number.isFinite(H)) {
    return null;
  }

  // Step 2: [K] Dimension threshold check
  const kWarning = checkDimensionThresholdViolation(L, W, H, rule);
  if (kWarning) {
    warnings.push(kWarning);
  }

  // Step 3: Track history checks ([S], [H], [J], [M])
  if (state) {
    const trackWarnings = evaluateTrackHistoryWarnings(
      frame,
      points!,
      state.attributes ?? {},
      keyframes,
      rule.category
    );
    warnings.push(...trackWarnings);
  }

  // Step 4: Spatial & LiDAR point cloud checks ([Z], [F], [T], [P], [D])
  const occluded = Boolean((state as { occluded?: boolean } | null)?.occluded);
  const spatial = evaluateSpatialAndPointCloudWarnings({
    clientID,
    currentPoints: points!,
    pos: posOnly,
    occluded,
    outside: false,
    drawnObjects,
    positionArray,
  });
  warnings.push(...spatial.warnings);

  return {
    clientID,
    frame,
    labelName,
    subtypeLabel: rule.subtypeLabel,
    dimensions: { L, W, H },
    distanceMeters: computeDistanceFromPos(cx, cy, cz),
    bottomZ: cz - H * 0.5,
    lidarPointCount: spatial.lidarPointCount,
    thresholdRule: rule,
    warnings,
  };
}

export const QA_OVERLAY_ELEMENT_ID = 'cvat-3d-enhancer-active-qa-overlay';

/**
 * Renders or hides the non-intrusive QA Warning HUD overlay directly over the 3D perspective
 * `<canvas>` container (`.cvat-canvas3d-perspective`).
 */
export function renderActiveObjectQaOverlayDom(
  doc: Document,
  report: ActiveObjectQaReport | null,
  enabled: boolean
): void {
  const existing = doc.getElementById(QA_OVERLAY_ELEMENT_ID);
  if (!enabled || !report) {
    if (existing) {
      existing.style.display = 'none';
    }
    return;
  }

  const perspectiveContainer =
    doc.querySelector<HTMLElement>('.cvat-canvas3d-perspective .cvat-canvas-container') ??
    doc.querySelector<HTMLElement>('.cvat-canvas3d-perspective');

  if (!perspectiveContainer) {
    return;
  }

  const computedPos = doc.defaultView?.getComputedStyle(perspectiveContainer)?.position;
  if (!computedPos || computedPos === 'static') {
    perspectiveContainer.style.position = 'relative';
  }

  let overlay = existing as HTMLDivElement | null;
  if (!overlay) {
    overlay = doc.createElement('div');
    overlay.id = QA_OVERLAY_ELEMENT_ID;
    overlay.style.cssText = [
      'position: absolute',
      'top: 10px',
      'left: 10px',
      'z-index: 25',
      'max-width: min(440px, calc(100% - 20px))',
      'padding: 8px 11px',
      'border-radius: 6px',
      'background: rgba(15, 23, 42, 0.86)',
      'backdrop-filter: blur(4px)',
      'color: #f8fafc',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 12px',
      'line-height: 1.4',
      'pointer-events: none',
      'user-select: none',
      'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35)',
      'border: 1px solid rgba(148, 163, 184, 0.3)',
    ].join('; ');
    perspectiveContainer.appendChild(overlay);
  } else if (overlay.parentElement !== perspectiveContainer) {
    perspectiveContainer.appendChild(overlay);
  }

  const hasWarnings = report.warnings.length > 0;
  overlay.style.borderColor = hasWarnings
    ? 'rgba(248, 113, 113, 0.85)'
    : 'rgba(52, 211, 153, 0.75)';
  overlay.style.display = 'block';

  const ptsBadge =
    report.lidarPointCount !== null ? ` • ${report.lidarPointCount} pts` : '';
  const ruleBoundsParts: string[] = [];
  const r = report.thresholdRule;
  if (r.minL !== undefined || r.maxL !== undefined) {
    ruleBoundsParts.push(`L:${r.minL ?? '–'}..${r.maxL ?? '∞'}`);
  }
  if (r.minW !== undefined || r.maxW !== undefined) {
    ruleBoundsParts.push(`W:${r.minW ?? '–'}..${r.maxW ?? '∞'}`);
  }
  if (r.minH !== undefined || r.maxH !== undefined) {
    ruleBoundsParts.push(`H:${r.minH ?? '–'}..${r.maxH ?? '∞'}`);
  }
  const ruleSummary = ruleBoundsParts.length > 0 ? ` (${ruleBoundsParts.join(', ')})` : '';

  overlay.replaceChildren();

  // Header line: ID + Label (Attribute Subtype) + Current Dimensions
  const headerDiv = doc.createElement('div');
  headerDiv.style.cssText =
    'display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; margin-bottom: 4px;';

  const idBadge = doc.createElement('span');
  idBadge.style.cssText =
    'background: #2563eb; color: #ffffff; padding: 1px 6px; border-radius: 4px; font-size: 11px;';
  idBadge.textContent = `ID #${report.clientID}`;

  const attrBadge = doc.createElement('span');
  attrBadge.style.cssText = 'color: #38bdf8; font-weight: 600;';
  attrBadge.textContent = `${report.labelName} [${report.subtypeLabel}]`;

  const dimSpan = doc.createElement('span');
  dimSpan.style.cssText = 'color: #e2e8f0; font-weight: 500;';
  const distText = ` • d:${report.distanceMeters.toFixed(1)}m`;
  dimSpan.textContent =
    report.dimensions.L > 0 || report.dimensions.W > 0 || report.dimensions.H > 0
      ? `L:${report.dimensions.L.toFixed(2)} W:${report.dimensions.W.toFixed(2)} H:${report.dimensions.H.toFixed(2)}m${distText}${ptsBadge}`
      : `d:${report.distanceMeters.toFixed(1)}m${ptsBadge}`;

  headerDiv.appendChild(idBadge);
  headerDiv.appendChild(attrBadge);
  headerDiv.appendChild(dimSpan);
  overlay.appendChild(headerDiv);

  if (!hasWarnings) {
    const okDiv = doc.createElement('div');
    okDiv.style.cssText = 'color: #4ade80; font-weight: 600; font-size: 11.5px;';
    okDiv.textContent = `✓ Đạt chuẩn kích thước & vị trí${ruleSummary}`;
    overlay.appendChild(okDiv);
    return;
  }

  const listDiv = doc.createElement('div');
  listDiv.style.cssText = 'display: flex; flex-direction: column; gap: 3px; margin-top: 3px;';

  for (const w of report.warnings) {
    const row = doc.createElement('div');
    row.style.cssText = 'display: flex; align-items: baseline; gap: 6px; font-size: 11.5px;';

    const codeBadge = doc.createElement('span');
    const isErr = w.severity === 'error';
    codeBadge.style.cssText = [
      'display: inline-block',
      'min-width: 22px',
      'text-align: center',
      'padding: 0 4px',
      'border-radius: 3px',
      'font-weight: 700',
      'font-size: 11px',
      isErr
        ? 'background: #ef4444; color: #ffffff;'
        : 'background: #f59e0b; color: #0f172a;',
    ].join('; ');
    codeBadge.textContent = w.code;

    const textSpan = doc.createElement('span');
    textSpan.style.cssText = isErr ? 'color: #fca5a5;' : 'color: #fde68a;';
    textSpan.textContent = `${w.title}: ${w.detail}`;

    row.appendChild(codeBadge);
    row.appendChild(textSpan);
    listDiv.appendChild(row);
  }

  overlay.appendChild(listDiv);
}

/**
 * Helper to extract the active perspective point cloud position buffer (`Float32Array | number[]`)
 * from `CvatInternalViewLike`.
 */
export function getPerspectivePointCloudPositions(
  view?: CvatInternalViewLike | null
): Float32Array | number[] | null {
  const perspectiveScene = view?.views?.perspective?.scene;
  const pointsList = findPointsObjectsInScene(perspectiveScene);
  const posAttr = pointsList[0]?.geometry?.attributes?.position;
  return posAttr?.array ?? null;
}
