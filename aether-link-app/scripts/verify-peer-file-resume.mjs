import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

// Opt-in local integration: real sender, IndexedDB receiver and download; no live peers.
const senderBundle = (await build({ entryPoints: ["src/agent/fileChannelSender.ts"], bundle: true, write: false, platform: "node", format: "esm" })).outputFiles[0].text;
const { createFileChannelSender } = await import(`data:text/javascript;base64,${Buffer.from(senderBundle).toString("base64")}`);
const receiverBundle = (await build({ entryPoints: ["src/domain/persistentFileReceiver.ts"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "Receiver" })).outputFiles[0].text;
const directory = await mkdtemp(path.join(tmpdir(), "wonremote-peer-file-"));
const sourcePath = path.join(directory, "source.bin");
const bytes = Buffer.alloc(18 * 32768 + 123);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
let browser;
try {
  await writeFile(sourcePath, bytes);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let activeSender;
  let deliveryError;
  await page.exposeFunction("deliverFileAck", ack => {
    if (ack?.error) { deliveryError = new Error(ack.error); activeSender?.close(); }
    else activeSender?.acknowledge(ack);
  });
  await page.route("**/*", route => route.request().url() === "http://peer-file.test/"
    ? route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local peer file check</title>" }) : route.abort());
  await page.goto("http://peer-file.test/");
  const install = async () => {
    await page.addScriptTag({ content: receiverBundle });
    await page.evaluate(async () => {
      window.completed = 0;
      window.receiver = new window.Receiver.PersistentFileReceiver("peer-resume", async file => {
        window.completed++;
        window.received = file;
      });
      const sender = new RTCPeerConnection({ iceServers: [] });
      const receiver = new RTCPeerConnection({ iceServers: [] });
      window.peers = [sender, receiver];
      const channel = sender.createDataChannel("file", { ordered: true });
      receiver.ondatachannel = ({ channel: incoming }) => {
        incoming.onmessage = async event => {
          try {
            const ack = await window.receiver.accept(JSON.parse(event.data));
            incoming.send(JSON.stringify(ack));
          } catch (error) {
            incoming.send(JSON.stringify({ error: String(error) }));
          }
        };
      };
      const gather = peer => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { peer.removeEventListener("icegatheringstatechange", check); reject(new Error("Local ICE timed out")); }, 10000);
        const check = () => {
          if (peer.iceGatheringState !== "complete") return;
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", check);
          resolve();
        };
        peer.addEventListener("icegatheringstatechange", check);
        check();
      });
      await sender.setLocalDescription(await sender.createOffer());
      await gather(sender);
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await gather(receiver);
      await sender.setRemoteDescription(receiver.localDescription);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Local channel open timed out")), 10000);
        channel.onopen = () => { clearTimeout(timer); resolve(); };
        if (channel.readyState === "open") { clearTimeout(timer); resolve(); }
      });
      window.fileChannel = channel;
      channel.onmessage = event => { void window.deliverFileAck(JSON.parse(event.data)); };
    });
  };
  await install();
  const sent = [];
  const send = async interrupt => {
    let delivering = Promise.resolve();
    deliveryError = undefined;
    const sender = createFileChannelSender({
      readyState: "open",
      send(payload) {
        sent.push(JSON.parse(payload).chunkIndex);
        delivering = delivering.then(() => page.evaluate(payload => window.fileChannel.send(payload), payload))
          .catch(error => { deliveryError = error; sender.close(); });
      },
    });
    activeSender = sender;
    try {
      await sender.sendFile({ sourcePath, transferId: "peer-resume", onProgress(receivedBytes) {
        if (interrupt && receivedBytes === 16 * 32768) sender.close();
      } });
    } finally {
      await delivering;
      sender.close();
      activeSender = undefined;
      if (deliveryError) throw deliveryError;
    }
  };
  await assert.rejects(send(true), { name: "AbortError" });
  await page.evaluate(() => window.peers.forEach(peer => peer.close()));
  assert.deepEqual(sent, Array.from({ length: 16 }, (_, i) => i));
  assert.equal(await page.evaluate(() => window.completed), 0);
  await page.reload();
  await install();
  const restored = await page.evaluate(() => window.receiver.restore());
  assert.equal(restored.receivedBytes, 16 * 32768);
  assert.equal(restored.blob, null);
  sent.length = 0;
  await send(false);
  assert.deepEqual(sent, [...Array.from({ length: 8 }, (_, i) => i), 16, 17, 18]);
  assert.equal(await page.evaluate(() => window.completed), 1);
  const downloading = page.waitForEvent("download");
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(window.received.blob);
    link.download = window.received.filename;
    document.body.append(link);
    link.click();
  });
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "source.bin");
  assert.deepEqual(await readFile(await download.path()), bytes);
  await page.evaluate(() => window.receiver.discard());
  assert.equal(await page.evaluate(() => window.receiver.restore()), null);
  console.log(JSON.stringify({ passed: true, totalBytes: bytes.length, persistedChunks: 16, retryChunks: sent, downloadedExactBytes: true, discarded: true, sender: "production createFileChannelSender", transport: "local ordered RTCDataChannel, no STUN/TURN" }));
  await context.close();
} finally {
  await browser?.close();
  await unlink(sourcePath).catch(error => { if (error.code !== "ENOENT") throw error; });
  await rmdir(directory);
}
