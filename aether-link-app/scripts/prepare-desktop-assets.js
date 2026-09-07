import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function prepareDesktopAssets(root) {
  const source = path.join(root, "dist");
  const destination = path.join(root, "dist-desktop");
  if (!fs.existsSync(path.join(source, "index.html"))) throw new Error("Build the web frontend first.");
  // Only remove the dedicated generated output, never the shared Hosting assets.
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (file) => path.relative(source, file).split(path.sep)[0] !== "download",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDesktopAssets(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
