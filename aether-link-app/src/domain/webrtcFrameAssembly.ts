export interface RemoteTileFrame {
  tiles: unknown[];
  width: number;
  height: number;
  sequence?: number;
  keyframe?: boolean;
  // Includes the OS intentionally hiding its cursor; do not invent a local arrow.
  cursorEmbedded?: boolean;
}

export function hasCompleteTileCoverage(width: number, height: number, tiles: unknown[]): boolean {
  const cells = countNonOverlappingTileCells(width, height, tiles);
  return cells > 0 && cells === Math.ceil(width / 32) * Math.ceil(height / 32);
}

export function hasNonOverlappingTileCoverage(width: number, height: number, tiles: unknown[]): boolean {
  return countNonOverlappingTileCells(width, height, tiles) > 0;
}

function countNonOverlappingTileCells(width: number, height: number, tiles: unknown[]): number {
  if (!isDimension(width) || !isDimension(height)) return 0;
  const cols = Math.ceil(width / 32), rows = Math.ceil(height / 32);
  if (!tiles.length || tiles.length > cols * rows) return 0;
  const covered = new Uint8Array(cols * rows);
  let count = 0;
  for (const value of tiles) {
    if (!value || typeof value !== "object") return 0;
    const {x,y,w,h} = value as {x:number;y:number;w:number;h:number};
    if (![x,y,w,h].every(Number.isSafeInteger) || x < 0 || y < 0 || w <= 0 || h <= 0) return 0;
    const right = x * 32 + w, bottom = y * 32 + h;
    if (right > width || bottom > height || (right !== width && right % 32 !== 0) || (bottom !== height && bottom % 32 !== 0)) return 0;
    for (let row = y; row < Math.ceil(bottom / 32); row++) {
      for (let col = x; col < Math.ceil(right / 32); col++) {
        const index = row * cols + col;
        if (covered[index]) return 0;
        covered[index] = 1; count++;
      }
    }
  }
  return count;
}

interface PendingFrame {
  chunks: Map<number, unknown[]>;
  startedAt: number;
  chunkCount: number;
  width: number;
  height: number;
  keyframe: boolean;
  cursorEmbedded?: boolean;
}

const MAX_FRAME_CHUNKS = 4_096;
const MAX_PENDING_FRAMES = 8;
const MAX_PENDING_FRAME_AGE_MS = 5_000;

export class WebRtcFrameAssembler {
  private readonly pending = new Map<number, PendingFrame>();
  private readonly completedBeforeKeyframe = new Map<number, RemoteTileFrame>();
  private initialKeyframeDelivered = false;
  private keyframeSequence = -1;

