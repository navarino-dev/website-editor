// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("labels and renders a deploy_failed_review payload with property name and reason", () => {
    expect(approvalLabel("deploy_failed_review")).toBe("Publishing Issue");

    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="deploy_failed_review"
          payload={{
            propertyName: "Seaside Website",
            reason: "Build failed: missing import",
            attempts: 3,
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Seaside Website");
    expect(container.textContent).toContain("Build failed: missing import");

    act(() => {
      root.unmount();
    });
  });

  it("labels and renders a safety_review_required payload with the score and reasoning", () => {
    expect(approvalLabel("safety_review_required")).toBe("Safety Review");

    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="safety_review_required"
          payload={{
            score: 8,
            reasoning: "Touches a backend service",
            factors: ["backend", "multi-page"],
            priorStatus: "todo",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("8/10");
    expect(container.textContent).toContain("Touches a backend service");
    expect(container.textContent).toContain("backend");

    act(() => {
      root.unmount();
    });
  });
});
