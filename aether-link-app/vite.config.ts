import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};

export default defineConfig(() => {
  const product = process.env.WONREMOTE_DESKTOP_PRODUCT || "";
  const index = join(dirname(packageJsonPath), "index.html");
  return {
    plugins: [react()],
    build: {
      copyPublicDir: !product,
      rolldownOptions: { input: product ? { index } : { index, video: join(dirname(packageJsonPath), "video-support.html") } },
    },
    define: {
      "import.meta.env.VITE_WONREMOTE_APP_VERSION": JSON.stringify(packageJson.version),
      "import.meta.env.VITE_WONREMOTE_DESKTOP_PRODUCT": JSON.stringify(product),
    },
  };
});
