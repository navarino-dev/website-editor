// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishingProgressDialog } from "./PublishingProgressDialog";

// ------------------------------------------------------------------ mocks --

const mockListComments = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: {
    listComments: mockListComments,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ----------------------------------------------------------------- helpers --

const since = Date.parse("2026-07-09T12:00:00Z");

function isoAt(offsetMs: number) {
  return new Date(since + offsetMs).toISOString();
}

function makeComment(body: string, createdAt: string, id = "c1") {
  return { id, body, createdAt };
}

async function flush() {
  // Drain the microtask queue so react-query resolves its queryFn promise
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, maxMs = 2000) {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < maxMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
  }
  throw lastError;
}

// ------------------------------------------------------------------ tests --

describe("PublishingProgressDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0 },
      },
    });
    mockListComments.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  function renderDialog(
    props: Partial<React.ComponentProps<typeof PublishingProgressDialog>> = {},
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PublishingProgressDialog
            open={true}
            onOpenChange={() => {}}
            issueId="issue-1"
            sinceMs={since}
            {...props}
          />
        </QueryClientProvider>,
      );
    });
  }

  // -----------------------------------------------------------------------
  // Test 1: in-progress (deploying phase)
  // -----------------------------------------------------------------------
  it("shows 'Publishing your change' title and no 'View your website' link while in progress", async () => {
    mockListComments.mockResolvedValue([
      makeComment(
        "Publishing your change now — I'll share the live link here as soon as it's ready.",
        isoAt(5_000),
      ),
    ]);

    renderDialog();

    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("Publishing your change");
    });

    // No live link
    const links = Array.from(document.body.querySelectorAll("a")).filter(
      (a) => a.textContent?.includes("View your website"),
    );
    expect(links).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 2: live phase — shows link and Done button
  // -----------------------------------------------------------------------
  it("shows 'Your change is live' title, a 'View your website' link, and a Done button", async () => {
    mockListComments.mockResolvedValue([
      makeComment(
        "✨ Your change is now live.\n\nLIVE_URL: https://www.sanjosejax.com/",
        isoAt(60_000),
      ),
    ]);

    renderDialog();

    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("Your change is live");
    });

    const liveLink = Array.from(document.body.querySelectorAll("a")).find(
      (a) => a.textContent?.includes("View your website"),
    );
    expect(liveLink).toBeDefined();
    expect(liveLink?.getAttribute("href")).toBe("https://www.sanjosejax.com/");

    const doneButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Done",
    );
    expect(doneButton).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Test 3: stale live comment should be ignored (older than sinceMs - 15s)
  // -----------------------------------------------------------------------
  it("ignores a LIVE_URL comment older than sinceMs-15s and stays in-progress", async () => {
    // createdAt is sinceMs - 60s → older than sinceMs - 15_000 → should be filtered out
    mockListComments.mockResolvedValue([
      makeComment(
        "✨ Your change is now live.\n\nLIVE_URL: https://www.sanjosejax.com/",
        isoAt(-60_000),
      ),
    ]);

    renderDialog();

    await waitForAssertion(() => {
      // Query has resolved — we should be in "preparing" or similar in-progress state
      expect(document.body.textContent).toContain("Publishing your change");
    });

    const liveLink = Array.from(document.body.querySelectorAll("a")).find(
      (a) => a.textContent?.includes("View your website"),
    );
    expect(liveLink).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 4: failed phase
  // -----------------------------------------------------------------------
  it("shows 'This is taking a little longer' title for a snag comment", async () => {
    mockListComments.mockResolvedValue([
      makeComment(
        "We hit a snag publishing this change. The team has been notified.",
        isoAt(30_000),
      ),
    ]);

    renderDialog();

    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("This is taking a little longer");
    });
  });
});
