import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import {
  composerHasPrompt,
  createAssistantResponseTracker,
  createAutoCloseCheck,
  insertPrompt,
  isPersistedConversationPath,
  runDispatch,
  takeDispatchId
} from "../src/content";
import { countStartedAssistantMessages } from "../src/selectors";
import type { CompleteDispatchMessage, ContentMessage, DispatchPayload, DispatchResponse } from "../src/types";

const modernAssistantSelector = '[data-app-shell-active-page="true"] ' +
  'main [data-chatgpt-conversation-selection-target] ' +
  '[data-turn-key] ' +
  '[data-markdown-text-style="assistant-message"]';

class FakeAssistantMarkdown {
  constructor(
    public textContent: string,
    private readonly turn: object = {}
  ) {}

  closest(selector: string): object | null {
    if (selector === '[data-turn-key]') {
      return this.turn;
    }
    return null;
  }
}

const prompt = "Summarize https://example.com/article?item=42";

const canonical = "/c/6a76e003-92b8-83e8-90ef-22ce9ea8e8a3";
const local = "/c/local-chatgpt%3Ab7811973-aee5-448a-97fb-9af93b1786f8";

type InstalledDom = ReturnType<typeof installDom>;

class FakeInputEvent {
  constructor(
    readonly type: string,
    readonly init: InputEventInit
  ) {}
}

class FakeButton {
  disabled = false;
  clickCount = 0;
  onClick: (() => void) | undefined;

  getAttribute(): string | null {
    return null;
  }

  click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }
}

class FakeForm {
  submittedButtons: FakeButton[] = [];
  onSubmit: (() => void) | undefined;
  sendButtonAvailable = true;
  stopButtonAvailable = false;
  modelButtonAvailable = true;
  readonly modelButton = new FakeButton();
  readonly stopButton = new FakeButton();

  querySelector(selector: string): FakeButton | null {
    if (selector === 'button[type="button"][aria-label="Select ChatGPT model"]') {
      return this.modelButtonAvailable ? this.modelButton : null;
    }
    if (selector === 'button[type="button"][aria-label="Stop"]') {
      return this.stopButtonAvailable ? this.stopButton : null;
    }
    return selector === 'button[type="submit"]' && this.sendButtonAvailable
      ? this.button
      : null;
  }

  constructor(private readonly button: FakeButton) {
    button.onClick = () => {
      this.submittedButtons.push(button);
      this.onSubmit?.();
    };
  }

  requestSubmit(button: FakeButton): void {
    this.submittedButtons.push(button);
    this.onSubmit?.();
  }
}

class FakeTextarea {
  private currentValue = "";
  readonly inputEvents: FakeInputEvent[] = [];

  constructor(private readonly form: FakeForm) {}

  get value(): string {
    return this.currentValue;
  }

  set value(value: string) {
    this.currentValue = value;
  }

  closest(selector: string): FakeForm | null {
    return selector === "form" ? this.form : null;
  }

  dispatchEvent(event: FakeInputEvent): boolean {
    this.inputEvents.push(event);
    return true;
  }
}

