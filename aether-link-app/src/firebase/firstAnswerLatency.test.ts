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
    peer.onicecandidate?.(event); peer.onicecandidate?.(event);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledExactlyOnceWith(answer));
    expect(done).toBe(false); expect(candidateWriter).toHaveBeenCalledTimes(2);
    finish(); await pending;
    expect(publish).toHaveBeenCalledTimes(1); expect(peer.onicecandidate).toBe(candidateWriter);
  });
  it("falls back after gathering for runtimes with no candidate events", async () => {
    const { peer, answer, finish } = fixture(); const publish = vi.fn(async () => undefined);
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => true);
    expect(publish).not.toHaveBeenCalled(); finish(); await pending;
    expect(publish).toHaveBeenCalledExactlyOnceWith(answer);
  });
  it("does not publish a stale negotiation and keeps gathering intact", async () => {
    const { peer, answer, finish } = fixture(); let current = true;
    const publish = vi.fn(async () => undefined);
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => current);
    peer.onicecandidate?.({candidate: null}); current = false;
    finish(); await pending; expect(publish).not.toHaveBeenCalled();
  });
  it("propagates publication failure and restores candidate handling", async () => {
    const { peer, answer, finish, candidateWriter } = fixture();
    const publish = vi.fn(async () => { throw new Error("denied"); });
    const pending = publishAnswerDuringGathering(peer, answer, publish, () => true);
    peer.onicecandidate?.({candidate: null}); await Promise.resolve(); finish();
    await expect(pending).rejects.toThrow("denied"); expect(peer.onicecandidate).toBe(candidateWriter);
  });
});
