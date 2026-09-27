import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const script = resolve("scripts/package.mjs");
const files = [
  "manifest.json", "options.html", "options.css",
  "dist/background.js", "dist/content.js", "dist/options.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"
].sort();

function command(executable: string, args: string[], cwd: string): string {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "share-to-chatgpt-package-test-"));
  for (const file of files) {
    const destination = join(directory, file);
    await mkdir(dirname(destination), { recursive: true });
    if (file.startsWith("dist/")) await writeFile(destination, "// bundled fixture\n");
    else await copyFile(join(root, file), destination);
  }
  return directory;
}

test("release ZIP contains only runtime files and replaces rather than updates old archives", async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, ".env"), "SYNTHETIC_TEST_VALUE=not-a-secret\n");
    await writeFile(join(directory, "dist/unused.js"), "// must not ship\n");
    await writeFile(join(directory, "dist/content.js.map"), "{}");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    const archive = `release/share-to-chatgpt-${manifest.version}.zip`;
    command(process.execPath, [script], directory);
    assert.deepEqual(command("unzip", ["-Z1", archive], directory).split("\n").sort(), files);
    for (const file of files) {
      const extracted = spawnSync("unzip", ["-p", archive, file], { cwd: directory });
      assert.equal(extracted.status, 0);
      assert.deepEqual(extracted.stdout, await readFile(join(directory, file)));
    }
    const references = [
      manifest.background.service_worker, manifest.options_ui.page,
      ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
      ...manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js)
    ];
    for (const file of references) assert.ok(files.includes(file as string), `Missing ${file}`);

    await writeFile(join(directory, "stale.txt"), "old archive entry");
    command("zip", ["-q", archive, "stale.txt"], directory);
    await writeFile(join(directory, "dist/content.js"), "// updated bundle\n");
    command(process.execPath, [script], directory);
    assert.deepEqual(command("unzip", ["-Z1", archive], directory).split("\n").sort(), files);
    assert.equal(command("unzip", ["-p", archive, "dist/content.js"], directory), "// updated bundle");

    const previous = await readFile(join(directory, archive));
    await rm(join(directory, "dist/options.js"));
    const failure = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /options\.js/);
    assert.deepEqual(await readFile(join(directory, archive)), previous);

    await writeFile(join(directory, "dist/options.js"), "// recovered bundle\n");
    command(process.execPath, [script], directory);
    assert.equal(command("unzip", ["-p", archive, "dist/options.js"], directory), "// recovered bundle");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
