import { describe, expect, it, vi } from "vitest";
import { publishAnswerDuringGathering, type AgentPeerConnectionLike } from "./agentPeerConnection";
function fixture() {
  let finish!: () => void;
  const gather = new Promise<void>(resolve => { finish = resolve; });
  const candidateWriter = vi.fn();
  const answer = { type: "answer", sdp: "v=0\r\na=candidate:host\r\n" };
  const peer = { localDescription: null, onicecandidate: candidateWriter,
    setLocalDescription: vi.fn(async () => { peer.localDescription = answer; await gather; }),
  } as unknown as AgentPeerConnectionLike;
  return { peer, answer, finish, candidateWriter };
}
describe("first answer critical path", () => {
  it("publishes once before gathering completes without dropping candidate writes", async () => {
    const { peer, answer, finish, candidateWriter } = fixture();
    const publish = vi.fn(async () => undefined);
    let done = false;
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => true).then(() => { done = true; });
    const event = { candidate: { toJSON: () => ({ candidate: "host" }) } };
    try {
      peer.onicecandidate?.(event); peer.onicecandidate?.(event);
      await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(answer));
      expect(done).toBe(false); expect(candidateWriter).toHaveBeenCalledTimes(2);
      expect(publish.mock.invocationCallOrder[0]).toBeLessThan(candidateWriter.mock.invocationCallOrder[0]);
    } finally { finish(); await pending; }
    expect(publish).toHaveBeenCalledTimes(1); expect(peer.onicecandidate).toBe(candidateWriter);
  });
  it("holds candidates emitted before usable SDP and flushes them without waiting for answer acknowledgement", async () => {
    const {peer,answer,finish,candidateWriter}=fixture();
    let acknowledge!: () => void;
    const acknowledgement=new Promise<void>(resolve=>{acknowledge=resolve;});
    const publish=vi.fn(()=>acknowledgement);
    const pending=publishAnswerDuringGathering(peer,answer,publish,()=>true);
    const early={candidate:{toJSON:()=>({candidate:"early"})}};
    const next={candidate:{toJSON:()=>({candidate:"next"})}};
    try {
      peer.localDescription=null;
      peer.onicecandidate?.(early);
      expect(candidateWriter).not.toHaveBeenCalled();
      peer.localDescription=answer;
      peer.onicecandidate?.(next);
      await vi.waitFor(()=>expect(candidateWriter.mock.calls).toEqual([[early],[next]]));
      expect(publish).toHaveBeenCalledExactlyOnceWith(answer);
      expect(publish.mock.invocationCallOrder[0]).toBeLessThan(candidateWriter.mock.invocationCallOrder[0]);
    } finally {
      acknowledge();
      finish();
      await pending;
    }
  });
  it("falls back after gathering for runtimes with no candidate events", async () => {
    const { peer, answer, finish } = fixture(); const publish = vi.fn(async () => undefined);
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => true);
    expect(publish).not.toHaveBeenCalled(); finish(); await pending;
    expect(publish).toHaveBeenCalledExactlyOnceWith(answer);
  });
  it("does not publish a stale negotiation and keeps gathering intact", async () => {
    const { peer, answer, finish, candidateWriter } = fixture(); let current = true;
    const publish = vi.fn(async () => undefined);
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => current);
    const event = {candidate:{toJSON:()=>({candidate:"former"})}};
    peer.onicecandidate?.(event); current = false;
    peer.onicecandidate?.(event);
    finish(); await pending;
    expect(publish).not.toHaveBeenCalled();
    expect(candidateWriter).not.toHaveBeenCalled();
  });
  it("propagates publication failure and drops subsequent candidates before gathering ends", async () => {
    const { peer, answer, finish, candidateWriter } = fixture();
    const publish = vi.fn(async () => { throw new Error("denied"); });
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => true);
    let error: unknown;
    const outcome = pending.catch(reason => { error = reason; });
    const emit = peer.onicecandidate;
    try {
      emit?.({candidate: null});
      await vi.waitFor(() => expect(error).toEqual(new Error("denied")), {timeout: 400});
      emit?.({candidate: { toJSON: () => ({ candidate: "late" }) }});
      peer.onicecandidate?.({candidate: { toJSON: () => ({ candidate: "also-late" }) }});
      expect(candidateWriter).toHaveBeenCalledExactlyOnceWith({candidate: null});
    } finally { finish(); await outcome; }
  });
});
