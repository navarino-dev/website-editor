// Strong markers of an agent's internal status narration — these only appear in
// machine/heartbeat status updates, never in a property-manager-facing message.
const NOISE_PATTERNS: RegExp[] = [
  /this wake\b/i,
  /this heartbeat/i,
  /remains?\s+in[_ ]review/i,
  /request_confirmation/i,
  /no new human comments/i,
  // Internal engineering narration that leaks after approval/merge — the manager
  // gets the friendly "✨ your change is now live" notice separately.
  /merged to main/i,
  /merged with squash/i,
  /\bPR merged\b/i,
  /branch deleted/i,
  /\blet me (fetch|merge|read|check|look|close|open|create|push|see)\b/i,
  /confirmation was accepted/i,
  /close the issue/i,
  /\blive on main\b/i,
];

export function dejargonComment(text: string): { hidden: boolean; cleanedText: string } {
  const trimmed = text.trim();

  if (NOISE_PATTERNS.some((re) => re.test(trimmed))) {
    return { hidden: true, cleanedText: "" };
  }

  const cleaned = trimmed
    .split("\n")
    // Drop lines that are PR references or pure GitHub links.
    .filter((line) => {
      // Remove lines that are PR references (with optional markdown bold)
      if (/^\s*\*{0,2}PR\*{0,2}\s*:/i.test(line)) return false;
      // Remove lines that are just bare GitHub URLs (nothing else substantial)
      if (/^\s*https?:\/\/.*github\.com.*\s*$/.test(line)) return false;
      // Remove internal "Preview was at <url>" lines (post-publish narration).
      if (/^\s*[-*]?\s*Preview was at\b/i.test(line)) return false;
      return true;
    })
    .join("\n")
    // Inline GitHub markdown links -> keep the link text only.
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]*github\.com[^)]*\)/gi, "$1")
    // Bare GitHub URLs -> remove.
    .replace(/https?:\/\/[^\s)]*github\.com[^\s)]*/gi, "")
    // Remove inline PR / pull-request references.
    .replace(/\bpull request\s*#\d+\b/gi, "")
    .replace(/\bPR\s*#\d+\b/gi, "")
    // Soften leftover status tokens.
    .replace(/\bin_review\b/gi, "in review")
    .replace(/\bin_progress\b/gi, "in progress")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length === 0) {
    return { hidden: true, cleanedText: "" };
  }

  return { hidden: false, cleanedText: cleaned };
}
