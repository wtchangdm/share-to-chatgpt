import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { build } from "esbuild";

const outputDirectory = ".test-dist";

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return await findTestFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  }));
  return nestedFiles.flat();
}

await rm(outputDirectory, { recursive: true, force: true });
const testFiles = (await findTestFiles("tests")).sort();
if (testFiles.length === 0) {
  throw new Error("No tests/**/*.test.ts files were found.");
}

await build({
  entryPoints: testFiles,
  outbase: "tests",
  outdir: outputDirectory,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "silent"
});

const builtTests = testFiles.map((file) =>
  join(outputDirectory, relative("tests", file)).replace(/\.ts$/, ".js")
);
const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=dot", ...builtTests],
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