function installDom() {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown): void => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value
    });
  };

  const button = new FakeButton();
  const form = new FakeForm(button);
  let textarea = new FakeTextarea(form);
  const assistantMessages: FakeAssistantMarkdown[] = [];
  let pathname = "/";
  let visible = false;
  let unreadable = false;
  const documentEvents = new EventTarget();
  const navigation = new EventTarget();
  class FakeElement {}
  let richInsertionAttempts = 0;
  const richComposer = Object.assign(new FakeElement(), {
    isContentEditable: true, firstChild: { nodeType: 1 },
    focus() { richInsertionAttempts += 1; throw new Error("Unexpected insertion attempt on unreadable content"); }
  });
  let assistantScans = 0;

  setGlobal("HTMLTextAreaElement", FakeTextarea);
  setGlobal("HTMLButtonElement", FakeButton);
  setGlobal("HTMLFormElement", FakeForm);
  setGlobal("HTMLElement", FakeElement);
  setGlobal("HTMLParagraphElement", class {});
  setGlobal("HTMLBRElement", class {});
  setGlobal("HTMLSpanElement", class {});
  setGlobal("Node", { TEXT_NODE: 3 });
  setGlobal("InputEvent", FakeInputEvent);
  const observers = new Set<() => void>();
  setGlobal("MutationObserver", class {
    constructor(private readonly callback: () => void) {}
    observe(): void { observers.add(this.callback); }
    disconnect(): void { observers.delete(this.callback); }
  });
  setGlobal("document", {
    get visibilityState() { return visible ? "visible" : "hidden"; },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    querySelector(selector: string) {
      if (unreadable && selector.includes("[contenteditable=")) return richComposer;
      return selector === '[data-app-shell-active-page="true"] main form textarea[name="prompt"]'
        ? textarea : null;
    },
    querySelectorAll(selector: string) {
      assistantScans += 1;
      return selector === modernAssistantSelector
        ? assistantMessages
        : [];
    }
  });
  const timers = new Set<NodeJS.Timeout>();
  const track = (timer: NodeJS.Timeout) => { timers.add(timer); return timer; };
  const clear = globalThis.clearTimeout;
  const clearTimer = (timer: NodeJS.Timeout) => { timers.delete(timer); clear(timer); };
  setGlobal("clearTimeout", clearTimer);
  setGlobal("clearInterval", clearTimer);
  setGlobal("window", {
    navigation,
    setInterval: (fn: () => void, ms: number) => track(setInterval(fn, ms)),
    // Simulate expiration of the four-second deep-link grace without a real sleep.
    setTimeout: (fn: () => void, ms: number) => track(setTimeout(fn, ms > 3_900 && ms <= 4_000 ? 10 : ms))
  });
  const search = `?prompt=${encodeURIComponent(prompt)}`;
  setGlobal("location", {
    search,
    get pathname() { return pathname; },
    get href() { return `https://chatgpt.com${pathname}${search}`; }
  });

  return {
    setGlobal,
    get textarea() { return textarea; },
    replaceTextarea() { return textarea = new FakeTextarea(form); },
    button,
    form,
    assistantMessages,
    get assistantScans() {
      return assistantScans;
    },
    setVisible(value: boolean) {
      visible = value;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    visitAndLeave() { this.setVisible(true); this.setVisible(false); },
    useUnreadableComposer(value = true) { unreadable = value; },
    mutate() { for (const callback of [...observers]) callback(); },
    finishResponse(text: string) {
      form.stopButtonAvailable = false;
      assistantMessages.push(new FakeAssistantMarkdown(text));
      this.mutate();
    },
    get richInsertionAttempts() { return richInsertionAttempts; },
    assertListenersReleased() {
      assert.equal(getEventListeners(documentEvents, "visibilitychange").length, 0);
      assert.equal(getEventListeners(navigation, "currententrychange").length, 0);
      assert.equal(observers.size, 0, "pending DOM observers were not released");
      assert.equal(timers.size, 0, "pending DOM or confirmation timers were not released");
    },
    setPathname(updatedPathname: string) {
      pathname = updatedPathname;
      navigation.dispatchEvent(new Event("currententrychange"));
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    }
  };
}

function claimedDispatch(overrides: Partial<DispatchPayload> = {}): DispatchPayload {
  const now = Date.now();
  return {
    id: "dispatch-content-test",
    prompt,
    sourceTabId: 10,
    targetTabId: 20,
    createdAt: now,
    expiresAt: now + 15_000,
    status: "claimed",
    autoSubmit: true,
    autoClose: true,
    ...overrides
  };
}

test("streaming assistant markdown counts non-empty turns without finalized message IDs", () => {
  const dom = installDom();
  try {
    const message = {};
    dom.assistantMessages.push(
      new FakeAssistantMarkdown("Earlier response"),
      new FakeAssistantMarkdown(" \n "),
      new FakeAssistantMarkdown("First block", message),
      new FakeAssistantMarkdown("Second block", message)
    );
    assert.equal(countStartedAssistantMessages(), 2);

    dom.assistantMessages.push(new FakeAssistantMarkdown("Next response"));
    assert.equal(countStartedAssistantMessages(), 3);
    assert.equal(countStartedAssistantMessages(), 3);

    dom.assistantMessages.length = 0;
    assert.equal(countStartedAssistantMessages(), 0);
  } finally {
    dom.restore();
  }
});

