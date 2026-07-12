import { describe, expect, it } from "vitest";
import { WebRtcFrameAssembler } from "./webrtcFrameAssembly";

describe("WebRTC frame assembly", () => {
  it("waits for every initial keyframe chunk and then releases queued deltas in sequence order", () => {
    const assembler = new WebRtcFrameAssembler();

    expect(assembler.push(JSON.stringify({
      tiles: [{ id: "delta" }],
      width: 100,
      height: 60,
      sequence: 2,
      keyframe: false,
      frameChunkIndex: 0,
      frameChunkCount: 1,
    }))).toEqual([]);
    expect(assembler.push(JSON.stringify({
      tiles: [{ id: "key-b" }],
      width: 100,
      height: 60,
      sequence: 1,
      keyframe: true,
      frameChunkIndex: 1,
      frameChunkCount: 2,
    }))).toEqual([]);

    expect(assembler.push(JSON.stringify({
      tiles: [{ id: "key-a" }],
      width: 100,
      height: 60,
      sequence: 1,
      keyframe: true,
      frameChunkIndex: 0,
      frameChunkCount: 2,
    }))).toEqual([
      {
        tiles: [{ id: "key-a" }, { id: "key-b" }],
        width: 100,
        height: 60,
        sequence: 1,
        keyframe: true,
      },
      {
        tiles: [{ id: "delta" }],
        width: 100,
        height: 60,
        sequence: 2,
        keyframe: false,
      },
    ]);
  });

  it("keeps legacy unsplit frame messages compatible", () => {
    const assembler = new WebRtcFrameAssembler();

    expect(assembler.push(JSON.stringify({
      tiles: [{ id: "legacy" }],
      width: 80,
      height: 40,
      sequence: 7,
    }))).toEqual([{
      tiles: [{ id: "legacy" }],
      width: 80,
      height: 40,
      sequence: 7,
    }]);
  });

  it("keeps late delta frames because different sequences can contain different dirty cells", () => {
    const assembler = new WebRtcFrameAssembler();
    const chunk = (sequence: number, keyframe: boolean, id: string) => JSON.stringify({
      tiles: [{ id }],
      width: 100,
      height: 60,
      sequence,
      keyframe,
      frameChunkIndex: 0,
      frameChunkCount: 1,
    });

    expect(assembler.push(chunk(1, true, "key"))).toHaveLength(1);
    expect(assembler.push(chunk(3, false, "newer"))).toHaveLength(1);
    expect(assembler.push(chunk(2, false, "late-different-cell"))).toEqual([{
      tiles: [{ id: "late-different-cell" }],
      width: 100,
      height: 60,
      sequence: 2,
      keyframe: false,
    }]);
    expect(assembler.push(chunk(1, false, "older-than-keyframe"))).toEqual([]);
  });

  it("rejects malformed or inconsistent chunk metadata", () => {
    const assembler = new WebRtcFrameAssembler();

    expect(assembler.push("not-json")).toEqual([]);
    expect(assembler.push(JSON.stringify({
      tiles: [],
      width: 100,
      height: 60,
      sequence: 1,
      keyframe: true,
      frameChunkIndex: 2,
      frameChunkCount: 2,
    }))).toEqual([]);
  });
});
