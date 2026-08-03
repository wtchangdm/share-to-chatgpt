import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/options.ts"],
  outdir: "dist",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  minify: false,
  logLevel: "info"
});
