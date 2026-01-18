import fs from "fs";
import path from "path";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function incPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)?$/.exec(version);
  if (!m) throw new Error(`Invalid version format: ${version}`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]) + 1;
  const suffix = m[4] ?? "";
  return `${major}.${minor}.${patch}${suffix}`;
}

const root = process.cwd();

// Usage:
// node scripts/bump-version.mjs admin
// node scripts/bump-version.mjs agent
// node scripts/bump-version.mjs all
const target = (process.argv[2] || "").toLowerCase();
if (!["admin", "agent", "all"].includes(target)) {
  console.error("Usage: node scripts/bump-version.mjs <admin|agent|all>");
  process.exit(1);
}

const targets = target === "all" ? ["admin", "agent"] : [target];

for (const t of targets) {
  const pkgPath = path.join(root, "packages", t, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found: ${pkgPath}`);
  }

  const pkg = readJson(pkgPath);
  if (!pkg.version) throw new Error(`No version field in ${pkgPath}`);

  const before = pkg.version;
  const after = incPatch(before);
  pkg.version = after;

  writeJson(pkgPath, pkg);

  console.log(`[${t}] ${before} -> ${after}`);
}
