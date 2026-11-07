/** Match the QA scanner's broad-phase bounds while yielding between chunks. */
export async function collectQaPointNeighborhood(
  positions: Float32Array | number[],
  points: readonly number[],
  isCurrent: () => boolean,
  yieldTask: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
  chunkPoints = 8192
): Promise<number[] | null> {
  if (points.length < 9 || !points.slice(0, 9).every(Number.isFinite)) return null;
  const [cx, cy, cz] = points as readonly [number, number, number];
  const span = Math.hypot(points[6]! / 2 + 1.4, points[7]! / 2 + 1.4, points[8]! / 2 + 1);
  const selected: number[] = [];
  const step = Math.max(1, Math.floor(chunkPoints)) * 3;
  for (let start = 0; start < positions.length; start += step) {
    if (!isCurrent()) return null;
    const end = Math.min(positions.length, start + step);
    for (let i = start; i < end; i += 3) {
      const x = positions[i] ?? 0,
        y = positions[i + 1] ?? 0,
        z = positions[i + 2] ?? 0;
      if (Math.abs(x - cx) <= span && Math.abs(y - cy) <= span && Math.abs(z - cz) <= span) {
        selected.push(x, y, z);
      }
    }
    if (end < positions.length) await yieldTask();
  }
  if (!isCurrent()) return null;
  // Distinguish an existing scan with zero nearby points from a missing scan.
  return selected.length ? selected : [Infinity, Infinity, Infinity];
}
