import assert from "node:assert/strict";
import test from "node:test";
import { waitFor } from "../src/content";

function installObservationDom() {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown): void => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const root = { isConnected: true };
  let currentRoot = root;
  let callback = (): void => {};
  const observations: Array<{ target: unknown; options: MutationObserverInit }> = [];
  let disconnects = 0;
  setGlobal("document", { querySelector: () => currentRoot });
  setGlobal("window", {
    setInterval: globalThis.setInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis)
  });
  setGlobal("MutationObserver", class {
    constructor(onMutation: () => void) { callback = onMutation; }
    observe(target: unknown, options: MutationObserverInit): void {
      observations.push({ target, options });
    }
    disconnect(): void { disconnects += 1; }
  });
  return {
    root,
    observations,
    get disconnects() { return disconnects; },
    mutate() { callback(); },
    replaceRoot() {
      currentRoot.isConnected = false;
      currentRoot = { isConnected: true };
      return currentRoot;
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}

test("DOM waits observe main and react to in-place Send-to-Stop attribute changes", async () => {
  const dom = installObservationDom();
  try {
    let ready = false;
    const result = waitFor(() => ready ? true : null, Date.now() + 1_000);
    assert.equal(dom.observations[0]?.target, dom.root);
    assert.ok(dom.observations[0]?.options.attributeFilter?.includes("aria-label"));
    assert.ok(dom.observations[0]?.options.attributeFilter?.includes("type"));
    ready = true;
    dom.mutate();
    assert.equal(await result, true);
    assert.equal(dom.disconnects, 1);
  } finally { dom.restore(); }
});

test("DOM waits clean up on reader errors, timeout, and a subsequent successful wait", async () => {
  const dom = installObservationDom();
  try {
    let fail = false;
    const result = waitFor(() => {
      if (fail) throw new Error("DOM read failed");
      return null;
    }, Date.now() + 1_000);
    const rejected = assert.rejects(result, /DOM read failed/);
    fail = true;
    dom.mutate();
    await rejected;
    assert.equal(dom.disconnects, 1);
    assert.equal(await waitFor(() => null, Date.now() + 10), null);
    assert.equal(dom.disconnects, 2);
    assert.equal(await waitFor(() => true, Date.now() + 1_000), true);
    assert.equal(dom.disconnects, 3);
  } finally { dom.restore(); }
});

test("DOM waits rebind after main is replaced rather than observing a detached tree", async () => {
  const dom = installObservationDom();
  try {
    let ready = false;
    const result = waitFor(() => ready ? true : null, Date.now() + 1_000);
    const replacement = dom.replaceRoot();
    dom.mutate();
    assert.equal(dom.observations.at(-1)?.target, replacement);
    ready = true;
    dom.mutate();
    assert.equal(await result, true);
  } finally { dom.restore(); }
});
