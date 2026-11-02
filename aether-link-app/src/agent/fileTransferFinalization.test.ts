import { chmod, link, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSha256 } from "./checksum";
import { inspectTransferredFileDownload, saveTransferredFileChunk, saveTransferredFileDownloadStream } from "./fileTransferReceiver";
import { publishFileWithoutOverwrite } from "./filePublication";

vi.mock("./filePublication", () => ({ publishFileWithoutOverwrite: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});

const roots: string[] = [];
const modes = ["legacy", "chunked", "storage"] as const;
type Mode = typeof modes[number];

afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(link).mockReset();
  vi.mocked(publishFileWithoutOverwrite).mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("wonremote-finalize-")) {
      throw new Error("Refusing to clean a directory not created by this test");
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "wonremote-finalize-"));
  roots.push(root);
  const target = path.join(root, "existing.txt");
  await writeFile(target, "original user file");
  return { root, target };
}

function receive(mode: Mode, root: string, content = "replacement", transferId = "transfer-1", collisionPolicy?: import("../domain/fileCollisionPolicy").FileCollisionPolicy) {
  const bytes = Buffer.from(content);
  const file = {
    id: transferId, filename: "existing.txt", fileData: bytes.toString("base64"), collisionPolicy,
    totalBytes: bytes.length, chunkSha256: computeSha256(bytes), fileSha256: computeSha256(bytes),
  };
  const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: root };
  if (mode === "legacy") return saveTransferredFileChunk(file, env);
  if (mode === "chunked") return saveTransferredFileChunk({ ...file, transferId, chunkIndex: 0, totalChunks: 1, isLast: true }, env);
  return saveTransferredFileDownloadStream({ ...file, transferId, delivery: "firebase-storage" }, Readable.from([bytes]), env);
}

