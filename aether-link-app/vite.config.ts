import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  build: { rolldownOptions: { input: { index: join(dirname(packageJsonPath), "index.html"), video: join(dirname(packageJsonPath), "video-support.html") } } },
  define: {
    "import.meta.env.VITE_WONREMOTE_APP_VERSION": JSON.stringify(packageJson.version),
  },
});
