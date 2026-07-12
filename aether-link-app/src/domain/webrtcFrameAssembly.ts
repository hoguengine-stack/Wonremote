export interface RemoteTileFrame {
  tiles: unknown[];
  width: number;
  height: number;
  sequence?: number;
  keyframe?: boolean;
}

interface PendingFrame {
  chunks: Map<number, unknown[]>;
  chunkCount: number;
  width: number;
  height: number;
  sequence: number;
  keyframe: boolean;
}

const MAX_FRAME_CHUNKS = 4_096;
const MAX_PENDING_FRAMES = 8;

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

    let pending = this.pending.get(chunk.sequence);
    if (!pending) {
      pending = {
        chunks: new Map(),
        chunkCount: chunk.frameChunkCount,
        width: chunk.width,
        height: chunk.height,
        sequence: chunk.sequence,
        keyframe: chunk.keyframe,
      };
      this.pending.set(chunk.sequence, pending);
      trimOldest(this.pending, MAX_PENDING_FRAMES);
    } else if (
      pending.chunkCount !== chunk.frameChunkCount ||
      pending.width !== chunk.width ||
      pending.height !== chunk.height ||
      pending.keyframe !== chunk.keyframe
    ) {
      this.pending.delete(chunk.sequence);
      return [];
    }

    if (!pending.chunks.has(chunk.frameChunkIndex)) {
      pending.chunks.set(chunk.frameChunkIndex, chunk.tiles);
    }
    if (pending.chunks.size !== pending.chunkCount) {
      return [];
    }

    this.pending.delete(chunk.sequence);
    const frame: RemoteTileFrame = {
      tiles: Array.from({ length: pending.chunkCount }, (_, index) => pending.chunks.get(index) ?? []).flat(),
      width: pending.width,
      height: pending.height,
      sequence: pending.sequence,
      keyframe: pending.keyframe,
    };

    if (!this.initialKeyframeDelivered && !frame.keyframe) {
      this.completedBeforeKeyframe.set(pending.sequence, frame);
      trimOldest(this.completedBeforeKeyframe, MAX_PENDING_FRAMES);
      return [];
    }

    if (frame.keyframe && !this.initialKeyframeDelivered) {
      this.initialKeyframeDelivered = true;
      const queued = [...this.completedBeforeKeyframe.values()]
        .filter((candidate) => (candidate.sequence ?? -1) > pending.sequence)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
      this.completedBeforeKeyframe.clear();
      const released = [frame, ...queued];
      this.keyframeSequence = pending.sequence;
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
  };
}

function validateChunk(value: Record<string, unknown>): (Required<RemoteTileFrame> & {
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
    typeof value.keyframe !== "boolean"
  ) {
    return null;
  }
  return {
    tiles: value.tiles,
    width: Number(value.width),
    height: Number(value.height),
    sequence,
    keyframe: value.keyframe,
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
