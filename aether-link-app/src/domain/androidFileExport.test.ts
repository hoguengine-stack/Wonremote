import { expect, it } from "vitest";
import { AndroidFileExporter } from "./androidFileExport";

function bridge(reply: (message: any) => any) {
  const sent: any[] = [];
  const port = { onmessage: null as any, onmessageerror: null, start() {}, close() {}, postMessage(text: string) {
    const message = JSON.parse(text); sent.push(message);
    const value = reply(message);
    if (value) queueMicrotask(() => port.onmessage({ data: JSON.stringify(value) }));
  } };
  const exporter = new AndroidFileExporter(); exporter.attach(port as unknown as MessagePort);
  return { exporter, sent };
}
it("streams ordered bounded chunks and waits for native saved confirmation", async () => {
  let received = 0;
  const { exporter, sent } = bridge(m => {
    if (m.type === "begin") return { type: "ready", id: m.file.id };
    if (m.type === "chunk") { received += atob(m.data).length; return { type: "ack", id: m.id, index: m.index, receivedBytes: received }; }
    return { type: "saved", id: m.id, receivedBytes: received };
  });
  expect(await exporter.save({ id: "file", filename: "a.bin", blob: new Blob([new Uint8Array(40000)]) }, new AbortController().signal)).toBe(true);
  expect(sent.map(m => m.type)).toEqual(["begin", "chunk", "chunk", "finish"]);
  expect(atob(sent[1].data).length).toBe(32768);
  expect(atob(sent[2].data).length).toBe(7232);
});
it("picker cancellation is not reported as saved", async () => {
  const { exporter, sent } = bridge(() => ({ type: "cancelled" }));
  expect(await exporter.save({ id: "file", filename: "a", blob: new Blob() }, new AbortController().signal)).toBe(false);
  expect(sent).toHaveLength(1);
});
it("wrong acknowledgement fails and cancels instead of finishing", async () => {
  const { exporter, sent } = bridge(m => m.type === "begin" ? { type: "ready", id: m.file.id } : m.type === "chunk" ? { type: "ack", id: "other" } : null);
  await expect(exporter.save({ id: "file", filename: "a", blob: new Blob(["a"]) }, new AbortController().signal)).rejects.toThrow();
  expect(sent.map(m => m.type)).toEqual(["begin", "chunk", "cancel"]);
});