  push(payload: unknown): RemoteTileFrame[] {
    const parsed = parseFrameObject(payload);
    if (!parsed) {
      return [];
    }

    if (!hasChunkMetadata(parsed)) {
      const legacyFrame = toLegacyFrame(parsed);
      if (!legacyFrame) {
        return [];
      }
      return [legacyFrame];
    }

    const chunk = validateChunk(parsed);
    if (!chunk || chunk.sequence <= this.keyframeSequence) {
      return [];
    }

    const now = this.pending.size > 0 || chunk.frameChunkCount > 1 ? performance.now() : 0;
    if (this.pending.size > 0) {
      for (const [sequence, partial] of this.pending) {
        if (now - partial.startedAt < MAX_PENDING_FRAME_AGE_MS) break;
        this.pending.delete(sequence);
      }
    }

    let pending = this.pending.get(chunk.sequence);
    let tiles: unknown[];
    if (!pending && chunk.frameChunkCount === 1) {
      // A complete packet must not evict a picture still waiting for a fragment.
      tiles = typeof payload === "string" ? chunk.tiles : [chunk.tiles].flat();
    } else {
      if (!pending) {
        pending = {
          chunks: new Map(),
          startedAt: now,
          chunkCount: chunk.frameChunkCount,
          width: chunk.width,
          height: chunk.height,
          keyframe: chunk.keyframe,
          ...(typeof chunk.cursorEmbedded === "boolean" ? { cursorEmbedded: chunk.cursorEmbedded } : {}),
        };
        this.pending.set(chunk.sequence, pending);
        trimOldest(this.pending, MAX_PENDING_FRAMES);
      } else if (
        pending.chunkCount !== chunk.frameChunkCount ||
        pending.width !== chunk.width ||
        pending.height !== chunk.height ||
        pending.keyframe !== chunk.keyframe ||
        pending.cursorEmbedded !== chunk.cursorEmbedded
      ) {
        this.pending.delete(chunk.sequence);
        return [];
      }
      if (!pending.chunks.has(chunk.frameChunkIndex)) {
        pending.chunks.set(chunk.frameChunkIndex, chunk.tiles);
      }
      if (pending.chunks.size !== pending.chunkCount) return [];
      this.pending.delete(chunk.sequence);
      const chunks = pending.chunks;
      tiles = Array.from({ length: pending.chunkCount }, (_, index) => chunks.get(index) ?? []).flat();
    }

    const frame: RemoteTileFrame = {
      tiles,
      width: chunk.width,
      height: chunk.height,
      sequence: chunk.sequence,
      keyframe: chunk.keyframe,
      ...(typeof chunk.cursorEmbedded === "boolean" ? { cursorEmbedded: chunk.cursorEmbedded } : {}),
    };

    if (!this.initialKeyframeDelivered && !frame.keyframe) {
      this.completedBeforeKeyframe.set(chunk.sequence, frame);
      trimOldest(this.completedBeforeKeyframe, MAX_PENDING_FRAMES);
      return [];
    }

    if (frame.keyframe && !this.initialKeyframeDelivered) {
      this.initialKeyframeDelivered = true;
      const queued = [...this.completedBeforeKeyframe.values()]
        .filter((candidate) => (candidate.sequence ?? -1) > chunk.sequence)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
      this.completedBeforeKeyframe.clear();
      const released = [frame, ...queued];
      this.keyframeSequence = chunk.sequence;
      for (const sequence of this.pending.keys()) {
        if (sequence <= this.keyframeSequence) this.pending.delete(sequence);
      }
      return released;
    }

    return [frame];
  }
}

function parseFrameObject(payload: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasChunkMetadata(value: Record<string, unknown>): boolean {
  return value.frameChunkIndex !== undefined || value.frameChunkCount !== undefined || value.keyframe !== undefined;
}

function toLegacyFrame(value: Record<string, unknown>): RemoteTileFrame | null {
  if (!Array.isArray(value.tiles) || !isDimension(value.width) || !isDimension(value.height)) {
    return null;
  }
  const sequence = finiteInteger(value.sequence);
  return {
    tiles: value.tiles,
    width: Number(value.width),
    height: Number(value.height),
    ...(sequence === null ? {} : { sequence }),
    ...(typeof value.cursorEmbedded === "boolean" ? {cursorEmbedded:value.cursorEmbedded} : {}),
  };
}

function validateChunk(value: Record<string, unknown>): (RemoteTileFrame & {
  sequence: number;
  keyframe: boolean;
  frameChunkIndex: number;
  frameChunkCount: number;
}) | null {
  const sequence = finiteInteger(value.sequence);
  const frameChunkIndex = finiteInteger(value.frameChunkIndex);
  const frameChunkCount = finiteInteger(value.frameChunkCount);
  if (
    !Array.isArray(value.tiles) ||
    !isDimension(value.width) ||
    !isDimension(value.height) ||
    sequence === null || sequence < 0 ||
    frameChunkIndex === null || frameChunkIndex < 0 ||
    frameChunkCount === null || frameChunkCount < 1 || frameChunkCount > MAX_FRAME_CHUNKS ||
    frameChunkIndex >= frameChunkCount ||
    typeof value.keyframe !== "boolean" ||
    (value.cursorEmbedded !== undefined && typeof value.cursorEmbedded !== "boolean")
  ) {
    return null;
  }
  return {
    tiles: value.tiles,
    width: Number(value.width),
    height: Number(value.height),
    sequence,
    keyframe: value.keyframe,
    ...(typeof value.cursorEmbedded === "boolean" ? {cursorEmbedded:value.cursorEmbedded} : {}),
    frameChunkIndex,
    frameChunkCount,
  };
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function isDimension(value: unknown): boolean {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 32_768;
}

function trimOldest<T>(map: Map<number, T>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}
