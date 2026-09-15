import { describe, expect, it } from "vitest";
import { WebRtcFrameAssembler, hasCompleteTileCoverage } from "./webrtcFrameAssembly";

describe("full frame tile coverage", () => {
  it("accepts merged cells and clipped display edges", () => {
    expect(hasCompleteTileCoverage(65,33,[{x:0,y:0,w:64,h:32},{x:2,y:0,w:1,h:32},{x:0,y:1,w:65,h:1}])).toBe(true);
    expect(hasCompleteTileCoverage(64,64,[{x:0,y:0,w:64,h:64}])).toBe(true);
  });
  it("rejects missing, overlapping, malformed and out of bounds cells", () => {
    const left={x:0,y:0,w:32,h:32};
    for (const tiles of [[],[left],[left,left],[{...left,w:65}],[{...left,x:-1}],[{...left,w:16},{x:1,y:0,w:32,h:32}],[{...left,x:0.5}]]) {
      expect(hasCompleteTileCoverage(64,32,tiles)).toBe(false);
    }
    expect(hasCompleteTileCoverage(32769,32,[left])).toBe(false);
    expect(hasCompleteTileCoverage(0,32,[left])).toBe(false);
  });
});

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
