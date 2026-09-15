import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";

// Explicit, local-only maximum-size check; intentionally outside the default suite.
const totalBytes = 500 * 1024 * 1024;
const chunkBytes = 32 * 1024;
const totalChunks = totalBytes / chunkBytes;
const part = Buffer.alloc(chunkBytes);
for (let i = 0; i < part.length; i++) part[i] = i % 251;
const fullHash = createHash("sha256");
for (let i = 0; i < totalChunks; i++) fullHash.update(part);
const expectedHash = fullHash.digest("hex");
const fixture = {
  type: "file-chunk", transferId: "large-resume", filename: "large-received.bin",
  totalBytes, totalChunks, fileData: part.toString("base64"),
  chunkSha256: createHash("sha256").update(part).digest("hex"),
};
const bundle = (await build({
  entryPoints: ["src/domain/persistentFileReceiver.ts"], bundle: true, write: false,
  format: "iife", globalName: "Receiver", platform: "browser",
})).outputFiles[0].text;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const started = performance.now();
try {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.route("**/*", route => route.request().url() === "http://large-receiver.test/"
    ? route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local file receive verification</title>" })
    : route.abort());
  await page.goto("http://large-receiver.test/");
  const install = async () => {
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.completed = 0;
      window.receiver = new window.Receiver.PersistentFileReceiver("large-file-check", async ({ blob }) => {
        window.completed++;
        window.completedBlob = blob;
      });
    });
  };
  await install();
  const feed = async (start, end) => page.evaluate(async ({ fixture, start, end, expectedHash }) => {
    let ack;
    for (let chunkIndex = start; chunkIndex < end; chunkIndex++) {
      const isLast = chunkIndex === fixture.totalChunks - 1;
      ack = await window.receiver.accept({ ...fixture, chunkIndex, isLast, ...(isLast ? { fileSha256: expectedHash } : {}) });
      if (ack.receivedChunks !== chunkIndex + 1 || ack.receivedBytes !== (chunkIndex + 1) * 32768) throw new Error("Incorrect committed offset");
    }
    return ack;
  }, { fixture, start, end, expectedHash });
  for (let start = 0; start < totalChunks / 2; start += 1000) {
    const ack = await feed(start, start + 1000);
    assert.equal(ack.status, "partial");
    console.log(`Committed ${ack.receivedBytes / 1048576} MiB`);
  }
  assert.equal(await page.evaluate(() => window.completed), 0);
  await page.reload();
  await install();
  const resumed = await page.evaluate(async fixture => window.receiver.accept({ ...fixture, chunkIndex: 0, isLast: false }), fixture);
  assert.equal(resumed.receivedBytes, totalBytes / 2);
  assert.equal(resumed.receivedChunks, totalChunks / 2);
  console.log("Reload resume offset verified: 250 MiB");
  let last;
  for (let start = totalChunks / 2; start < totalChunks; start += 1000) {
    last = await feed(start, Math.min(start + 1000, totalChunks));
    console.log(`Committed ${last.receivedBytes / 1048576} MiB`);
  }
  assert.equal(last.status, "complete");
  assert.equal(await page.evaluate(() => window.completed), 1);
  const downloadReady = page.waitForEvent("download");
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(window.completedBlob);
    link.download = "large-received.bin";
    document.body.append(link);
    link.click();
  });
  const download = await downloadReady;
  const path = await download.path();
  assert.ok(path);
  assert.equal((await stat(path)).size, totalBytes);
  const downloadedHash = createHash("sha256");
  for await (const bytes of createReadStream(path)) downloadedHash.update(bytes);
  assert.equal(downloadedHash.digest("hex"), expectedHash);
  await page.evaluate(async () => { await window.receiver.discard(); });
  assert.equal(await page.evaluate(() => window.receiver.restore()), null);
  console.log(JSON.stringify({ passed: true, totalBytes, totalChunks, resumedBytes: resumed.receivedBytes, sha256: expectedHash, downloaded: true, discarded: true, elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
} finally {
  await context.close();
  await browser.close();
}
