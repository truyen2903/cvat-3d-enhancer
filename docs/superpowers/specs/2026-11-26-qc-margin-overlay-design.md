# QC margin overlay (lỗi P) — design

Approved in chat 2026-11-26. Size: small change.

## Intent
Annotators check error **P** (box too loose / too tight around its points) by eye. For the
**active** object only, draw two translucent shells around the CVAT cuboid so the distance
from box to point cloud is easy to judge. Z (ground contact) is explicitly out of scope.

## Goals
- Active object only, using CVAT's own cuboid `points` (`[cx,cy,cz,rx,ry,rz,L,W,H,…]`).
- Shown in the main 3D view and in Top / Side / Front.
- Per-label ratio: `vehicles` 5%, `two-wheels` 8%, `pedestrian` 10%. Other labels
  (`Animal`, `Obstacle`, …) draw nothing. Label match is case-insensitive.
- Outer shell = box dimensions × (1 + ratio); inner shell = × (1 − ratio). The band between
  box and outer shell is one colour, between box and inner shell another.
- Workspace toggles (group "Hiển thị") restored: master, main 3D, Top/Side/Front.
- Performance first: zero per-frame allocation, no point-cloud scan, redraw only when the
  box, label or camera changed.

## Non-goals
- Z check, automatic point counting, verdicts, text warnings (old HUD stays removed).
- Writing anything to CVAT annotations; touching WebGL buffers.

## Approaches
1. **2D canvas overlay projected from camera matrices (chosen).** Same technique as
   `TrackGhostOverlay`: 16 corners projected per redraw, hull fills. Cheap, no scene changes.
2. Three.js meshes added to each view's scene. True volume, but per-scene lifecycle, depth
   sorting with the point cloud, and cost on every WebGL frame.
3. SVG polygons (like `CuboidBaseGuide`). Works, but DOM attribute churn per frame.

## My calls (not user-confirmed)
- Superseded 2026-11-26 by user: padding applies on **every side**, each face offset by ratio × that axis' size (half-extent × (0.5 ± ratio)).
- New options default to enabled, like other Workspace features.
