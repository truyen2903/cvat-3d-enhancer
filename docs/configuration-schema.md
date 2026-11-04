# Configuration Schema & Hierarchy — CVAT 3D Enhancer

## 1. Precedence Hierarchy

Configuration is resolved deterministically using partial merging across four layers:

```text
System Defaults
    ↓
Global Configuration       (cvat-enhancer:global)
    ↓
Project Configuration      (cvat-enhancer:project:{projectId})
    ↓
Task Configuration         (cvat-enhancer:task:{taskId})
```

**Effective Precedence**: `Task > Project > Global > System Defaults`.

Presets are stored under `cvat-enhancer:presets`.

## 2. Schema Version & Migration

- **Current Schema Version**: `schemaVersion: 2` (`CURRENT_SCHEMA_VERSION`).
- **Migration Support**: `migratePartialConfig()` automatically migrates legacy `schemaVersion: 1` payloads (mapping `appearance.backgroundColor` to `appearance.canvasBackgroundColor`) before validating against `PartialEnhancerConfigSchema`.

## 3. Security Validation Rules (Zod)

All configuration objects and JSON imports/exports are validated with strict Zod schemas (`src/shared/schemas/index.ts`):

- **No Unknown Keys**: `.strict()` is enforced on all configuration sub-schemas.
- **No Credential Fields**: `PartialEnhancerConfigSchema` explicitly rejects keys matching `token`, `pat`, `personalAccessToken`, `password`, `secret`, `authorization`, `cookie`, `sessionid`, or `csrftoken`.
- **No Prototype Pollution**: `safeJsonParse` and `assertNoPrototypePollution` reject `__proto__`, `constructor`, and `prototype` keys at any nesting depth.
- **Strict Value Constraints**:
  - Colors must match `/^#[0-9a-fA-F]{6}$/`.
  - Opacities are bounded integers `0..100`.
  - Preset names and descriptions reject `<` and `>` characters.
  - JSON import size is capped at 64 KB.
