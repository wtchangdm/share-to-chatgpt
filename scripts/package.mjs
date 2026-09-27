import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

// Explicit allowlist: never archive the repository or dist/ recursively.
const files = [
  "manifest.json", "options.html", "options.css",
  "dist/background.js", "dist/content.js", "dist/options.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"
];
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
  throw new Error("A numeric manifest version is required for packaging.");
}
for (const file of files) {
  if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular file: ${file}`);
}

const directory = resolve("release");
const filename = `share-to-chatgpt-${manifest.version}.zip`;
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(join(directory, ".package-"));
try {
  const archive = join(temporary, filename);
  const result = spawnSync("zip", ["-X", "-q", archive, ...files], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "zip failed");
  // Replace only after success; never update a ZIP that may contain stale entries.
  await rename(archive, join(directory, filename));
  console.log(`Created release/${filename} (${files.length} runtime files)`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
