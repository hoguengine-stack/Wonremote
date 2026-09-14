import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { approvedAssets, assertDraft, assertBytes } from "./sign-approved-release.js";

const draft = () => ({tag_name:"v0.1.94",draft:true,assets:Object.entries(approvedAssets).map(([name,a])=>({name,size:a.size,digest:`sha256:${a.sha256}`,state:"uploaded"}))});
test("accepts only the exact approved unpublished release assets", () => {
  assert.doesNotThrow(()=>assertDraft(draft()));
  for (const change of [d=>d.draft=false,d=>d.tag_name="v0.1.95",d=>d.assets.pop(),d=>d.assets.push(d.assets[0]),d=>d.assets[0].digest="sha256:bad",d=>d.assets[0].size++,d=>d.assets[0].state="new"]) {
    const d=draft();change(d);assert.throws(()=>assertDraft(d));
  }
});
test("verifies downloaded bytes and rejects corrupt or non-x86 executables", () => {
  const bytes=Buffer.alloc(80);bytes.write("MZ");bytes.writeUInt32LE(64,60);bytes.write("PE\0\0",64,"binary");bytes.writeUInt16LE(0x014c,68);
  const expected=b=>({size:b.length,sha256:createHash("sha256").update(b).digest("hex")});
  assert.doesNotThrow(()=>assertBytes(bytes,expected(bytes)));
  assert.throws(()=>assertBytes(bytes,{...expected(bytes),size:79}));
  assert.throws(()=>assertBytes(bytes,{...expected(bytes),sha256:"0".repeat(64)}));
  bytes.writeUInt16LE(0x8664,68);assert.throws(()=>assertBytes(bytes,expected(bytes)));
  bytes.writeUInt32LE(1000,60);assert.throws(()=>assertBytes(bytes,expected(bytes)));
});
