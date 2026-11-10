/** Defaults preserve the enhancements already enabled before Workspace controls were added. */
export const WORKSPACE_FEATURE_DEFAULTS = {
  showCuboidBaseGuide: true,
  disableSidebarQuickFilter: true,
  enableDimensionSync: true,
  enableHeadingFlip: true,
  enableOrthoKeyboard: true,
  fasterOrthoKeyboard: true,
  immediateKeyboardCommit: true,
  enlargePerspectivePoints: true,
} as const;

export type WorkspaceFeatureOptions = {
  readonly [Key in keyof typeof WORKSPACE_FEATURE_DEFAULTS]?: boolean;
};
export const WORKSPACE_FEATURE_KEYS = Object.keys(
  WORKSPACE_FEATURE_DEFAULTS
) as (keyof WorkspaceFeatureOptions)[];

export function normalizeWorkspaceFeatureOptions(
  record: Record<string, unknown>
): Required<WorkspaceFeatureOptions> {
  return Object.fromEntries(
    WORKSPACE_FEATURE_KEYS.map((key) => [
      key,
      typeof record[key] === 'boolean' ? record[key] : WORKSPACE_FEATURE_DEFAULTS[key],
    ])
  ) as Required<WorkspaceFeatureOptions>;
}

export const WORKSPACE_FEATURE_CONTROLS = [
  {
    key: 'showCuboidBaseGuide',
    title: 'Show cuboid base guide (Tia căn đáy box)',
    description:
      'Thin red guide at the bottom of the active box in Side/Front, including small panels',
  },
  {
    key: 'disableSidebarQuickFilter',
    title: 'Double-click focuses without Quick filter',
    description: 'Keep CVAT object focus on double-click and skip the automatic Quick filter',
  },
  {
    key: 'enableDimensionSync',
    title: 'Show H/W/L dimension sync buttons',
    description: 'Synchronize dimensions across matching track keyframes from the object sidebar',
  },
  {
    key: 'enableHeadingFlip',
    title: 'Show 180° heading flip button',
    description: 'Flip the active cuboid heading on the current frame from the object sidebar',
  },
  {
    key: 'enableOrthoKeyboard',
    title: 'Edit cuboids with W/A/S/D/Q/E',
    description: 'Move or rotate the selected cuboid while hovering Top/Side/Front',
  },
  {
    key: 'fasterOrthoKeyboard',
    title: 'Double W/A/S/D/Q/E sensitivity',
    description:
      'Use 2.5 px movement and 0.4° rotation instead of 1.25 px and 0.2°; Shift remains 4×',
  },
  {
    key: 'immediateKeyboardCommit',
    title: 'Save keyboard edits immediately on key release',
    description: 'Preview on keydown and save on keyup; unchecked saves after 250 ms of idle time',
  },
  {
    key: 'enlargePerspectivePoints',
    title: 'Enlarge main 3D points by 20%',
    description: 'Keep native zoom scaling; Top/Side/Front point sizes are unaffected',
  },
] as const;
