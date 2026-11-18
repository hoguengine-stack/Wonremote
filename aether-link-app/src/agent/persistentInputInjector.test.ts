import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersistentInputInjector,
  type InputServerChild,
  type SpawnInputServer,
} from "./persistentInputInjector";

afterEach(() => {
  vi.useRealTimers();
});

describe("persistent Agent input injector", () => {
  it("reuses one hidden brokered input-server client and writes unique JSONL request IDs", async () => {
    const child = new FakeInputServerChild((request) => {
      child.respond({ id: request.id, ok: true });
    });
    const spawnInputServer = vi.fn<SpawnInputServer>(
      () => child as unknown as InputServerChild,
    );
    const injector = new PersistentInputInjector("C:\\WonRemote\\wonremote-poc.exe", { spawnInputServer });

    const owner = {};
    injector.prepare(owner);
    injector.prepare(owner);
    expect(spawnInputServer).toHaveBeenCalledOnce();
    expect(child.requests).toEqual([]);
    await injector.inject("key-down A");
    await injector.inject("key-up A");

    expect(spawnInputServer).toHaveBeenCalledOnce();
    expect(spawnInputServer).toHaveBeenCalledWith(
      "C:\\WonRemote\\wonremote-poc.exe",
      ["--mode", "input-server"],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    expect(spawnInputServer.mock.calls[0][1]).not.toContain("inject-input");
    expect(child.requests).toEqual([
      { id: "input-1", action: "key-down A" },
      { id: "input-2", action: "key-up A" },
    ]);
    injector.close();
  });

  it("starts on demand if preparation could not launch or its idle child exited", async () => {
    const idleChild = new FakeInputServerChild();
    const liveChild = new FakeInputServerChild(request => liveChild.respond({id:request.id,ok:true}));
    const spawnInputServer = vi.fn<SpawnInputServer>(() => liveChild as unknown as InputServerChild)
      .mockImplementationOnce(() => { throw new Error("startup unavailable"); })
      .mockReturnValueOnce(idleChild as unknown as InputServerChild);
    const injector = new PersistentInputInjector("poc.exe", {spawnInputServer});

    const owner = {};
    expect(() => injector.prepare(owner)).toThrow("startup unavailable");
    const failed = vi.fn();
    injector.prepare(owner, failed);
    idleChild.emit("exit",1,null);
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message:expect.stringContaining("exited")}));
    expect(idleChild.requests).toEqual([]);
    await injector.inject("move 1 2");
    expect(liveChild.requests).toEqual([{id:"input-1",action:"move 1 2"}]);
    expect(spawnInputServer).toHaveBeenCalledTimes(3);
    injector.close();
  });

  it("cleans up only an unused preparation without interrupting a used input child", async () => {
    const unused = new FakeInputServerChild();
    const used = new FakeInputServerChild(request => used.respond({id:request.id,ok:true}));
    const spawnInputServer = vi.fn<SpawnInputServer>(() => used as unknown as InputServerChild)
      .mockReturnValueOnce(unused as unknown as InputServerChild);
    const injector = new PersistentInputInjector("poc.exe", {spawnInputServer});
    const failed = vi.fn();
    const first = {}, replacement = {};
    injector.prepare(first, failed);
    injector.prepare(replacement, failed);
    injector.discardPreparation(first);
    expect(unused.kill).not.toHaveBeenCalled();
    injector.discardPreparation(replacement);
    injector.discardPreparation(replacement);
    expect(unused.kill).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    injector.prepare(replacement, failed);
    await injector.inject("mouse-down 1 2 left");
    injector.prepare(replacement, failed);
    injector.discardPreparation(replacement);
    expect(used.kill).not.toHaveBeenCalled();
    await injector.inject("mouse-up 1 2 left");
    expect(used.requests.map(request=>request.action)).toEqual(["mouse-down 1 2 left","mouse-up 1 2 left"]);
    injector.close();
  });

  it.each([false,true])("keeps a modeled helper startup off the first-action wait when prepared: %s", async prepared => {
    vi.useFakeTimers();
    const spawnInputServer: SpawnInputServer = () => {
      const readyAt = Date.now() + 40;
      const child = new FakeInputServerChild(request => {
        setTimeout(() => child.respond({id:request.id,ok:true}), Math.max(0, readyAt - Date.now()));
      });
      return child as unknown as InputServerChild;
    };
    const injector = new PersistentInputInjector("poc.exe", {spawnInputServer});
    try {
      if (prepared) {
        injector.prepare({});
        await vi.advanceTimersByTimeAsync(40);
      }
      const start = Date.now();
      const elapsed = injector.inject("move 1 2").then(() => Date.now() - start);
      await vi.advanceTimersByTimeAsync(40);
      await expect(elapsed).resolves.toBe(prepared ? 0 : 40);
    } finally { injector.close(); }
  });

  it("matches responses by id and ignores unrelated response IDs", async () => {
    const child = new FakeInputServerChild();
    const injector = new PersistentInputInjector("poc.exe", {
      spawnInputServer: () => child as unknown as InputServerChild,
    });
    let settled = false;
    const request = injector.inject("move 1 2").then(() => {
      settled = true;
    });
    const requestId = child.requests[0].id;

    child.respond({ id: "unrelated", ok: true });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.respond({ id: requestId, ok: true });
    await request;
    expect(settled).toBe(true);
    injector.close();
  });

  it("rejects an action error while keeping the same child for the next request", async () => {
    let responseCount = 0;
    const child = new FakeInputServerChild((request) => {
      responseCount += 1;
      child.respond(responseCount === 1
        ? { id: request.id, ok: false, error: "input rejected" }
        : { id: request.id, ok: true });
    });
    const spawnInputServer = vi.fn(() => child as unknown as InputServerChild);
    const injector = new PersistentInputInjector("poc.exe", { spawnInputServer });

    await expect(injector.inject("system taskmgr")).rejects.toThrow("input rejected");
    await expect(injector.inject("key-up A")).resolves.toBeUndefined();
    expect(spawnInputServer).toHaveBeenCalledOnce();
    injector.close();
  });

  it("times out pending input, kills the ambiguous child, and restarts on the next command", async () => {
    vi.useFakeTimers();
    const firstChild = new FakeInputServerChild();
    const secondChild = new FakeInputServerChild((request) => {
      secondChild.respond({ id: request.id, ok: true });
    });
    const children = [firstChild, secondChild];
    const spawnInputServer = vi.fn(() => children.shift() as unknown as InputServerChild);
    const injector = new PersistentInputInjector("poc.exe", { requestTimeoutMs: 20, spawnInputServer });

    const timedOut = expect(injector.inject("key-down A")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await timedOut;
    expect(firstChild.kill).toHaveBeenCalledOnce();

    await expect(injector.inject("key-up A")).resolves.toBeUndefined();
    expect(spawnInputServer).toHaveBeenCalledTimes(2);
    injector.close();
  });

  it("rejects pending input on a pipe error and starts a new child later", async () => {
    const firstChild = new FakeInputServerChild();
    const secondChild = new FakeInputServerChild((request) => {
      secondChild.respond({ id: request.id, ok: true });
    });
    const children = [firstChild, secondChild];
    const spawnInputServer = vi.fn(() => children.shift() as unknown as InputServerChild);
    const injector = new PersistentInputInjector("poc.exe", { spawnInputServer });

    const failed = expect(injector.inject("key-down A")).rejects.toThrow("broken pipe");
    firstChild.stdin.emit("error", new Error("broken pipe"));
    await failed;
    expect(firstChild.kill).toHaveBeenCalledOnce();

    await expect(injector.inject("key-up A")).resolves.toBeUndefined();
    expect(spawnInputServer).toHaveBeenCalledTimes(2);
    injector.close();
  });

  it("rejects all pending requests after a crash and restarts once on the next command", async () => {
    const firstChild = new FakeInputServerChild();
    const secondChild = new FakeInputServerChild((request) => {
      secondChild.respond({ id: request.id, ok: true });
    });
    const children = [firstChild, secondChild];
    const spawnInputServer: SpawnInputServer = vi.fn(() => children.shift() as unknown as InputServerChild);
    const injector = new PersistentInputInjector("poc.exe", { spawnInputServer });

    const first = expect(injector.inject("key-down A")).rejects.toThrow("exited");
    const second = expect(injector.inject("move 1 2")).rejects.toThrow("exited");
    firstChild.emit("exit", 1, null);
    await Promise.all([first, second]);

    await expect(injector.inject("key-up A")).resolves.toBeUndefined();
    expect(spawnInputServer).toHaveBeenCalledTimes(2);
    injector.close();
  });
});

type InputRequest = { id: string; action: string };
type InputResponse = { id: string; ok: boolean; error?: string };

class FakeInputServerChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly requests: InputRequest[] = [];
  readonly kill = vi.fn(() => true);
  private stdinBuffer = "";

  constructor(private readonly onRequest?: (request: InputRequest) => void) {
    super();
    this.stdin.on("data", (chunk) => {
      this.stdinBuffer += chunk.toString("utf8");
      let newlineIndex = this.stdinBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stdinBuffer.slice(0, newlineIndex);
        this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
        const request = JSON.parse(line) as InputRequest;
        this.requests.push(request);
        this.onRequest?.(request);
        newlineIndex = this.stdinBuffer.indexOf("\n");
      }
    });
  }

  respond(response: InputResponse): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
