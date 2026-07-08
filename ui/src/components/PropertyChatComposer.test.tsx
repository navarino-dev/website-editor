// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyChatComposer } from "./PropertyChatComposer";

// ------------------------------------------------------------------ mocks --

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

// ----------------------------------------------------------------- helpers --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function actSync(callback: () => void) {
  flushSync(callback);
}

async function flush() {
  await new Promise<void>((resolve) => {
    flushSync(() => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Trigger React's onChange on a textarea.
 * React 16+ watches the native prototype setter, so we must use it.
 */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForAssertion(assertion: () => void, attempts = 40) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await flush();
    }
  }
  throw lastError;
}

function renderComposer(
  props: Parameters<typeof PropertyChatComposer>[0],
  container: HTMLDivElement,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PropertyChatComposer {...props} />
      </QueryClientProvider>,
    );
  });
  return { root };
}

// ------------------------------------------------------------------ fixtures --

const PROP_A = {
  id: "prop-1",
  name: "Alpha Residences",
  leadAgentId: "agent-42",
  color: "#1a2b3c",
};
const PROP_B = {
  id: "prop-2",
  name: "Barton Commons",
  leadAgentId: null as string | null,
  color: "#aabbcc",
};

// ------------------------------------------------------------------ tests --

describe("PropertyChatComposer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useRealTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    navigateMock.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.create.mockResolvedValue({ id: "iss_1", identifier: "NAV-99" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // -----------------------------------------------------------------------
  // Test 1: preselected property → create + navigate
  // -----------------------------------------------------------------------
  it("preselected property: creates issue with correct payload and navigates on success", async () => {
    const { root } = renderComposer(
      {
        companyId: "co-1",
        properties: [PROP_A, PROP_B],
        defaultPropertyId: PROP_A.id,
      },
      container,
    );
    await flush();

    // The chip for the preselected property should be visible immediately
    expect(container.textContent).toContain(PROP_A.name);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Type a message
    flushSync(() => {
      setTextareaValue(textarea, "Update the hero section");
    });
    await flush();

    const sendBtn = container.querySelector(
      '[aria-label="Send request"]',
    ) as HTMLButtonElement;
    expect(sendBtn).not.toBeNull();

    // Send button should now be enabled (text + property present)
    await waitForAssertion(() => {
      expect(sendBtn.disabled).toBe(false);
    });

    // Click send
    flushSync(() => {
      sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // issuesApi.create must have been called with the full correct payload
    expect(mockIssuesApi.create).toHaveBeenCalledTimes(1);
    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({
        title: "Update the hero section",
        description: "Update the hero section",
        status: "todo",
        priority: "medium",
        workMode: "standard",
        projectId: PROP_A.id,
        assigneeAgentId: PROP_A.leadAgentId,
      }),
    );

    // After the promise resolves, navigate should be called with the issue path
    await waitForAssertion(() => {
      expect(navigateMock).toHaveBeenCalledWith("/issues/NAV-99");
    });

    flushSync(() => root.unmount());
  });

  // -----------------------------------------------------------------------
  // Test 2: @ opens the picker; selecting sets the chip and removes the token
  // -----------------------------------------------------------------------
  it("typing @ opens the property picker and selecting a property sets the chip", async () => {
    // Two properties, no defaultPropertyId → nothing auto-selected
    const { root } = renderComposer(
      {
        companyId: "co-1",
        properties: [PROP_A, PROP_B],
      },
      container,
    );
    await flush();

    // Neither chip should appear initially
    const initialChip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.title === "Change property",
    );
    expect(initialChip).toBeUndefined();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Typing "@Bar" — caret ends at position 4 (= value.length in jsdom after change)
    // detectMention will extract token "Bar" and filter to PROP_B
    flushSync(() => {
      setTextareaValue(textarea, "@Bar");
    });
    await flush();

    // Picker (listbox) should appear
    await waitForAssertion(() => {
      expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    });

    // PROP_B ("Barton Commons") must appear as an option
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options.some((o) => o.textContent?.includes(PROP_B.name))).toBe(true);

    // Click the Barton Commons option
    const bartonOption = options.find((o) => o.textContent?.includes(PROP_B.name))!;
    flushSync(() => {
      bartonOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The @Bar token should be removed from the textarea
    expect(textarea.value).not.toContain("@Bar");

    // The property chip should now show Barton Commons
    await waitForAssertion(() => {
      const chip = Array.from(container.querySelectorAll("button")).find(
        (b) => b.title === "Change property",
      );
      expect(chip).not.toBeUndefined();
      expect(chip!.textContent).toContain(PROP_B.name);
    });

    // Picker must be closed
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    flushSync(() => root.unmount());
  });

  // -----------------------------------------------------------------------
  // Test 3: send button disabled without text or without a selected property
  // -----------------------------------------------------------------------
  it("send button is disabled when the textarea is empty regardless of property selection", async () => {
    // Two properties, no default → no auto-selection
    const { root } = renderComposer(
      {
        companyId: "co-1",
        properties: [PROP_A, PROP_B],
      },
      container,
    );
    await flush();

    const sendBtn = container.querySelector(
      '[aria-label="Send request"]',
    ) as HTMLButtonElement;
    expect(sendBtn).not.toBeNull();

    // Empty textarea + no property → disabled
    expect(sendBtn.disabled).toBe(true);

    // Select a property via "@Alpha" mention so we have a selection
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    flushSync(() => {
      setTextareaValue(textarea, "@Alpha");
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    });

    const alphaOption = Array.from(container.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.includes(PROP_A.name),
    )!;
    flushSync(() => {
      alphaOption.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // After selecting: property is set, but the token "@Alpha" was removed, leaving
    // the textarea empty → send button must still be disabled (needs non-empty text)
    await waitForAssertion(() => {
      expect(sendBtn.disabled).toBe(true);
    });

    flushSync(() => root.unmount());
  });
});
