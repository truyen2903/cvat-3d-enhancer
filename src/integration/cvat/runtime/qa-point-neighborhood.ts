export const DEFAULT_QA_POINT_CHUNK_SIZE = 65536;

/** Match the QA scanner's broad-phase bounds while yielding between chunks. */
export async function collectQaPointNeighborhood(
  positions: Float32Array | number[],
  points: readonly number[],
  isCurrent: () => boolean,
  yieldTask: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
  chunkPoints = DEFAULT_QA_POINT_CHUNK_SIZE
): Promise<number[] | null> {
  if (points.length < 9) {
    return null;
  }
  for (let k = 0; k < 9; k += 1) {
    if (!Number.isFinite(points[k])) {
      return null;
    }
  }

  const cx = points[0]!;
  const cy = points[1]!;
  const cz = points[2]!;
  const span = Math.hypot(points[6]! / 2 + 1.4, points[7]! / 2 + 1.4, points[8]! / 2 + 1);
  const minX = cx - span;
  const maxX = cx + span;
  const minY = cy - span;
  const maxY = cy + span;
  const minZ = cz - span;
  const maxZ = cz + span;

  const selected: number[] = [];
  const totalFloats = positions.length;
  const safeChunkPoints = Number.isNaN(chunkPoints)
    ? DEFAULT_QA_POINT_CHUNK_SIZE
    : Math.max(1, Math.floor(chunkPoints));
  const step = safeChunkPoints * 3;

  for (let start = 0; start < totalFloats; start += step) {
    if (!isCurrent()) {
      return null;
    }
    const end = Math.min(totalFloats, start + step);
    for (let i = start; i < end; i += 3) {
      const x = positions[i] ?? 0;
      if (x >= minX && x <= maxX) {
        const y = positions[i + 1] ?? 0;
        if (y >= minY && y <= maxY) {
          const z = positions[i + 2] ?? 0;
          if (z >= minZ && z <= maxZ) {
            selected.push(x, y, z);
          }
        }
      }
    }
    if (end < totalFloats) {
      await yieldTask();
    }
  }

  if (!isCurrent()) {
    return null;
  }
  // Distinguish an existing scan with zero nearby points from a missing scan.
  return selected.length > 0 ? selected : [Infinity, Infinity, Infinity];
}
