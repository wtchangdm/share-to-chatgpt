import assert from "node:assert/strict";
import test from "node:test";
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
import type { DispatchPayload, DispatchResponse } from "../src/types";

const modernAssistantSelector = 'main [data-chatgpt-conversation-selection-target] ' +
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

interface InstalledDom {
  textarea: FakeTextarea;
  button: FakeButton;
  form: FakeForm;
  assistantMessages: FakeAssistantMarkdown[];
  readonly assistantScans: number;
  setPathname(pathname: string): void;
  restore(): void;
}

class FakeInputEvent {
  constructor(
    readonly type: string,
    readonly init: InputEventInit
  ) {}
}

class FakeButton {
  disabled = false;
  clickCount = 0;

  getAttribute(): string | null {
    return null;
  }

  click(): void {
    this.clickCount += 1;
  }
}

class FakeForm {
  submittedButtons: FakeButton[] = [];
  onSubmit: (() => void) | undefined;
  sendButtonAvailable = true;
  stopButtonAvailable = false;
  readonly stopButton = new FakeButton();

  querySelector(selector: string): FakeButton | null {
    if (selector === 'button[type="button"][aria-label="Stop"]') {
      return this.stopButtonAvailable ? this.stopButton : null;
    }
    return selector === 'button[type="submit"]' && this.sendButtonAvailable
      ? this.button
      : null;
  }

  constructor(private readonly button: FakeButton) {}

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

function installDom(): InstalledDom {
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
  const textarea = new FakeTextarea(form);
  const assistantMessages: FakeAssistantMarkdown[] = [];
  let pathname = "/c/local-chatgpt%3Ab7811973-aee5-448a-97fb-9af93b1786f8";
  let assistantScans = 0;

  setGlobal("HTMLTextAreaElement", FakeTextarea);
  setGlobal("HTMLButtonElement", FakeButton);
  setGlobal("HTMLFormElement", FakeForm);
  setGlobal("HTMLElement", class {});
  setGlobal("InputEvent", FakeInputEvent);
  setGlobal("MutationObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  setGlobal("document", {
    querySelector(selector: string) {
      return selector === 'main form textarea[name="prompt"]' ? textarea : null;
    },
    querySelectorAll(selector: string) {
      assistantScans += 1;
      return selector === modernAssistantSelector
        ? assistantMessages
        : [];
    }
  });
  setGlobal("window", {
    setInterval: globalThis.setInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis)
  });
  setGlobal("location", {
    get pathname() {
      return pathname;
    }
  });

  return {
    textarea,
    button,
    form,
    assistantMessages,
    get assistantScans() {
      return assistantScans;
    },
    setPathname(updatedPathname: string) {
      pathname = updatedPathname;
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
    assert.equal(check(), true);
    assert.equal(check(), true);
    assert.equal(dom.assistantScans, 1);
    assert.equal(createAutoCloseCheck(1)(), null, "streaming evidence is per dispatch");
  } finally { dom.restore(); }
});

test("a disabled Stop control is not proof that a response started", () => {
  const dom = installDom();
  try {
    dom.setPathname("/c/6a76e003-92b8-83e8-90ef-22ce9ea8e8a3");
    dom.form.stopButtonAvailable = true;
    dom.form.stopButton.disabled = true;
    const check = createAutoCloseCheck(0);
    assert.equal(check(), null);
    dom.form.stopButton.disabled = false;
    assert.equal(check(), true);
  } finally { dom.restore(); }
});

test("only canonical UUID conversation paths count as persisted", () => {
  assert.equal(isPersistedConversationPath(
    "/c/6a76e003-92b8-83e8-90ef-22ce9ea8e8a3"
  ), true);
  assert.equal(isPersistedConversationPath(
    "/c/WEB:b7811973-aee5-448a-97fb-9af93b1786f8"
  ), false);
  assert.equal(isPersistedConversationPath(
    "/c/local-chatgpt%3Ab7811973-aee5-448a-97fb-9af93b1786f8"
  ), false);
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
    insertPrompt(dom.textarea as unknown as HTMLTextAreaElement, prompt);

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

test("an incomplete assistant response leaves the submitted tab open", async () => {
  const dom = installDom();
  const closeRequests: boolean[] = [];
  const dispatch = claimedDispatch({ expiresAt: Date.now() + 700 });
  dom.textarea.value = prompt;
  dom.form.onSubmit = () => {
    dom.textarea.value = "";
    dom.button.disabled = true;
    dom.form.sendButtonAvailable = false;
    dom.form.stopButtonAvailable = true;
    dom.assistantMessages.push(new FakeAssistantMarkdown("Response still streaming"));
  };

  const originalChrome = globalThis.chrome;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        async sendMessage(message: {
          type: string;
          closeTab?: boolean;
        }): Promise<DispatchResponse> {
          if (message.type === "claim-dispatch") {
            return { ok: true, dispatch };
          }
          if (message.type === "complete-dispatch") {
            closeRequests.push(message.closeTab === true);
          }
          return { ok: true };
        }
      }
    }
  });

  try {
    await runDispatch(dispatch.id);

    assert.deepEqual(dom.form.submittedButtons, [dom.button]);
    assert.deepEqual(closeRequests, [false]);
  } finally {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome
    });
    dom.restore();
  }
});

