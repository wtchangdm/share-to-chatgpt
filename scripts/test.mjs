import { rm } from "node:fs/promises";
import { build } from "esbuild";
import { spawn } from "node:child_process";

const outputDirectory = ".test-dist";
await rm(outputDirectory, { recursive: true, force: true });

await build({
  entryPoints: ["tests/prompt.test.ts"],
  outdir: outputDirectory,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "silent"
});

const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=dot", `${outputDirectory}/prompt.test.js`],
  {
    stdio: "inherit"
  }
);

child.once("exit", async (code, signal) => {
  await rm(outputDirectory, { recursive: true, force: true });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
