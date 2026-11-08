import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function prepareDesktopAssets(root, desktopProduct = process.env.WONREMOTE_DESKTOP_PRODUCT) {
  const source = path.join(root, desktopProduct ? "public" : "dist");
  const destination = path.join(root, "dist-desktop");
  if (!fs.existsSync(path.join(desktopProduct ? destination : source, "index.html"))) throw new Error("Build the frontend first.");
  // Only remove the dedicated generated output, never the shared Hosting assets.
  if (!desktopProduct) fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (file) => path.relative(source, file).split(path.sep)[0] !== "download",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDesktopAssets(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