test("assistant response detection stops rescanning after a response starts", () => {
  let assistantMessageCount = 4;
  let scanCount = 0;
  const responseStarted = createAssistantResponseTracker(assistantMessageCount, () => {
    scanCount += 1;
    return assistantMessageCount;
  });

  assert.equal(responseStarted(), false);
  assert.equal(responseStarted(), false);
  assistantMessageCount += 1;
  assert.equal(responseStarted(), true);
  assert.equal(responseStarted(), true);
  assert.equal(responseStarted(), true);
  assert.equal(scanCount, 3);

  const nextResponseStarted = createAssistantResponseTracker(
    assistantMessageCount,
    () => {
      scanCount += 1;
      return assistantMessageCount;
    }
  );
  assert.equal(nextResponseStarted(), false);
  assert.equal(scanCount, 4);
});

test("auto-close verifies streaming completion on temporary paths and resets for each dispatch", () => {
  const dom = installDom();
  try {
    dom.setPathname(local);
    const check = createAutoCloseCheck(0);
    assert.equal(check(), null);
    dom.form.stopButtonAvailable = true;
    assert.equal(check(), null);
    dom.assistantMessages.push(new FakeAssistantMarkdown("Synthetic response"));
    assert.equal(check(), null);
    assert.equal(dom.assistantScans, 0, "temporary streaming does not rescan response text");
    dom.form.stopButton.disabled = true;
    assert.equal(check(), null, "a disabled but present Stop does not mean streaming completed");
    dom.form.stopButtonAvailable = false;
    assert.equal(check(), local);
    assert.equal(check(), local);
    assert.equal(dom.assistantScans, 1);
    assert.equal(createAutoCloseCheck(1)(), null, "streaming evidence is per dispatch");
  } finally { dom.restore(); }
});

test("a disabled Stop control is not proof that a response started", () => {
  const dom = installDom();
  try {
    dom.setPathname(canonical);
    dom.form.stopButtonAvailable = true;
    dom.form.stopButton.disabled = true;
    const check = createAutoCloseCheck(0);
    assert.equal(check(), null);
    dom.form.stopButton.disabled = false;
    assert.equal(check(), canonical);
  } finally { dom.restore(); }
});

test("only canonical UUID conversation paths count as persisted", () => {
  assert.equal(isPersistedConversationPath(canonical), true);
  assert.equal(isPersistedConversationPath(
    "/c/WEB:b7811973-aee5-448a-97fb-9af93b1786f8"
  ), false);
  assert.equal(isPersistedConversationPath(local), false);
  assert.equal(isPersistedConversationPath("/c/not-a-conversation-id"), false);
  assert.equal(isPersistedConversationPath("/"), false);
});

test("the dispatch marker is consumed without changing the prompt query", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
  const replacements: string[] = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      hash: "#share-to-chatgpt-dispatch=dispatch%2D123",
      pathname: "/",
      search: `?prompt=${encodeURIComponent(prompt)}`
    }
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      state: { existing: true },
      replaceState(_state: unknown, _unused: string, url: string) {
        replacements.push(url);
      }
    }
  });

  try {
    assert.equal(takeDispatchId(), "dispatch-123");
    assert.deepEqual(replacements, [`/?prompt=${encodeURIComponent(prompt)}`]);
  } finally {
    if (originalLocation) {
      Object.defineProperty(globalThis, "location", originalLocation);
    } else {
      Reflect.deleteProperty(globalThis, "location");
    }
    if (originalHistory) {
      Object.defineProperty(globalThis, "history", originalHistory);
    } else {
      Reflect.deleteProperty(globalThis, "history");
    }
  }
});

test("textarea fallback injection is read back with exact prompt verification", () => {
  const dom = installDom();
  try {
    insertPrompt(dom.textarea as unknown as HTMLTextAreaElement, prompt, () => {});

    assert.equal(dom.textarea.value, prompt);
    assert.equal(dom.textarea.inputEvents.length, 1);
    assert.equal(composerHasPrompt(
      dom.textarea as unknown as HTMLTextAreaElement,
      prompt
    ), true);
    assert.equal(composerHasPrompt(
      dom.textarea as unknown as HTMLTextAreaElement,
      `${prompt} changed`
    ), false);
  } finally {
    dom.restore();
  }
});

