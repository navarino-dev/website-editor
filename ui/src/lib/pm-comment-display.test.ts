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
});
