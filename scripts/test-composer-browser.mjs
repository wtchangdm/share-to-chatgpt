import { spawnSync } from "node:child_process";
import { build } from "esbuild";

// Requires an installed agent-browser and Chromium; never attaches to a user's profile.
function browser(args, input) {
  const result = spawnSync("agent-browser", args, { encoding: "utf8", input });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

const session = browser(["session", "id", "--scope", "worktree", "--prefix", "composer-test"])
  + `-${process.pid}`;
const bundle = await build({
  entryPoints: ["tests/browser/composer.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "composerChecks",
  platform: "browser",
  target: "chrome120",
  logLevel: "silent"
});
try {
  browser(["open", "about:blank", "--session", session, "--json"]);
  const output = JSON.parse(browser(
    ["eval", "--stdin", "--session", session, "--json"],
    `${bundle.outputFiles[0].text}\ncomposerChecks.${process.argv.includes("--benchmark")
      ? "benchmarkComposerReading" : "checkComposerInsertion"}();`
  ));
  if (!output.success) throw new Error(JSON.stringify(output.error));
  console.log(JSON.stringify(output.data.result));
} finally {
  browser(["close", "--session", session, "--json"]);
}