interface Scenario {
  settings?: Partial<DispatchPayload>;
  setup?(dom: InstalledDom): void;
  onSubmit?(dom: InstalledDom): void;
  onMessage?(type: string, dom: InstalledDom, dispatch: DispatchPayload): DispatchResponse | Promise<DispatchResponse> | void;
}

async function scenario({ settings, setup, onSubmit, onMessage }: Scenario) {
  const dom = installDom();
  const messages: string[] = [];
  const completions: CompleteDispatchMessage[] = [];
  const dispatch = claimedDispatch(settings);
  try {
    dom.textarea.value = prompt;
    dom.form.onSubmit = () => {
      dom.textarea.value = "";
      onSubmit?.(dom);
    };
    setup?.(dom);
    dom.setGlobal("chrome", { runtime: { async sendMessage(message: ContentMessage): Promise<DispatchResponse> {
      messages.push(message.type);
      assert.equal(message.dispatchId, dispatch.id);
      if (message.type === "complete-dispatch") completions.push(message);
      const reply = onMessage?.(message.type, dom, dispatch);
      if (reply) return reply;
      if (message.type === "claim-dispatch") return { ok: true, dispatch };
      if (message.type === "arm-dispatch") return { ok: true, dispatch: { ...dispatch, status: "submitting" } };
      return { ok: true };
    } } });
    await runDispatch(dispatch.id);
    dom.assertListenersReleased();
    assert.equal(dom.form.submittedButtons.length, dom.button.clickCount, "only click may submit");
    for (const message of completions) {
      if (!message.closeTab) assert.equal(Object.hasOwn(message, "closePath"), false);
    }
    function assertDispatch(sequence: string[], clicks: number, closeRequests?: boolean[]): void {
      assert.deepEqual(messages, sequence);
      assert.equal(dom.button.clickCount, clicks, "Send clicks");
      if (closeRequests) assert.deepEqual(completions.map(message => message.closeTab === true), closeRequests);
    }
    return { dom, assertDispatch, completions };
  } finally {
    dom.restore();
  }
}

const claimFailed = ["claim-dispatch", "fail-dispatch"];
const armFailed = ["claim-dispatch", "arm-dispatch", "fail-dispatch"];
const sent = ["claim-dispatch", "arm-dispatch", "complete-dispatch"];
const confirmed = ["claim-dispatch", "arm-dispatch", "confirm-dispatch", "complete-dispatch"];

for (const modelState of ["missing", "disabled"]) {
  test(`an enabled Send cannot submit while the model control is ${modelState}`, async () => {
    const { assertDispatch } = await scenario({
      settings: { autoClose: false, expiresAt: Date.now() + 50 },
      setup(dom) {
        dom.form.modelButtonAvailable = modelState !== "missing";
        dom.form.modelButton.disabled = modelState === "disabled";
      }
    });
    assertDispatch(claimFailed, 0);
  });
}

for (const draft of ["different", " ", "unreadable", "expired", "empty"]) {
  test(`fallback insertion: ${draft} composer`, async () => {
    const { dom, assertDispatch } = await scenario({
      settings: { autoSubmit: false, expiresAt: Date.now() + (draft === "expired" ? 50 : 10_000) },
      setup(dom) {
        dom.textarea.value = ["expired", "empty"].includes(draft) ? "" : draft;
        if (draft === "unreadable") dom.useUnreadableComposer();
      }
    });
    assert.equal(dom.richInsertionAttempts, 0);
    assert.equal(dom.textarea.inputEvents.length, draft === "empty" ? 1 : 0);
    assertDispatch(draft === "empty" ? ["claim-dispatch", "check-insertion", "complete-dispatch"] : claimFailed, 0);
  });
}

