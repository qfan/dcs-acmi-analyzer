import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const LICENSE_FILE = "third-party-licenses.txt";

/**
 * Vite's `build.license` only sees the main bundle, not the separately built web workers, so
 * worker-only dependencies (fflate) are missing from it. Append every runtime dependency in
 * package.json that the generated file does not already list.
 */
function completeLicenseFile(): Plugin {
  return {
    name: "complete-license-file",
    apply: "build",
    enforce: "post",
    // Vite emits the license file late, so patch it on disk once the bundle is written.
    writeBundle(options) {
      const file = resolve(options.dir ?? "dist", LICENSE_FILE);
      let text = readFileSync(file, "utf8");
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"));
      for (const name of Object.keys(pkg.dependencies ?? {})) {
        if (text.includes(`## ${name} - `)) continue;
        const dir = resolve(import.meta.dirname, "node_modules", name);
        const dep = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
        const license = readFileSync(resolve(dir, "LICENSE"), "utf8").trim();
        text += `\n## ${name} - ${dep.version} (${dep.license})\n\n${license}\n`;
      }
      writeFileSync(file, text);
    },
  };
}

export default defineConfig({
  plugins: [react(), completeLicenseFile()],
  // Relative asset URLs, so the built pages work from any subfolder of a site.
  base: "./",
  worker: { format: "es" },
  build: {
    // Bundled dependencies' license texts (React, three.js, fflate…), linked from the page footer.
    license: { fileName: LICENSE_FILE },
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        analytics: resolve(import.meta.dirname, "analytics.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
