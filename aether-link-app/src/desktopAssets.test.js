import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareDesktopAssets } from "../scripts/prepare-desktop-assets.js";
import { viewerRustInputFingerprint } from "../scripts/package-release-exes.js";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, {recursive:true,force:true})));
it("invalidates binary reuse when embedded UI changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-fingerprint-"));
  roots.push(root);
  fs.mkdirSync(path.join(root,"src"));
  const options={rustcIdentity:"test",env:{}};
  fs.writeFileSync(path.join(root,"src","App.tsx"),"old");
  const before=viewerRustInputFingerprint(root,options);
  fs.writeFileSync(path.join(root,"src","App.tsx"),"new");
  expect(viewerRustInputFingerprint(root,options)).not.toBe(before);
});
it("keeps runnable frontend files and Hosting downloads, excluding downloads from every desktop preparation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-assets-"));
  roots.push(root);
  const files = {"index.html":'<script src="/assets/app.js"></script>', "assets/app.js":"window.ready=true", "manifest.webmanifest":"{}", "download/android/v1/agent.zip":"apk", "download/android-update.json":"signed"};
  for (const [file,body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root,"dist",file)),{recursive:true});
    fs.writeFileSync(path.join(root,"dist",file),body);
  }
  fs.mkdirSync(path.join(root,"dist-desktop","download"),{recursive:true});
  fs.writeFileSync(path.join(root,"dist-desktop","download","old.zip"),"stale");
  for (let i=0;i<2;i++) {
    prepareDesktopAssets(root);
    expect(fs.existsSync(path.join(root,"dist-desktop","download"))).toBe(false);
    for (const [file,body] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(root,"dist",file),"utf8")).toBe(body);
      if (!file.startsWith("download/")) expect(fs.readFileSync(path.join(root,"dist-desktop",file),"utf8")).toBe(body);
    }
  }
});