for (const change of ["missing state", "port error", "missing reply", "no reply", "expired claim",
  "route change", "draft", "unreadable", "replaced", "exact", "replacement exact"]) {
  test(`fallback insertion authorization: ${change}`, async (t) => {
    const exact = change === "exact" || change === "replacement exact";
    let original: FakeTextarea | undefined;
    const { dom, assertDispatch } = await scenario({
      settings: { autoSubmit: !exact, autoClose: false },
      setup(dom) { original = dom.textarea; original.value = ""; },
      onMessage(type, dom, dispatch) {
        if (type !== "check-insertion") return;
        if (change === "missing state") return { ok: false, error: change };
        if (change === "port error") throw new Error("Message port closed");
        if (change === "missing reply") return Promise.resolve(undefined as unknown as DispatchResponse);
        if (change === "no reply") {
          t.mock.method(Date, "now", () => dispatch.expiresAt - 5);
          return new Promise<DispatchResponse>(() => {});
        }
        if (change === "expired claim") t.mock.method(Date, "now", () => dispatch.expiresAt);
        if (change === "route change") dom.setPathname(local);
        if (change === "draft") dom.textarea.value = "User draft";
        if (change === "unreadable") dom.useUnreadableComposer();
        if (change === "replaced" || change === "replacement exact") dom.replaceTextarea();
        if (exact) dom.textarea.value = prompt;
      }
    });
    assertDispatch(["claim-dispatch", "check-insertion", exact ? "complete-dispatch" : "fail-dispatch"], 0);
    assert.equal(original?.inputEvents.length, 0);
    assert.equal(dom.textarea.inputEvents.length, 0);
    assert.equal(dom.textarea.value, exact ? prompt : change === "draft" ? "User draft" : "");
    assert.equal(dom.richInsertionAttempts, 0);
  });
}

for (const transient of ["partial", "unreadable"]) {
  test(`observe ${transient} prefill until exact without writing`, async () => {
    const { dom, assertDispatch } = await scenario({
      settings: { autoSubmit: false },
      setup(dom) {
        dom.textarea.value = prompt.slice(0, 4);
        dom.useUnreadableComposer(transient === "unreadable");
        setTimeout(() => {
          dom.useUnreadableComposer(false);
          dom.textarea.value = prompt;
          dom.mutate();
        }, 0);
      }
    });
    assertDispatch(["claim-dispatch", "complete-dispatch"], 0);
    assert.equal(dom.textarea.inputEvents.length, 0);
    assert.equal(dom.richInsertionAttempts, 0);
  });
}

test("post-insertion verification observes a partial render without writing again", async () => {
  const { dom, assertDispatch } = await scenario({
    settings: { autoClose: false },
    setup(dom) {
      dom.textarea.value = "";
      const dispatch = dom.textarea.dispatchEvent.bind(dom.textarea);
      dom.textarea.dispatchEvent = (event) => {
        dom.textarea.value = prompt.slice(0, 4);
        setTimeout(() => { dom.textarea.value = prompt; dom.mutate(); }, 0);
        return dispatch(event);
      };
    }
  });
  assertDispatch(["claim-dispatch", "check-insertion", "arm-dispatch", "complete-dispatch"], 1);
  assert.equal(dom.textarea.inputEvents.length, 1);
});

test("a marked existing conversation cannot receive fallback insertion", async () => {
  const { dom, assertDispatch } = await scenario({
    setup(dom) { dom.textarea.value = ""; dom.setPathname(canonical); },
    settings: { autoSubmit: false }
  });
  assert.equal(dom.textarea.inputEvents.length, 0);
  assertDispatch(claimFailed, 0);
});

test("a visible marked tab submits the verified prompt and requests a verified close", async () => {
  const { assertDispatch } = await scenario({
    setup(dom) { dom.setVisible(true); },
    onSubmit(dom) { dom.setPathname(canonical); dom.form.stopButtonAvailable = true; }
  });
  assertDispatch(confirmed, 1, [true]);
});

test("a visit during claim does not block fallback insertion", async () => {
  const { dom, assertDispatch } = await scenario({
    settings: { autoClose: false },
    setup(dom) { dom.textarea.value = ""; },
    onMessage(type, dom) {
      if (type === "claim-dispatch") dom.visitAndLeave();
    }
  });
  assert.equal(dom.textarea.inputEvents.length, 1);
  assertDispatch(["claim-dispatch", "check-insertion", "arm-dispatch", "complete-dispatch"], 1);
});