for (const change of ["prompt", "send-button"] as const) {
  test(`arming cannot submit after the ${change} changes`, async () => {
    const dom = installDom();
    const messages: string[] = [];
    const dispatch = claimedDispatch({ expiresAt: Date.now() + 800, autoClose: false });
    dom.textarea.value = prompt;
    const originalChrome = globalThis.chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          async sendMessage(message: { type: string }): Promise<DispatchResponse> {
            messages.push(message.type);
            if (message.type === "claim-dispatch") return { ok: true, dispatch };
            if (message.type === "arm-dispatch") {
              if (change === "prompt") dom.textarea.value = "Changed during arming";
              else dom.button.disabled = true;
            }
            return { ok: true };
          }
        }
      }
    });
    try {
      await runDispatch(dispatch.id);
      assert.deepEqual(dom.form.submittedButtons, []);
      assert.equal(dom.button.clickCount, 0);
      assert.deepEqual(messages, ["claim-dispatch", "arm-dispatch", "fail-dispatch"]);
    } finally {
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
      dom.restore();
    }
  });
}

for (const scenario of [
  { name: "new response", canonical: true, response: "Answer", autoClose: true, closes: true },
  { name: "empty response", canonical: true, response: " \n ", autoClose: true, closes: false },
  { name: "only earlier responses", canonical: true, response: null, autoClose: true, closes: false },
  { name: "temporary path", canonical: false, response: "Answer", autoClose: true, closes: false },
  { name: "auto-close disabled", canonical: true, response: "Answer", autoClose: false, closes: false }
]) {
  test(`assistant markdown without a Stop button: ${scenario.name}`, async () => {
    const dom = installDom();
    const messages: string[] = [];
    const closeRequests: boolean[] = [];
    const dispatch = claimedDispatch({
      expiresAt: Date.now() + 1_100,
      autoClose: scenario.autoClose
    });
    dom.textarea.value = prompt;
    dom.assistantMessages.push(new FakeAssistantMarkdown("Earlier response"));
    dom.form.onSubmit = () => {
      dom.textarea.value = "";
      dom.form.sendButtonAvailable = false;
      if (scenario.canonical) {
        dom.setPathname("/c/6a76e003-92b8-83e8-90ef-22ce9ea8e8a3");
      }
      if (scenario.response !== null) {
        dom.assistantMessages.push(new FakeAssistantMarkdown(scenario.response));
      }
    };
    const originalChrome = globalThis.chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          async sendMessage(message: {
            type: string;
            closeTab?: boolean;
          }): Promise<DispatchResponse> {
            messages.push(message.type);
            if (message.type === "claim-dispatch") {
              return { ok: true, dispatch };
            }
            if (message.type === "complete-dispatch") {
              closeRequests.push(message.closeTab === true);
            }
            return { ok: true };
          }
        }
      }
    });

    try {
      await runDispatch(dispatch.id);
      assert.deepEqual(messages, ["claim-dispatch", "arm-dispatch", "complete-dispatch"]);
      assert.deepEqual(dom.form.submittedButtons, [dom.button]);
      assert.equal(dom.button.clickCount, 0);
      assert.deepEqual(closeRequests, [scenario.closes]);
      if (!scenario.autoClose) {
        assert.equal(dom.assistantScans, 0);
      }
    } finally {
      Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: originalChrome
      });
      dom.restore();
    }
  });
}

test("a canonical conversation closes as soon as the response starts", async () => {
  const dom = installDom();
  const messages: string[] = [];
  const closeRequests: boolean[] = [];
  const statesAtCompletion: Array<{
    pathname: string;
    stopAvailable: boolean;
  }> = [];
  const dispatch = claimedDispatch({ expiresAt: Date.now() + 1_500 });
  dom.textarea.value = prompt;
  dom.form.onSubmit = () => {
    dom.textarea.value = "";
    dom.button.disabled = true;
    dom.form.sendButtonAvailable = false;
    dom.form.stopButtonAvailable = true;
    setTimeout(() => {
      dom.setPathname("/c/6a76e003-92b8-83e8-90ef-22ce9ea8e8a3");
    }, 10);
  };

  const originalChrome = globalThis.chrome;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        async sendMessage(message: {
          type: string;
          closeTab?: boolean;
        }): Promise<DispatchResponse> {
          messages.push(message.type);
          if (message.type === "claim-dispatch") {
            return { ok: true, dispatch };
          }
          if (message.type === "complete-dispatch") {
            closeRequests.push(message.closeTab === true);
            statesAtCompletion.push({
              pathname: location.pathname,
              stopAvailable: dom.form.stopButtonAvailable
            });
          }
          return { ok: true };
        }
      }
    }
  });

  try {
    await runDispatch(dispatch.id);

    assert.deepEqual(messages, [
      "claim-dispatch",
      "arm-dispatch",
      "complete-dispatch"
    ]);
    assert.deepEqual(dom.form.submittedButtons, [dom.button]);
    assert.equal(dom.button.clickCount, 0);
    assert.deepEqual(closeRequests, [true]);
    assert.equal(dom.assistantScans, 1, "only the pre-submit baseline is scanned on the Stop fast path");
    assert.deepEqual(statesAtCompletion, [{
      pathname: "/c/6a76e003-92b8-83e8-90ef-22ce9ea8e8a3",
      stopAvailable: true
    }]);
  } finally {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome
    });
    dom.restore();
  }
});
