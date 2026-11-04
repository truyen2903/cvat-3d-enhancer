import { z } from 'zod';
import {
  BRIDGE_CHANNEL,
  BRIDGE_COMMANDS,
  CAMERA_PRESET_ACTIONS,
  CURRENT_SCHEMA_VERSION,
} from '../constants';
import { isForbiddenKey } from '../utils/safe-object';

export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a strict 6-digit hex color (#RRGGBB)');

export const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Identifier may only contain alphanumeric characters, _ or -');

export const SafeLabelNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((val) => !isForbiddenKey(val) && !/[<>;"'`\\]/.test(val), {
    message: 'Label name contains forbidden or unsafe characters',
  });

export const ShortcutStringSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9+_-]+$/, 'Shortcut must only contain alphanumeric characters and +');

export const WorkspaceThemePresetSchema = z.enum([
  'cvat-dark',
  'midnight-slate',
  'high-contrast',
  'lidar-amber',
]);

export const CuboidColorBySchema = z.enum(['Label', 'Instance', 'Group']);

export const CuboidOrientationVisibilitySchema = z.enum(['always', 'selected', 'never']);

export const AppearanceConfigSchema = z
  .object({
    themePreset: WorkspaceThemePresetSchema,
    canvasBackgroundColor: HexColorSchema,
    panelAccentColor: HexColorSchema,
    uiDensity: z.enum(['compact', 'comfortable']),
    highContrastCrosshair: z.boolean(),
  })
  .strict();

export const Visualization3DConfigSchema = z
  .object({
    cuboidOpacity: z.number().int().min(0).max(100),
    selectedCuboidOpacity: z.number().int().min(0).max(100),
    cuboidOutlinedBorders: z.boolean(),
    cuboidOutlineColor: HexColorSchema,
    cuboidOrientationVisibility: CuboidOrientationVisibilitySchema,
    controlPointsSize: z.number().min(1).max(20),
    focusedObjectPadding: z.number().min(0).max(200),
    pointCloudCssBrightness: z.number().int().min(50).max(180),
    pointCloudCssContrast: z.number().int().min(50).max(180),
    pointSizeValue: z.number().min(0.01).max(2.0),
    gridVisible: z.boolean(),
    axesVisible: z.boolean(),
    whiteBackground: z.boolean().optional(),
    enableScattering: z.boolean().optional(),
    colorPointsByCuboid: z.boolean().optional(),
  })
  .strict();

export const AnnotationToolsConfigSchema = z
  .object({
    colorBy: CuboidColorBySchema,
    highlightActiveCuboidBorder: z.boolean(),
    labelColorOverrides: z.record(SafeLabelNameSchema, HexColorSchema),
  })
  .strict();

export const ProductivityConfigSchema = z
  .object({
    shortcutsEnabled: z.boolean(),
    togglePanelShortcut: ShortcutStringSchema,
    quickResetCameraShortcut: ShortcutStringSchema,
    cycleColorByShortcut: ShortcutStringSchema,
  })
  .strict();

const CREDENTIAL_FIELD_NAMES = new Set([
  'token',
  'pat',
  'personalAccessToken',
  'password',
  'secret',
  'authorization',
  'cookie',
  'sessionid',
  'csrftoken',
]);

export const EnhancerConfigSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    enabledFeatures: z.record(SafeIdentifierSchema, z.boolean()),
    appearance: AppearanceConfigSchema,
    visualization3d: Visualization3DConfigSchema,
    annotation: AnnotationToolsConfigSchema,
    productivity: ProductivityConfigSchema,
  })
  .strict();

export const PartialEnhancerConfigSchema = z
  .object({
    schemaVersion: z.number().int().positive().optional(),
    enabledFeatures: z.record(SafeIdentifierSchema, z.boolean()).optional(),
    appearance: AppearanceConfigSchema.partial().strict().optional(),
    visualization3d: Visualization3DConfigSchema.partial().strict().optional(),
    annotation: AnnotationToolsConfigSchema.partial().strict().optional(),
    productivity: ProductivityConfigSchema.partial().strict().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    for (const key of Object.keys(val)) {
      if (CREDENTIAL_FIELD_NAMES.has(key.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Credentials or secret fields ("${key}") are strictly prohibited in configuration objects.`,
        });
      }
    }
  });

export const PresetDefinitionSchema = z
  .object({
    id: SafeIdentifierSchema,
    name: z
      .string()
      .min(1)
      .max(60)
      .refine((v) => !/[<>]/.test(v), 'Preset name cannot contain HTML brackets'),
    description: z
      .string()
      .max(200)
      .refine((v) => !/[<>]/.test(v), 'Preset description cannot contain HTML brackets'),
    builtIn: z.boolean().optional(),
    config: PartialEnhancerConfigSchema,
  })
  .strict();

export const BridgeCommandSchema = z.enum(BRIDGE_COMMANDS);

export const CameraActionPayloadSchema = z
  .object({
    action: z.enum(CAMERA_PRESET_ACTIONS),
  })
  .strict();

export const ApplyCanvasVisualConfigPayloadSchema = z
  .object({
    shapeOpacity: z.number().int().min(0).max(100).optional(),
    selectedShapeOpacity: z.number().int().min(0).max(100).optional(),
    outlinedBorders: z.boolean().optional(),
    outlineColor: HexColorSchema.optional(),
    orientationVisibility: CuboidOrientationVisibilitySchema.optional(),
    colorBy: CuboidColorBySchema.optional(),
    controlPointsSize: z.number().min(1).max(20).optional(),
    focusedObjectPadding: z.number().min(0).max(200).optional(),
    canvasBackgroundColor: HexColorSchema.optional(),
    pointCloudCssBrightness: z.number().int().min(50).max(180).optional(),
    pointCloudCssContrast: z.number().int().min(50).max(180).optional(),
    whiteBackground: z.boolean().optional(),
    enableScattering: z.boolean().optional(),
    colorPointsByCuboid: z.boolean().optional(),
  })
  .strict();

export const SetCanvasBackgroundPayloadSchema = z
  .object({
    color: HexColorSchema,
  })
  .strict();

export const BridgeRequestEnvelopeSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    direction: z.literal('CONTENT_TO_PAGE'),
    requestId: z.string().min(8).max(64).regex(/^[a-zA-Z0-9_-]+$/),
    sessionToken: z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/),
    command: BridgeCommandSchema,
    timestamp: z.number().int().positive(),
    payload: z.unknown(),
  })
  .strict();

export const BridgeResponseEnvelopeSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    direction: z.literal('PAGE_TO_CONTENT'),
    requestId: z.string().min(8).max(64).regex(/^[a-zA-Z0-9_-]+$/),
    sessionToken: z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/),
    ok: z.boolean(),
    timestamp: z.number().int().positive(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(300),
      })
      .strict()
      .optional(),
  })
  .strict();

export const CvatUserApiResponseSchema = z
  .object({
    id: z.number().int().nonnegative(),
    username: z.string().min(1).max(150),
    email: z.string().optional(),
    is_staff: z.boolean().optional(),
  })
  .passthrough();
