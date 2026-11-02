import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishFileWithoutOverwrite } from "../../src/agent/filePublication";

const parent = path.resolve(tmpdir());
const root = await mkdtemp(path.join(parent, "wonremote-publication-e2e-"));
process.env.WONREMOTE_POC_PATH ||= path.resolve("dist-poc/wonremote-poc.exe");
try {
  const source = path.join(root, "received.part"), target = path.join(root, "existing.txt");
  await writeFile(source, "new bytes"); await writeFile(target, "original bytes");
  await assert.rejects(publishFileWithoutOverwrite(source, target), { code: "EEXIST" });
  assert.equal(await readFile(target, "utf8"), "original bytes");
  const renamed = path.join(root, "renamed.txt");
  await publishFileWithoutOverwrite(source, renamed);
  assert.equal(await readFile(renamed, "utf8"), "new bytes");
  await assert.rejects(readFile(source), { code: "ENOENT" });
  console.log("Bundled native publication: collision preserved, exact bytes published, temporary source removed.");
} finally {
  if (path.dirname(root) !== parent || !path.basename(root).startsWith("wonremote-publication-e2e-")) throw Error("Unsafe fixture cleanup");
  await rm(root, { recursive: true, force: true });
}
