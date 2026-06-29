import { describe, expect, it } from "vitest";
import { dejargonComment } from "./pm-comment-display";

describe("dejargonComment", () => {
  it("hides internal status-narration comments", () => {
    const noise =
      "The only comment is my own status update from the previous run. " +
      "Nothing to action this heartbeat. NAV-23 remains in_review pending confirmation.";
    expect(dejargonComment(noise).hidden).toBe(true);
  });

  it("keeps a real friendly update and strips GitHub/PR lines", () => {
    const input =
      "I've added the privacy policy page.\n" +
      "**PR:** https://github.com/navarino-dev/seaside-website/pull/3\n" +
      "Let me know if this looks good.";
    const { hidden, cleanedText } = dejargonComment(input);
    expect(hidden).toBe(false);
    expect(cleanedText).toContain("I've added the privacy policy page.");
    expect(cleanedText).toContain("Let me know if this looks good.");
    expect(cleanedText).not.toContain("github.com");
    expect(cleanedText).not.toContain("PR:");
  });

  it("strips an inline GitHub markdown link but keeps the sentence", () => {
    const input = "Opened the [pull request](https://github.com/x/y/pull/1) for you.";
    expect(dejargonComment(input).cleanedText).toBe("Opened the pull request for you.");
  });

  it("softens leftover status tokens", () => {
    const input = "This is now in_review for you to look at.";
    expect(dejargonComment(input).cleanedText).toBe("This is now in review for you to look at.");
  });

  it("hides a comment that becomes empty after cleaning", () => {
    const input = "https://github.com/navarino-dev/seaside-website/pull/3";
    expect(dejargonComment(input).hidden).toBe(true);
  });

  // I1: "pending confirmation" is a natural phrase, not a machine marker.
  it("does not hide a friendly message containing 'pending confirmation'", () => {
    const input =
      "I've updated the homepage banner. It's live pending confirmation from you — let me know!";
    expect(dejargonComment(input).hidden).toBe(false);
  });

  // I3: inline PR reference removal.
  it("removes inline PR references but keeps the surrounding sentence", () => {
    const input = "Changes are ready — PR #3 has been created for review.";
    const { hidden, cleanedText } = dejargonComment(input);
    expect(hidden).toBe(false);
    expect(cleanedText).not.toContain("PR #3");
  });

  // I3: in_progress softening.
  it("softens in_progress status token", () => {
    const input = "The task is currently in_progress.";
    expect(dejargonComment(input).cleanedText).toContain("in progress");
    expect(dejargonComment(input).cleanedText).not.toContain("in_progress");
  });
});
