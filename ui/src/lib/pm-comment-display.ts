// Strong markers of an agent's internal status narration — these only appear in
// machine/heartbeat status updates, never in a property-manager-facing message.
const NOISE_PATTERNS: RegExp[] = [
  /nothing to action/i,
  /this wake\b/i,
  /this heartbeat/i,
  /remains?\s+in[_ ]review/i,
  /pending confirmation/i,
  /request_confirmation/i,
  /no new human comments/i,
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
      return true;
    })
    .join("\n")
    // Inline GitHub markdown links -> keep the link text only.
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]*github\.com[^)]*\)/gi, "$1")
    // Bare GitHub URLs -> remove.
    .replace(/https?:\/\/[^\s)]*github\.com[^\s)]*/gi, "")
    // Soften leftover status tokens.
    .replace(/\bin_review\b/gi, "in review")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length === 0) {
    return { hidden: true, cleanedText: "" };
  }

  return { hidden: false, cleanedText: cleaned };
}
