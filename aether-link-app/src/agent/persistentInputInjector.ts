import { spawn } from "node:child_process";

const DEFAULT_INPUT_TIMEOUT_MS = 5_000;
const MAX_INPUT_SERVER_RESPONSE_BYTES = 64 * 1024;

interface InputServerWritable {
  once(event: "error", listener: (error: Error) => void): unknown;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
}

interface InputServerReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface InputServerChild {
  stdin: InputServerWritable;
  stdout: InputServerReadable;
  kill(): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
}

export type SpawnInputServer = (
  executable: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "ignore"]; windowsHide: true },
) => InputServerChild;

export interface PersistentInputInjectorOptions {
  requestTimeoutMs?: number;
  spawnInputServer?: SpawnInputServer;
}

interface PendingInputRequest {
  reject: (error: Error) => void;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PersistentInputInjector {
  private child: InputServerChild | null = null;
  private readonly pending = new Map<string, PendingInputRequest>();
  private readonly requestTimeoutMs: number;
  private readonly spawnInputServer: SpawnInputServer;
  private nextRequestId = 0;
  private stdoutBuffer = "";

  constructor(
    private readonly executablePath: string,
    options: PersistentInputInjectorOptions = {},
  ) {
    this.requestTimeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS));
    this.spawnInputServer = options.spawnInputServer ?? defaultSpawnInputServer;
  }

  inject(action: string): Promise<void> {
    let child: InputServerChild;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.reject(toError(error, "Failed to start Agent input server."));
    }

    const id = `input-${++this.nextRequestId}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failChild(child, new Error(`Agent input server timed out for ${id}.`), true);
      }, this.requestTimeoutMs);
      this.pending.set(id, { reject, resolve, timer });

      try {
        child.stdin.write(`${JSON.stringify({ id, action })}\n`, (error) => {
          if (error) {
            this.failChild(child, toError(error, "Agent input server stdin write failed."), true);
          }
        });
      } catch (error) {
        this.failChild(child, toError(error, "Agent input server stdin write failed."), true);
      }
    });
  }

  close(reason = "Agent input server closed."): void {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    this.rejectAllPending(new Error(reason));
    if (child) {
      try {
        child.kill();
      } catch {
        // Process may already be gone.
      }
    }
  }

  private ensureChild(): InputServerChild {
    if (this.child) {
      return this.child;
    }

    const child = this.spawnInputServer(
      this.executablePath,
      ["--mode", "input-server"],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.child = child;
    this.stdoutBuffer = "";
    child.stdout.on("data", (chunk) => this.consumeStdout(child, chunk));
    child.stdout.once("error", (error) => this.failChild(child, error, true));
    child.stdin.once("error", (error) => this.failChild(child, error, true));
    child.once("error", (error) => this.failChild(child, error, false));
    child.once("exit", (code, signal) => {
      this.failChild(
        child,
        new Error(`Agent input server exited (code=${code ?? "none"}, signal=${signal ?? "none"}).`),
        false,
      );
    });
    return child;
  }

  private consumeStdout(child: InputServerChild, chunk: Buffer | string): void {
    if (this.child !== child) {
      return;
    }
    this.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_INPUT_SERVER_RESPONSE_BYTES) {
      this.failChild(child, new Error("Agent input server response exceeded the JSONL limit."), true);
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0 && this.child === child) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleResponseLine(child, line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponseLine(child: InputServerChild, line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.failChild(child, new Error("Agent input server emitted malformed JSONL."), true);
      return;
    }
    if (!isInputServerResponse(response)) {
      this.failChild(child, new Error("Agent input server emitted an invalid response."), true);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve();
    } else {
      pending.reject(new Error(response.error || `Agent input action ${response.id} failed.`));
    }
  }

  private failChild(child: InputServerChild, error: Error, terminate: boolean): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.stdoutBuffer = "";
    this.rejectAllPending(error);
    if (terminate) {
      try {
        child.kill();
      } catch {
        // Process or pipe may already be closed.
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function defaultSpawnInputServer(
  executable: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "ignore"]; windowsHide: true },
): InputServerChild {
  return spawn(executable, args, options) as unknown as InputServerChild;
}

function isInputServerResponse(value: unknown): value is { id: string; ok: boolean; error?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    (!("error" in value) || typeof value.error === "string")
  );
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
