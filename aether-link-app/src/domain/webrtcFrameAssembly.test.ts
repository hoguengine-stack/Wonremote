import { describe, expect, it, vi } from "vitest";
import { WebRtcFrameAssembler, hasCompleteTileCoverage, hasNonOverlappingTileCoverage } from "./webrtcFrameAssembly";

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
  it("allows gaps but rejects overlapping or unconvertible partial tile geometry", () => {
    const left = {x:0,y:0,w:32,h:32}, right = {...left,x:2};
    expect(hasNonOverlappingTileCoverage(96,32,[left,right])).toBe(true);
    expect(hasCompleteTileCoverage(96,32,[left,right])).toBe(false);
    expect(hasNonOverlappingTileCoverage(96,32,[left,right,right])).toBe(false);
    expect(hasNonOverlappingTileCoverage(96,32,[left,{...right,x:{valueOf:null,toString:null}}])).toBe(false);
  });
});

describe("WebRTC frame assembly", () => {
  it("preserves actual cursor mode through out-of-order chunks and legacy frames", () => {
    const assembler = new WebRtcFrameAssembler();
    const frame={tiles:[{id:1}],width:64,height:32,sequence:1,keyframe:true,frameChunkCount:2,cursorEmbedded:true};
    expect(assembler.push({...frame,frameChunkIndex:1})).toEqual([]);
    expect(assembler.push({...frame,frameChunkIndex:0})[0]).toMatchObject({cursorEmbedded:true,tiles:[{id:1},{id:1}]});
    expect(assembler.push({tiles:[],width:64,height:32,cursorEmbedded:false})[0].cursorEmbedded).toBe(false);
    expect(assembler.push({tiles:[],width:64,height:32,cursorEmbedded:'true'})[0].cursorEmbedded).toBeUndefined();
    expect(assembler.push({tiles:[],width:64,height:32})[0].cursorEmbedded).toBeUndefined();
  });

  it("rejects mixed or malformed cursor mode instead of hiding a legacy pointer", () => {
    const assembler = new WebRtcFrameAssembler();
    const frame={tiles:[{id:1}],width:64,height:32,sequence:1,keyframe:true,frameChunkCount:2};
    expect(assembler.push({...frame,cursorEmbedded:true,frameChunkIndex:0})).toEqual([]);
    expect(assembler.push({...frame,cursorEmbedded:false,frameChunkIndex:1})).toEqual([]);
    expect(assembler.push({...frame,sequence:2,cursorEmbedded:'true',frameChunkIndex:0})).toEqual([]);
    expect(assembler.push({...frame,sequence:3,cursorEmbedded:true,frameChunkIndex:0})).toEqual([]);
    expect(assembler.push({...frame,sequence:3,frameChunkIndex:1})).toEqual([]);
    expect(assembler.push({...frame,sequence:4,frameChunkIndex:0})).toEqual([]);
    expect(assembler.push({...frame,sequence:4,frameChunkIndex:1})[0]).not.toHaveProperty('cursorEmbedded');
  });
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

  it("keeps earlier picture fragments when an already complete packet arrives at the pending limit", () => {
    const assembler = new WebRtcFrameAssembler();
    const packet = (sequence: number, frameChunkCount: number, frameChunkIndex: number, id: string) => JSON.stringify({
      tiles: [{ id }], width: 1920, height: 1080, sequence, keyframe: sequence === 1, frameChunkCount, frameChunkIndex,
    });
    expect(assembler.push(packet(1, 1, 0, "baseline"))).toHaveLength(1);
    for (let sequence = 2; sequence <= 9; sequence++) expect(assembler.push(packet(sequence, 2, 0, `first-${sequence}`))).toEqual([]);
    expect(assembler.push(packet(10, 1, 0, "ready"))[0].tiles).toEqual([{ id: "ready" }]);
    expect(assembler.push(packet(2, 2, 1, "last-2"))[0]?.tiles).toEqual([{ id: "first-2" }, { id: "last-2" }]);
    // Genuine incomplete frames still consume slots and evict the oldest on overflow.
    expect(assembler.push(packet(11, 2, 0, "first-11"))).toEqual([]);
    expect(assembler.push(packet(12, 2, 0, "first-12"))).toEqual([]);
    expect(assembler.push(packet(3, 2, 1, "last-3"))).toEqual([]);
  });

  it("does not bypass inconsistent packet metadata for a sequence already being assembled", () => {
    const assembler = new WebRtcFrameAssembler();
    const packet = { tiles: [{ id: "fixture" }], width: 64, height: 32, sequence: 1, keyframe: true };
    expect(assembler.push(JSON.stringify({ ...packet, frameChunkCount: 2, frameChunkIndex: 0 }))).toEqual([]);
    expect(assembler.push(JSON.stringify({ ...packet, frameChunkCount: 1, frameChunkIndex: 0 }))).toEqual([]);
    expect(assembler.push(JSON.stringify({ ...packet, frameChunkCount: 2, frameChunkIndex: 1 }))).toEqual([]);
  });

  it("expires abandoned fragments on incoming traffic without expiring a fresh frame", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const assembler = new WebRtcFrameAssembler();
      const packet = (sequence: number, frameChunkIndex: number, frameChunkCount = 2) =>
        JSON.stringify({ tiles: [{ sequence, frameChunkIndex }], width: 64, height: 32,
          sequence, frameChunkIndex, frameChunkCount, keyframe: sequence === 1 });
      expect(assembler.push(packet(1, 0, 1))).toHaveLength(1);
      expect(assembler.push(packet(2, 0))).toEqual([]);
      vi.advanceTimersByTime(4_999);
      expect(assembler.push(packet(3, 0))).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(assembler.push(packet(4, 0, 1))).toHaveLength(1);
      expect(assembler.push(packet(2, 1))).toEqual([]);
      expect(assembler.push(packet(3, 1))[0].tiles).toEqual([{ sequence: 3, frameChunkIndex: 0 }, { sequence: 3, frameChunkIndex: 1 }]);
    } finally { vi.useRealTimers(); }
  });

  it("releases incomplete storage already superseded by the first delivered keyframe", () => {
    const assembler = new WebRtcFrameAssembler();
    const packet = (sequence: number, frameChunkIndex: number, frameChunkCount = 2) =>
      JSON.stringify({ tiles: [{ sequence, frameChunkIndex }], width: 64, height: 32,
        sequence, frameChunkIndex, frameChunkCount, keyframe: sequence === 2 });
    expect(assembler.push(packet(1, 0))).toEqual([]);
    expect(assembler.push(packet(3, 0))).toEqual([]);
    expect(assembler.push(packet(2, 0, 1))).toHaveLength(1);
    // Verify retained tile storage, not just the pre-existing rejection of late sequence 1.
    expect([...Reflect.get(assembler, "pending").keys()]).toEqual([3]);
    expect(assembler.push(packet(1, 1))).toEqual([]);
    expect(assembler.push(packet(3, 1))).toHaveLength(1);
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
