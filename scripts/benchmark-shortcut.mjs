import assert from "node:assert/strict";
import { build } from "esbuild";

const url = "https://example.com/article";
const sourceTabId = 10;
const targetTabId = 20;
const entries = new Map();
const ignored = { addListener() {} };
let command, navigated;
let scans, injections, beforeInjection, synchronous;
let invoked = false;
const countBeforeInjection = () => { if (!injections) beforeInjection++; };
const actionCall = async () => { countBeforeInjection(); };
globalThis.chrome = {
  runtime: { onInstalled: ignored, onMessage: ignored },
  action: { onClicked: ignored, setBadgeText: actionCall, setTitle: actionCall, setBadgeBackgroundColor: actionCall },
  contextMenus: { onClicked: ignored },
  commands: { onCommand: { addListener(fn) { command = fn; } } },
  scripting: { async executeScript({ target }) {
    assert.equal(target.tabId, sourceTabId);
    injections++;
    synchronous = invoked;
    return [{ result: url }];
  } },
  storage: {
    local: { async get() { countBeforeInjection(); return { settings: { optionalText: "" } }; } },
    session: {
      onChanged: ignored,
      async get(key) {
        countBeforeInjection();
        if (key === null) { scans++; return Object.fromEntries(entries); }
        return { [key]: entries.get(key) };
      },
      async set(items) { countBeforeInjection(); for (const [key, value] of Object.entries(items)) entries.set(key, value); }
    }
  },
  tabs: {
    onActivated: ignored, onUpdated: ignored, onRemoved: ignored,
    async create(options) { assert.deepEqual(options, { url: "about:blank", active: false }); return { id: targetTabId }; },
    async update(id, { url: marked }) {
      const parsed = new URL(marked);
      const dispatchId = entries.get(`tab-dispatch:${id}`);
      const pending = entries.get(`dispatch:${dispatchId}`);
      assert.equal(entries.get(`source-status:${sourceTabId}`), dispatchId);
      assert.equal(pending.status, "pending");
      assert.equal(pending.prompt, url);
      assert.equal(pending.targetTabId, targetTabId);
      assert.equal(parsed.searchParams.get("prompt"), url);
      assert.equal(parsed.hash, `#share-to-chatgpt-dispatch=${dispatchId}`);
      navigated();
    }
  }
};
const result = await build({ entryPoints: ["src/background.ts"], bundle: true, write: false, format: "esm" });
globalThis.setTimeout = () => 0; // Do not retain expiry timers across fixed-size trials.
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
let expected;
async function run(count) {
  for (let i = 0; i < count; i++) {
    entries.clear();
    scans = injections = beforeInjection = 0;
    const done = new Promise(resolve => { navigated = resolve; });
    invoked = true;
    command("send-hovered-link-to-chatgpt", { id: sourceTabId });
    invoked = false;
    await done;
    assert.equal(injections, 1);
    const counts = { scans, callsBeforeInjection: beforeInjection, synchronous };
    expected ??= counts;
    assert.deepEqual(counts, expected);
  }
}
await run(1000);
const samples = [];
for (let i = 0; i < 7; i++) {
  globalThis.gc?.();
  const start = process.hrtime.bigint();
  await run(5000);
  samples.push(Number(process.hrtime.bigint() - start) / 5000);
}
samples.sort((a, b) => a - b);
console.log(`Node ${process.version}, ${process.platform}/${process.arch}; 1000 warmup, 7 × 5000 shortcut-to-bound-navigation trials`);
console.log({ medianNs: Math.round(samples[3]), ...expected });