for (const change of ["prompt", "send-button", "model-button", "canonical", "away and back", "missing lease", "expired lease"]) {
  test(`arming cannot submit after ${change}`, async () => {
    const { assertDispatch } = await scenario({
      settings: { autoClose: false },
      onMessage(type, dom, dispatch) {
        if (type !== "arm-dispatch") return;
        if (change === "prompt") dom.textarea.value = "Changed during arming";
        if (change === "send-button") dom.button.disabled = true;
        if (change === "model-button") dom.form.modelButton.disabled = true;
        if (change === "canonical") dom.setPathname(canonical);
        if (change === "away and back") { dom.setPathname(local); dom.setPathname("/"); }
        if (change === "missing lease") return { ok: true };
        if (change === "expired lease") return { ok: true, dispatch: { ...dispatch, status: "submitting", expiresAt: Date.now() } };
      }
    });
    assertDispatch(armFailed, 0);
  });
}

test("confirmation uses the arm lease when the original claim expires", async (t) => {
  const now = Date.now();
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const { assertDispatch } = await scenario({
    settings: { expiresAt: now + 100 },
    onMessage(type, _dom, dispatch) {
      if (type === "arm-dispatch") {
        clock += 200;
        return { ok: true, dispatch: { ...dispatch, status: "submitting", expiresAt: clock + 300 } };
      }
    },
    onSubmit(dom) { dom.setPathname(canonical); dom.form.stopButtonAvailable = true; }
  });
  assertDispatch(confirmed, 1, [true]); // No 500ms delivery margin.
});

test("confirmation never waits longer than two seconds even on an extended lease", async () => {
  const { assertDispatch } = await scenario({
    onSubmit(dom) {
      dom.textarea.value = prompt;
      setTimeout(() => { dom.textarea.value = ""; }, 2_050);
    },
    settings: { expiresAt: Date.now() + 3_000 }
  });
  assertDispatch(armFailed, 1);
});

test("an unrelated route cannot supply submission confirmation", async () => {
  const { assertDispatch } = await scenario({ settings: { autoClose: false }, onSubmit(dom) { dom.setPathname("/settings"); } });
  assertDispatch(armFailed, 1);
});

for (const change of ["other canonical", "back to home", "unrelated then canonical", "different local"]) {
  test(`confirmed submission leaves the tab open on ${change}`, async () => {
    const { assertDispatch } = await scenario({
      settings: { expiresAt: Date.now() + 800 },
      onSubmit(dom) { dom.setPathname(change === "different local" ? local : canonical); },
      onMessage(type, dom) {
        if (type !== "confirm-dispatch") return;
        if (change === "other canonical") dom.setPathname(canonical.replace("6a76", "aaaa"));
        if (change === "back to home") dom.setPathname("/");
        if (change === "unrelated then canonical") { dom.setPathname("/settings"); dom.setPathname(canonical); }
        if (change === "different local") { dom.setPathname(local.replace("b781", "abcd")); dom.setPathname(canonical); }
        dom.form.stopButtonAvailable = true;
      }
    });
    assertDispatch(confirmed, 1, [false]);
  });
}

test("a visit between response polls does not disqualify a later canonical Stop", async () => {
  const { assertDispatch } = await scenario({
    settings: { expiresAt: Date.now() + 800 },
    onSubmit(dom) { dom.setPathname(local); },
    onMessage(type, dom) {
      if (type === "confirm-dispatch") setTimeout(() => {
        dom.setVisible(true);
        dom.setPathname(canonical);
        dom.setVisible(false);
        dom.form.stopButtonAvailable = true;
      }, 10);
    }
  });
  assertDispatch(confirmed, 1, [true]);
});

for (const sample of [
  { name: "new response", path: canonical, response: "Answer", autoClose: true, closes: true },
  { name: "empty response", path: canonical, response: " \n ", autoClose: true, closes: false },
  { name: "only earlier responses", path: canonical, response: null, autoClose: true, closes: false },
  { name: "temporary path", path: local, response: "Answer", autoClose: true, closes: false },
  { name: "auto-close disabled", path: canonical, response: "Answer", autoClose: false, closes: false }
]) {
  test(`assistant markdown without a Stop button: ${sample.name}`, async () => {
    const { dom, assertDispatch } = await scenario({
      settings: { expiresAt: Date.now() + 500, autoClose: sample.autoClose },
      setup(dom) { dom.assistantMessages.push(new FakeAssistantMarkdown("Earlier response")); },
      onSubmit(dom) {
        dom.form.sendButtonAvailable = false;
        dom.setPathname(sample.path);
        if (sample.response !== null) dom.assistantMessages.push(new FakeAssistantMarkdown(sample.response));
      }
    });
    assertDispatch(sample.autoClose ? confirmed : sent, 1, [sample.closes]);
    if (!sample.autoClose) assert.equal(dom.assistantScans, 0);
  });
}

