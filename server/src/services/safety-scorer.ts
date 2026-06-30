import Anthropic from "@anthropic-ai/sdk";

export interface ScoreInput {
  title?: string;
  text: string;
  projectName?: string;
}

export interface SafetyScore {
  /** 0–10 risk/complexity rating. */
  score: number;
  /** false for acknowledgements/approvals/questions (e.g. "looks good", "go live"). */
  isChangeRequest: boolean;
  reasoning: string;
  factors: string[];
  /** true when the score is a fail-closed fallback (Claude unavailable). */
  degraded?: boolean;
}

export type RawScorerCall = (input: ScoreInput) => Promise<{
  score: unknown;
  isChangeRequest: unknown;
  reasoning: unknown;
  factors: unknown;
}>;

const FAIL_CLOSED: SafetyScore = {
  score: 6,
  isChangeRequest: true,
  reasoning: "Automatic assessment unavailable — routed for admin review.",
  factors: [],
  degraded: true,
};

const SAFETY_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", description: "Risk/complexity 0 (trivial) to 10 (massive/dangerous)." },
    isChangeRequest: {
      type: "boolean",
      description: "true if this asks to change the website; false for acknowledgements, approvals, or questions.",
    },
    reasoning: { type: "string", description: "One or two sentences explaining the score, in plain language." },
    factors: { type: "array", items: { type: "string" }, description: "Short risk factors that pushed the score." },
  },
  required: ["score", "isChangeRequest", "reasoning", "factors"],
} as const;

const SYSTEM_PROMPT = [
  "You rate website change requests submitted by property managers for risk and complexity.",
  "Return a score from 0 to 10:",
  "- 0–3: simple copy, image, or styling tweaks on existing pages.",
  "- 4–5: moderate multi-element changes that are still front-end only.",
  "- 6–10: massive overhauls, complex or multi-page restructures, anything that touches a backend / server / database / API, or anything that touches repository, CI, deploy, or project settings.",
  "Push the score ABOVE 5 for any of: massive overhaul, complex change, touching a backend, or touching repo/CI/deploy/settings.",
  'Also set isChangeRequest=false when the message is not a change request — e.g. approvals or acknowledgements ("looks good", "go live", "approved") or questions. In that case score 0 and leave factors empty.',
  "Be concise. Output only the structured fields.",
].join("\n");

function toScore(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error("scorer returned a non-numeric score");
  }
  return Math.max(0, Math.min(10, Math.round(raw)));
}

const defaultAnthropicCall: RawScorerCall = async (input) => {
  const client = new Anthropic({ maxRetries: 1 });
  const userText = [
    input.projectName ? `Project: ${input.projectName}` : null,
    input.title ? `Title: ${input.title}` : null,
    `Request: ${input.text}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = (await client.messages.create(
    {
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema: SAFETY_SCORE_SCHEMA } },
    } as Anthropic.MessageCreateParams & { output_config: unknown },
    { timeout: 10_000 },
  )) as Anthropic.Message;

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("scorer returned no text block");
  return JSON.parse(textBlock.text) as {
    score: unknown;
    isChangeRequest: unknown;
    reasoning: unknown;
    factors: unknown;
  };
};

export async function scoreChangeRequest(
  input: ScoreInput,
  call: RawScorerCall = defaultAnthropicCall,
): Promise<SafetyScore> {
  try {
    const raw = await call(input);
    const score = toScore(raw.score);
    return {
      score,
      isChangeRequest: Boolean(raw.isChangeRequest),
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
      factors: Array.isArray(raw.factors) ? raw.factors.map((f) => String(f)) : [],
    };
  } catch {
    return { ...FAIL_CLOSED };
  }
}
