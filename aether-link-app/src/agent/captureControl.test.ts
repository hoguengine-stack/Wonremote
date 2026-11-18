import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { observeCaptureControlErrors, writeCaptureControl } from "./captureControl";

class EpipeWritable extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    callback(error);
  }
}

describe("capture control input", () => {
  it("contains asynchronous EPIPE failures instead of leaving an unhandled stream error", async () => {
    const input = new EpipeWritable();
    const failures: Error[] = [];
    let written = false;
    const stopObserving = observeCaptureControlErrors(input, (error) => failures.push(error));

    expect(writeCaptureControl(input, "request-keyframe\n", (error) => failures.push(error), () => { written = true; })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(failures.some((error) => (error as NodeJS.ErrnoException).code === "EPIPE")).toBe(true);
    expect(written).toBe(false);
    stopObserving();
  });

  it("reports written only after the underlying write completes", async () => {
    let complete!: () => void;
    const input = new Writable({write(_chunk,_encoding,done) { complete = done; }});
    let written = false;
    expect(writeCaptureControl(input, "request-keyframe\n", () => {}, () => { written = true; })).toBe(true);
    expect(written).toBe(false);
    complete();
    await new Promise(resolve => setImmediate(resolve));
    expect(written).toBe(true);
    input.end();
  });

  it("does not write to an already closed capture stdin", () => {
    const input = new EpipeWritable();
    input.destroy();
    expect(writeCaptureControl(input, "set-stream-profile 25 70 1280\n", () => undefined)).toBe(false);
  });
});
