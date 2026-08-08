import assert from "node:assert/strict";
import test from "node:test";
import {
  composerHasPrompt,
  insertPrompt,
  runDispatch,
  takeDispatchId
} from "../src/content";
import type { DispatchPayload, DispatchResponse } from "../src/types";

const prompt = "Summarize https://example.com/article?item=42";

interface InstalledDom {
  textarea: FakeTextarea;
  button: FakeButton;
  form: FakeForm;
  assistantMessages: Array<{ textContent: string }>;
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

  querySelector(): FakeButton {
    return this.button;
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
  const assistantMessages: Array<{ textContent: string }> = [];

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
      return selector === "#prompt-textarea" ? textarea : null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-message-author-role="assistant"]'
        ? assistantMessages
        : [];
    }
  });
  setGlobal("window", {
    setInterval: globalThis.setInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis)
  });

  return {
    textarea,
    button,
    form,
    assistantMessages,
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

test("a verified prompt is armed, submitted once, and closed after a response starts", async () => {
  const dom = installDom();
  const messages: string[] = [];
  const closeRequests: boolean[] = [];
  const dispatch = claimedDispatch();
  dom.textarea.value = prompt;
  dom.form.onSubmit = () => {
    dom.textarea.value = "";
    dom.button.disabled = true;
    dom.assistantMessages.push({ textContent: "Response started" });
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

    assert.deepEqual(messages, [
      "claim-dispatch",
      "arm-dispatch",
      "complete-dispatch"
    ]);
    assert.deepEqual(dom.form.submittedButtons, [dom.button]);
    assert.equal(dom.button.clickCount, 0);
    assert.deepEqual(closeRequests, [true]);
  } finally {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: originalChrome
    });
    dom.restore();
  }
});
