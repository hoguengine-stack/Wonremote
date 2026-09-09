import { closeSync, openSync } from "node:fs";
import path from "node:path";

if (process.argv[2] !== "--watch" || !process.env.APPDATA) {
  process.exit(2);
}

const lockPath = path.join(process.env.APPDATA, "WonRemote", "updates", "update-handoff.lock");
const deadline = Date.now() + 5 * 60_000;

while (Date.now() < deadline) {
  try {
    const lock = openSync(lockPath, "r+");
    closeSync(lock);
    process.exit(0);
  } catch (error) {
    if (!error || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) {
      process.exit(3);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

process.exit(4);