describe("received file finalization preserves existing user data", () => {
  it("uses bounded native no-replace publication when the filesystem has no hardlinks", async () => {
    const { root, target } = await fixture();
    vi.mocked(link).mockRejectedValue(Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" }));
    vi.mocked(publishFileWithoutOverwrite).mockImplementation(async (source, destination) => {
      if (destination === target) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      await rename(source, destination);
    });
    const result = await receive("chunked", root, "new bytes", "without-links", "rename");
    expect(await readFile(target, "utf8")).toBe("original user file");
    expect(await readFile(result.targetPath, "utf8")).toBe("new bytes");
    expect(publishFileWithoutOverwrite).toHaveBeenCalledTimes(2);
  });
  it("does not hide permission failures behind a native fallback", async () => {
    const { root, target } = await fixture();
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(receive("legacy", root, "new bytes", "denied", "rename")).rejects.toThrow("permission denied");
    expect(publishFileWithoutOverwrite).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("original user file");
  });
  it("rejects an unknown collision policy before creating any transfer file", async () => {
    const { root } = await fixture();
    await expect(saveTransferredFileChunk({ id: "bad-policy", filename: "existing.txt", fileData: "YQ==", collisionPolicy: "execute" as never },
      { WONREMOTE_AGENT_DOWNLOADS_DIR: root })).rejects.toThrow("Invalid file collision policy");
    expect(await readdir(root)).toEqual(["existing.txt"]);
  });
  it.each(modes)("renames a colliding %s transfer without changing original bytes", async mode => {
    const { root, target } = await fixture();
    const result = await receive(mode, root, "new bytes", "renamed", "rename");
    expect(result.targetPath).toBe(path.join(root, "(1) existing.txt"));
    expect(await readFile(target, "utf8")).toBe("original user file");
    expect(await readFile(result.targetPath, "utf8")).toBe("new bytes");
  });
  it.each(modes)("skips a colliding %s transfer and preserves the old file", async mode => {
    const { root, target } = await fixture();
    await expect(receive(mode, root, "new bytes", "skipped", "skip")).rejects.toThrow("File skipped:");
    expect(await readFile(target, "utf8")).toBe("original user file");
    expect(await readdir(root)).toEqual(["existing.txt"]);
  });
  it("publishes concurrent rename choices to different complete files", async () => {
    const { root, target } = await fixture();
    const results = await Promise.all([receive("chunked", root, "first", "one", "rename"), receive("storage", root, "second", "two", "rename")]);
    expect(new Set(results.map(result => result.targetPath)).size).toBe(2);
    expect(await readFile(target, "utf8")).toBe("original user file");
    expect(await Promise.all(results.map(result => readFile(result.targetPath, "utf8")))).toEqual(["first", "second"]);
  });
  it.each(modes)("keeps the previous file when %s replacement fails", async (mode) => {
    const { root, target } = await fixture();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("replacement blocked"), { code: "EACCES" }));
    await expect(receive(mode, root)).rejects.toThrow("replacement blocked");
    await expect(readFile(target, "utf8")).resolves.toBe("original user file");
  });

  it.each(modes)("still replaces a destination with exact complete bytes in %s mode", async (mode) => {
    const { root, target } = await fixture();
    const result = await receive(mode, root);
    expect(result).toMatchObject({ status: "complete", targetPath: target, receivedBytes: 11, totalChunks: 1 });
    await expect(readFile(target, "utf8")).resolves.toBe("replacement");
    await expect(readdir(root)).resolves.toEqual(["existing.txt"]);
  });

  it.each(modes)("does not mix bytes from concurrent distinct %s transfers", async (mode) => {
    const { root, target } = await fixture();
    const left = "left".repeat(8192), right = "right".repeat(8192);
    const results = await Promise.all([receive(mode, root, left, "left"), receive(mode, root, right, "right")]);
    expect(results.every(result => result.status === "complete")).toBe(true);
    expect([left, right]).toContain(await readFile(target, "utf8"));
    await expect(readdir(root)).resolves.toEqual(["existing.txt"]);
  });

  it("can retry a verified Storage file after replacement is blocked", async () => {
    const { root, target } = await fixture();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("file in use"), { code: "EBUSY" }));
    await expect(receive("storage", root)).rejects.toThrow("file in use");
    const file = {
      id: "transfer-1", transferId: "transfer-1", filename: "existing.txt", fileData: "",
      totalBytes: 11, fileSha256: computeSha256(Buffer.from("replacement")),
    };
    const env = { WONREMOTE_AGENT_DOWNLOADS_DIR: root };
    const state = await inspectTransferredFileDownload(file, env);
    expect(state.receivedBytes).toBe(11);
    const result = await saveTransferredFileDownloadStream(file, Readable.from([]), env, { appendFromBytes: 11 });
    expect(result.status).toBe("complete");
    await expect(readFile(target, "utf8")).resolves.toBe("replacement");
  });

  it("waits for a failed publication before committing a queued transfer", async () => {
    const { root, target } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(rename).mockImplementationOnce(async () => {
      await gate;
      throw Object.assign(new Error("first publication blocked"), { code: "EACCES" });
    });
    const first = receive("legacy", root, "first", "first");
    const results = Promise.allSettled([first, receive("chunked", root, "second", "second")]);
    try {
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      await expect(readFile(target, "utf8")).resolves.toBe("original user file");
    } finally {
      release();
    }
    expect((await results).map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    await expect(readFile(target, "utf8")).resolves.toBe("second");
  });

  it("keeps the previous legacy file and removes its staging file after a partial write failure", async () => {
    const { root, target } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      const realWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await realWrite("incomplete bytes");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      return handle;
    });
    await expect(receive("legacy", root)).rejects.toThrow("disk full");
    await expect(readFile(target, "utf8")).resolves.toBe("original user file");
    await expect(readdir(root)).resolves.toEqual(["existing.txt"]);
  });

  it("does not remove an existing staging file when exclusive creation fails", async () => {
    const { root, target } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let occupied: string | undefined;
    vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
      occupied = String(file);
      await actual.writeFile(file, "another transfer", { flag: "wx" });
      return actual.open(file, flags, mode);
    });
    await expect(receive("legacy", root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(occupied).toBeDefined();
    await expect(readFile(occupied!, "utf8")).resolves.toBe("another transfer");
    await expect(readFile(target, "utf8")).resolves.toBe("original user file");
  });

  it.skipIf(process.platform !== "win32")("preserves a real Windows read-only destination", async () => {
    const { root, target } = await fixture();
    await chmod(target, 0o444);
    try {
      await expect(receive("chunked", root)).rejects.toThrow();
      await expect(readFile(target, "utf8")).resolves.toBe("original user file");
    } finally {
      await chmod(target, 0o666);
    }
  });
});
