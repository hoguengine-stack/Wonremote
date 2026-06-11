import { existsSync } from "node:fs";
import path from "node:path";

export function isSourceTreeUpdateTarget(appDir: string): boolean {
  const root = path.resolve(appDir);

  return (
    existsSync(path.join(root, "package.json")) &&
    existsSync(path.join(root, "package-lock.json")) &&
    existsSync(path.join(root, "src"))
  );
}
