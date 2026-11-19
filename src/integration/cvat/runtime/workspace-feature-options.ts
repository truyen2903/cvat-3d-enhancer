/** Defaults preserve the enhancements already enabled before Workspace controls were added. */
export const WORKSPACE_FEATURE_DEFAULTS = {
  showCuboidBaseGuide: true,
  enableTrackGhosts: true,
  disableSidebarQuickFilter: true,
  enableDimensionSync: true,
  enableHeadingFlip: true,
  enableOrthoKeyboard: true,
  fasterOrthoKeyboard: true,
  immediateKeyboardCommit: true,
  enableMouseFrameNavigation: true,
  enableCanvasMultiSelect: true,
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

export const WORKSPACE_FEATURE_GROUPS = [
  'Hiển thị',
  'Chỉnh box',
  'Điều hướng',
  'Chọn nhiều',
] as const;
export type WorkspaceFeatureGroup = (typeof WORKSPACE_FEATURE_GROUPS)[number];

export const WORKSPACE_FEATURE_CONTROLS = [
  {
    key: 'enableTrackGhosts',
    group: 'Hiển thị',
    title: 'Bóng track · Alt+G',
    description: 'Giữ Alt+G để xem khung keyframe và đường đi của track.',
  },
  {
    key: 'enableMouseFrameNavigation',
    group: 'Điều hướng',
    title: 'Chuyển frame bằng nút chuột',
    description: 'Dùng nút hông Back / Forward để lùi / tiến frame.',
  },
  {
    key: 'enableCanvasMultiSelect',
    group: 'Chọn nhiều',
    title: 'Chọn nhiều box · Shift',
    description: 'Shift+click hoặc Shift+kéo để chọn nhiều box trong frame hiện tại.',
  },
  {
    key: 'showCuboidBaseGuide',
    group: 'Hiển thị',
    title: 'Tia căn đáy box',
    description: 'Hiện tia đỏ dưới box đang chọn ở góc Side / Front.',
  },
  {
    key: 'disableSidebarQuickFilter',
    group: 'Điều hướng',
    title: 'Nhấp đúp không lọc nhanh',
    description: 'Nhấp đúp để lấy nét box, bỏ qua Quick filter tự động.',
  },
  {
    key: 'enableDimensionSync',
    group: 'Chỉnh box',
    title: 'Đồng bộ H / W / L',
    description: 'Hiện nút đồng bộ kích thước cho các keyframe cùng thuộc tính.',
  },
  {
    key: 'enableHeadingFlip',
    group: 'Chỉnh box',
    title: 'Công cụ hướng box',
    description: 'Hiện nút xoay 180°, đổi L↔W và nội suy Yaw.',
  },
  {
    key: 'enableOrthoKeyboard',
    group: 'Chỉnh box',
    title: 'Chỉnh bằng W / A / S / D / Q / E',
    description: 'Di chuyển hoặc xoay box khi trỏ vào Top / Side / Front.',
  },
  {
    key: 'fasterOrthoKeyboard',
    group: 'Chỉnh box',
    title: 'Tăng độ nhạy phím ×2',
    description: 'Bước 2,5 px / 0,4° thay cho 1,25 px / 0,2°; Shift vẫn tăng ×4.',
  },
  {
    key: 'immediateKeyboardCommit',
    group: 'Chỉnh box',
    title: 'Lưu ngay khi nhả phím',
    description: 'Bỏ chọn để lưu sau 250 ms không thao tác.',
  },
] as const satisfies readonly {
  key: keyof WorkspaceFeatureOptions;
  group: WorkspaceFeatureGroup;
  title: string;
  description: string;
}[];
