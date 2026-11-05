import { describe, expect, it } from 'vitest';
import {
  checkDimensionThresholdViolation,
  evaluateActiveObjectQaReport,
  evaluateSpatialAndPointCloudWarnings,
  evaluateTrackHistoryWarnings,
  extractSidebarDomLabelAndAttributes,
  QA_OVERLAY_ELEMENT_ID,
  renderActiveObjectQaOverlayDom,
  resolveDimensionThresholdRule,
} from '../../src/integration/cvat/runtime/active-object-qa-overlay';

describe('Active Object QA Warning Overlay (10 QA Codes + Attribute-First Dimension Thresholds)', () => {
  it('resolves attribute-first dimension threshold rules for vehicles, two-wheels, and pedestrian (including labels_job_1867.json attribute IDs)', () => {
    // 1. vehicles + type=car (id 6257 from labels_job_1867.json)
    const carResolved = resolveDimensionThresholdRule({
      clientID: 1,
      label: { name: 'vehicles' },
      attributes: { 6257: 'car' },
    });
    expect(carResolved.rule).toEqual({
      category: 'vehicles',
      subtypeLabel: 'car',
      minL: 3.2,
      maxL: 5.5,
      minW: 1.6,
      maxW: 2.2,
      minH: 1.5,
      maxH: 1.9,
    });

    // Valid car dimensions: L=4.5, W=1.85, H=1.65 -> null
    expect(checkDimensionThresholdViolation(4.5, 1.85, 1.65, carResolved.rule)).toBeNull();

    // Car with truck length L=6.2 -> triggers [K] because attribute type='car' caps L <= 5.5
    const carTooLong = checkDimensionThresholdViolation(6.2, 1.85, 1.65, carResolved.rule);
    expect(carTooLong?.code).toBe('K');
    expect(carTooLong?.detail).toContain('L=6.20m > max 5.5m');

    // 2. vehicles + type=truck (or contruction / bus / other) -> only min thresholds, no max cap!
    const truckResolved = resolveDimensionThresholdRule({
      clientID: 2,
      label: { name: 'vehicles' },
      attributes: { 6257: 'truck' },
    });
    expect(truckResolved.rule.subtypeLabel).toBe('truck');
    expect(truckResolved.rule.maxL).toBeUndefined();
    // L=8.5, W=2.5, H=3.2 is VALID for truck!
    expect(checkDimensionThresholdViolation(8.5, 2.5, 3.2, truckResolved.rule)).toBeNull();
    // Truck with L=2.8 (< 3.2) -> triggers [K]
    expect(checkDimensionThresholdViolation(2.8, 2.0, 2.5, truckResolved.rule)?.code).toBe('K');

    // 3. two-wheels + ride_state=true vs false (id 6260 from labels_job_1867.json)
    const riderResolved = resolveDimensionThresholdRule({
      label: { name: 'two-wheels' },
      attributes: { 6260: 'true', 6261: 'motorcycle' },
    });
    const noRiderResolved = resolveDimensionThresholdRule({
      label: { name: 'two-wheels' },
      attributes: { 6260: 'false', 6261: 'bicycle' },
    });
    expect(riderResolved.rule.subtypeLabel).toContain('rider');
    expect(noRiderResolved.rule.subtypeLabel).toContain('without rider');
    expect(noRiderResolved.rule.minH).toBe(1.2);
    expect(noRiderResolved.rule.maxH).toBe(1.8);

    // H=1.3m is INVALID when ride_state=true (requires H in [1.5, 1.8]), but VALID when ride_state=false (requires H in [1.2, 1.8])
    expect(checkDimensionThresholdViolation(1.75, 0.75, 1.3, riderResolved.rule)?.code).toBe('K');
    expect(checkDimensionThresholdViolation(1.75, 0.75, 1.3, noRiderResolved.rule)).toBeNull();
    // H=1.1m (< 1.2m) is INVALID even when ride_state=false (minH = 1.2m)
    expect(checkDimensionThresholdViolation(1.75, 0.75, 1.1, noRiderResolved.rule)?.code).toBe(
      'K'
    );

    // 4. pedestrian + pose=standing / bending / sitting (id 6259 from labels_job_1867.json)
    const standingResolved = resolveDimensionThresholdRule({
      label: { name: 'pedestrian' },
      attributes: { 6259: 'standing' },
    });
    const bendingResolved = resolveDimensionThresholdRule({
      label: { name: 'pedestrian' },
      attributes: { 6259: 'bending' },
    });
    const sittingResolved = resolveDimensionThresholdRule({
      label: { name: 'pedestrian' },
      attributes: { 6259: 'sitting' },
    });

    // H=1.35m: invalid for standing (min 1.5), valid for bending ([1.2, 1.9]), invalid for sitting (max 1.2)
    expect(checkDimensionThresholdViolation(0.75, 0.75, 1.35, standingResolved.rule)?.code).toBe(
      'K'
    );
    expect(checkDimensionThresholdViolation(0.75, 0.75, 1.35, bendingResolved.rule)).toBeNull();
    expect(checkDimensionThresholdViolation(0.75, 0.75, 1.35, sittingResolved.rule)?.code).toBe(
      'K'
    );
  });

  it('detects [S] unsynchronized dimensions ONLY across keyframes with 100% identical attributes, plus [H], [J], and [M]', () => {
    const keyframes = [
      // Frame 0: standing, L=0.8, W=0.8, H=1.7, yaw=0, pos=(0, 0, 0)
      {
        frame: 0,
        points: [0, 0, 0, 0, 0, 0, 0.8, 0.8, 1.7],
        attributes: { 6258: 'adult', 6259: 'standing' },
        outside: false,
        occluded: false,
      },
      // Frame 1: standing (same attributes!), moved +15m along +X (jump > 2.5m/f -> [J]), L=0.92 (unsynced -> [S]), yaw=Math.PI (180 deg flip -> [H])
      {
        frame: 1,
        points: [15.0, 0, 0, 0, 0, Math.PI, 0.92, 0.8, 1.7],
        attributes: { 6258: 'adult', 6259: 'standing' },
        outside: false,
        occluded: false,
      },
      // Frame 2: short missing gap (outside=true for frames 2..3 -> [M])
      {
        frame: 2,
        points: [15.0, 0, 0, 0, 0, Math.PI, 0.92, 0.8, 1.7],
        attributes: { 6258: 'adult', 6259: 'standing' },
        outside: true,
        occluded: false,
      },
      // Frame 4: reappears with pose changed to sitting and H=1.1 (should NOT count as [S] against frame 0's H=1.7!)
      {
        frame: 4,
        points: [16.0, 0, 0, 0, 0, 0, 0.8, 0.8, 1.1],
        attributes: { 6258: 'adult', 6259: 'sitting' },
        outside: false,
        occluded: false,
      },
    ];

    const warningsAtFrame1 = evaluateTrackHistoryWarnings(
      1,
      [15.0, 0, 0, 0, 0, Math.PI, 0.92, 0.8, 1.7],
      { 6258: 'adult', 6259: 'standing' },
      keyframes,
      'pedestrian'
    );
    const codesAtFrame1 = warningsAtFrame1.map((w) => w.code);
    expect(codesAtFrame1).toContain('S');
    expect(codesAtFrame1).toContain('H');
    expect(codesAtFrame1).toContain('J');
    expect(codesAtFrame1).toContain('M');

    const missingWarning = warningsAtFrame1.find((w) => w.code === 'M');
    expect(missingWarning?.detail).toContain('2..3');

    // For two-wheels with ride_state: W is allowed to vary across frames, while H and L must always fit across frames
    const twoWheelKeyframes = [
      {
        frame: 0,
        points: [0, 0, 0, 0, 0, 0, 1.75, 0.65, 1.65],
        attributes: { 6260: 'true', 6261: 'motorcycle' },
        outside: false,
        occluded: false,
      },
      {
        frame: 1,
        // W changed from 0.65 to 0.85, but L=1.75 and H=1.65 are identical -> NO [S] warning!
        points: [1.5, 0, 0, 0, 0, 0, 1.75, 0.85, 1.65],
        attributes: { 6260: 'true', 6261: 'motorcycle' },
        outside: false,
        occluded: false,
      },
    ];
    const twoWheelWarnOk = evaluateTrackHistoryWarnings(
      1,
      [1.5, 0, 0, 0, 0, 0, 1.75, 0.85, 1.65],
      { 6260: 'true', 6261: 'motorcycle' },
      twoWheelKeyframes,
      'two-wheels'
    );
    expect(twoWheelWarnOk.some((w) => w.code === 'S')).toBe(false);

    // If H or L changes on two-wheels, [S] MUST trigger!
    const twoWheelWarnMismatchHL = evaluateTrackHistoryWarnings(
      1,
      [1.5, 0, 0, 0, 0, 0, 1.85, 0.85, 1.65],
      { 6260: 'true', 6261: 'motorcycle' },
      twoWheelKeyframes,
      'two-wheels'
    );
    expect(twoWheelWarnMismatchHL.some((w) => w.code === 'S')).toBe(true);

    // Even when ride_state is turned ON ('true') on the current frame while other keyframes still have 'false',
    // a different H (e.g. 1.72 vs 1.60) MUST still report [S] on H!
    const twoWheelMixedAttrKeyframes = [
      {
        frame: 0,
        points: [0, 0, 0, 0, 0, 0, 1.75, 0.65, 1.6],
        attributes: { 6260: 'false', 6261: 'motorcycle' },
        outside: false,
        occluded: false,
      },
      {
        frame: 1,
        points: [1.5, 0, 0, 0, 0, 0, 1.75, 0.85, 1.72],
        attributes: { 6260: 'true', 6261: 'motorcycle' },
        outside: false,
        occluded: false,
      },
    ];
    const twoWheelWarnHWhenRiderOn = evaluateTrackHistoryWarnings(
      1,
      [1.5, 0, 0, 0, 0, 0, 1.75, 0.85, 1.72],
      { 6260: 'true', 6261: 'motorcycle' },
      twoWheelMixedAttrKeyframes,
      'two-wheels'
    );
    expect(twoWheelWarnHWhenRiderOn.some((w) => w.code === 'S' && w.detail.includes('H'))).toBe(
      true
    );
  });

  it('detects [Z] floating/underground box, [F] overlapping/sparse box, [T] loose box, [P] cutting LiDAR points, and [D] far distance', () => {
    const coords: number[] = [];
    // Ground points at Z = 0 within the expanded AABB around (10, 0)
    for (let i = 0; i < 20; i += 1) {
      coords.push(9.0 + (i % 5) * 0.5, -0.8 + Math.floor(i / 5) * 0.5, 0.0);
    }
    // 15 object cluster points tightly packed inside X in [9.7, 10.3], Y in [-0.25, 0.25], Z in [0.7, 1.6]
    // (occupying < 35% of L=2.0 and W=1.8 -> triggers [T])
    for (let i = 0; i < 15; i += 1) {
      coords.push(9.7 + (i % 5) * 0.12, -0.2 + (i % 3) * 0.2, 0.7 + (i % 4) * 0.2);
    }
    // 10 mid-body points right outside +X wall (X = 11.0 is front wall of box centered at X=10, L=2.0) -> triggers [P]
    for (let i = 0; i < 10; i += 1) {
      coords.push(11.08, -0.2 + (i % 5) * 0.1, 0.9 + (i % 3) * 0.15);
    }

    const posArray = new Float32Array(coords);

    // Active box #1 centered at (10, 0, 1.5) with L=2.0, W=1.8, H=2.0 -> bottomZ = 0.5m (floating +0.5m above Z=0 ground -> [Z])
    // Also overlaps with box #2 at (10.2, 0, 1.5) -> [F]
    const activePoints = [10, 0, 1.5, 0, 0, 0, 2.0, 1.8, 2.0];
    const drawnObjects = {
      1: {
        cuboid: {},
        data: {
          clientID: 1,
          points: activePoints,
          hidden: false,
          outside: false,
        },
      },
      2: {
        cuboid: {},
        data: {
          clientID: 2,
          points: [10.2, 0, 1.5, 0, 0, 0, 2.0, 1.8, 2.0],
          hidden: false,
          outside: false,
        },
      },
    };

    const result = evaluateSpatialAndPointCloudWarnings({
      clientID: 1,
      currentPoints: activePoints,
      drawnObjects,
      positionArray: posArray,
    });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain('Z');
    expect(codes).toContain('F');
    expect(codes).toContain('T');
    expect(codes).toContain('P');

    // Verify [D] does NOT trigger at <= 80m (e.g. ~68m), and DOES trigger when > 80m away
    const under80Result = evaluateSpatialAndPointCloudWarnings({
      clientID: 1,
      currentPoints: [65, 20, 0, 0, 0, 0, 4.2, 1.8, 1.6],
      drawnObjects: {},
      positionArray: null,
    });
    expect(under80Result.warnings.map((w) => w.code)).not.toContain('D');

    const farResult = evaluateSpatialAndPointCloudWarnings({
      clientID: 1,
      currentPoints: [75, 35, 0, 0, 0, 0, 4.2, 1.8, 1.6],
      drawnObjects: {},
      positionArray: null,
    });
    expect(farResult.warnings.map((w) => w.code)).toContain('D');

    // Also verify [D] when only `pos` is provided (without 9-DoF points)
    const posOnlyReport = evaluateActiveObjectQaReport({
      clientID: 11,
      frame: 0,
      stateOnCurrentFrame: {
        clientID: 11,
        frame: 0,
        label: { name: 'vehicles' },
        pos: { x: 60, y: 60, z: -1.2 }, // d = sqrt(3600 + 3600 + 1.44) ~ 84.86m > 80m
      },
    });
    expect(posOnlyReport).not.toBeNull();
    expect(posOnlyReport?.distanceMeters).toBeGreaterThan(80);
    expect(posOnlyReport?.warnings.some((w) => w.code === 'D')).toBe(true);

    // Verify [F] is NOT reported when outside=true on the current frame
    const outsideResult = evaluateSpatialAndPointCloudWarnings({
      clientID: 1,
      currentPoints: activePoints,
      outside: true,
      drawnObjects,
      positionArray: new Float32Array([0, 0, 0]),
    });
    expect(outsideResult.warnings).toHaveLength(0);
  });

  it('renders and hides the QA overlay DOM banner inside .cvat-canvas3d-perspective', () => {
    document.body.innerHTML = `
      <div class="cvat-canvas3d-perspective" style="position: relative; width: 623px; height: 569px;">
        <canvas width="623" height="569"></canvas>
      </div>
    `;

    const points = [10, 0, 0, 0, 0, 0, 6.1, 1.85, 1.65];
    const state = {
      clientID: 7,
      frame: 12,
      label: { name: 'vehicles' },
      attributes: { 6257: 'car' },
      // L=6.1m violates car L max 5.5m -> [K]
      points,
    };

    const report = evaluateActiveObjectQaReport({
      clientID: 7,
      frame: 12,
      stateOnCurrentFrame: state,
      drawnObjects: {
        7: {
          cuboid: {},
          data: {
            clientID: 7,
            points,
          },
        },
      },
      positionArray: null,
    });

    expect(report).not.toBeNull();
    expect(report?.warnings.some((w) => w.code === 'K')).toBe(true);

    renderActiveObjectQaOverlayDom(document, report, true);

    const overlayEl = document.getElementById(QA_OVERLAY_ELEMENT_ID);
    expect(overlayEl).not.toBeNull();
    expect(overlayEl?.style.display).toBe('block');
    expect(overlayEl?.textContent).toContain('ID #7');
    expect(overlayEl?.textContent).toContain('K');

    // Disabling or passing null hides the overlay
    renderActiveObjectQaOverlayDom(document, null, true);
    expect(overlayEl?.style.display).toBe('none');
  });

  it('skips all QA checks and returns null when outside is enabled (directly, inherited from preceding keyframe, or in sidebar DOM)', () => {
    const violatingPoints = [70, 0, 5, 0, 0, 0, 9.0, 3.0, 3.0];

    // 1. Direct outside=true on state
    expect(
      evaluateActiveObjectQaReport({
        clientID: 9,
        frame: 10,
        stateOnCurrentFrame: {
          clientID: 9,
          frame: 10,
          outside: true,
          label: { name: 'vehicles' },
          attributes: { 6257: 'car' },
          points: violatingPoints,
        },
      })
    ).toBeNull();

    // 2. Inherited outside=true on non-keyframe frame 11 after outside=true keyframe at frame 10
    expect(
      evaluateActiveObjectQaReport({
        clientID: 9,
        frame: 11,
        stateOnCurrentFrame: {
          clientID: 9,
          frame: 11,
          outside: false,
          label: { name: 'vehicles' },
          attributes: { 6257: 'car' },
          points: violatingPoints,
          keyframes: {
            0: { frame: 0, points: violatingPoints, outside: false },
            10: { frame: 10, points: violatingPoints, outside: true },
          },
        } as unknown as Record<string, unknown>,
      })
    ).toBeNull();

    // 3. Sidebar DOM .cvat-object-item-button-outside-enabled
    document.body.innerHTML = `
      <div id="cvat-objects-sidebar-state-item-9">
        <span class="cvat-object-item-button-outside cvat-object-item-button-outside-enabled"></span>
      </div>
    `;
    const domExtracted = extractSidebarDomLabelAndAttributes(document, 9);
    expect(domExtracted.isOutsideInDom).toBe(true);
    expect(
      evaluateActiveObjectQaReport({
        clientID: 9,
        frame: 5,
        stateOnCurrentFrame: {
          clientID: 9,
          frame: 5,
          outside: false,
          label: { name: 'vehicles' },
          attributes: { 6257: 'car' },
          points: violatingPoints,
        },
        isOutsideOnCurrentFrame: domExtracted.isOutsideInDom,
      })
    ).toBeNull();
  });
});