test("Stop present at DOM confirmation qualifies before a microtask finishes the local response", async () => {
  const { assertDispatch } = await scenario({
    settings: { expiresAt: Date.now() + 400 },
    onSubmit(dom) {
      dom.setPathname(local);
      dom.form.stopButtonAvailable = true;
      queueMicrotask(() => {
        dom.finishResponse("Test");
      });
    }
  });
  assertDispatch(confirmed, 1, [true]);
});

for (const ack of ["ok", "reject", "error", "visit", "path advanced", "expired", "late ACK", "DOM error"]) {
  test(`temporary-path completion during deferred confirmation: ${ack}`, async (t) => {
    let acknowledged = false;
    const { assertDispatch } = await scenario({
      settings: { expiresAt: Date.now() + 500 },
      onSubmit(dom) { dom.setPathname(local); },
      onMessage(type, dom, dispatch) {
        if (type === "complete-dispatch") assert.ok(acknowledged);
        if (type !== "confirm-dispatch") return;
        return new Promise<DispatchResponse>((resolve, reject) => {
          // Both the Stop and the completion marker can be gone by the ACK.
          setTimeout(() => {
            if (ack === "error") { reject(new Error("Message port closed")); return; }
            if (ack === "DOM error") {
              Object.defineProperty(dom.form, "stopButtonAvailable", { get() { throw new Error("Unreadable Stop"); } });
              dom.mutate();
              acknowledged = true;
              resolve({ ok: true });
              return;
            }
            dom.form.stopButtonAvailable = true;
            dom.mutate();
            dom.finishResponse("Test");
            dom.assistantMessages.length = 0;
            if (ack === "visit") dom.visitAndLeave();
            // Ownership permits local → canonical, but the local completion cannot authorize that new route.
            if (ack === "path advanced") dom.setPathname(canonical);
            if (ack === "expired") return; // No reply; the lease must bound the wait.
            if (ack === "late ACK") t.mock.method(Date, "now", () => dispatch.expiresAt);
            acknowledged = true;
            resolve(ack === "reject" ? { ok: false, error: "Not confirmed" } : { ok: true });
          }, 0);
        });
      }
    });
    if (["reject", "error", "expired"].includes(ack)) {
      assertDispatch(["claim-dispatch", "arm-dispatch", "confirm-dispatch", "fail-dispatch"], 1, []);
    } else {
      assertDispatch(confirmed, 1, [ack === "ok" || ack === "visit"]);
    }
  });
}

for (const path of [`${local}/`, `/c/${canonical.slice(3).toUpperCase()}/`]) {
  test(`completion carries only the exact observed pathname: ${path}`, async () => {
    const { completions } = await scenario({
      settings: { expiresAt: Date.now() + 600 },
      onSubmit(dom) {
        dom.setPathname(path);
        dom.form.stopButtonAvailable = true;
      },
      onMessage(type, dom) {
        if (type !== "confirm-dispatch") return;
        dom.finishResponse("Synthetic answer");
      }
    });
    assert.deepEqual(completions, [{
      type: "complete-dispatch", dispatchId: "dispatch-content-test", closeTab: true, closePath: path
    }]);
  });
}

for (const mode of ["streaming locally", "local completion", "canonical while streaming"]) {
  test(`auto-close after one Send click: ${mode}`, async () => {
    const { dom, assertDispatch } = await scenario({
      settings: { expiresAt: Date.now() + 700 },
      onSubmit(dom) {
        dom.setPathname(local);
        dom.form.sendButtonAvailable = false;
        dom.form.stopButtonAvailable = true;
        dom.assistantMessages.push(new FakeAssistantMarkdown("Synthetic answer"));
        if (mode === "canonical while streaming") setTimeout(() => dom.setPathname(canonical), 10);
        if (mode === "local completion") setTimeout(() => { dom.form.stopButtonAvailable = false; }, 10);
      }
    });
    assertDispatch(confirmed, 1, [mode !== "streaming locally"]);
    assert.equal(dom.assistantScans, mode === "local completion" ? 2 : 1);
  });
}
