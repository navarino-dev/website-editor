import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Check, Loader2, ArrowUpRight, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";

const LIVE_RE = /LIVE_URL:\s*(https?:\/\/\S+)/im;
const SNAG_RE = /hit a snag publishing|hit a snag while publishing|hit a snag/i;
const DEPLOYING_RE = /Publishing your change now/i;
const DELAYED_RE = /taking a little longer than usual/i;

type Phase = "preparing" | "deploying" | "delayed" | "live" | "failed";

function derivePhase(
  comments: Array<{ body: string; createdAt: string | Date }> | undefined,
  sinceMs: number,
): { phase: Phase; liveUrl: string | null } {
  if (!comments) return { phase: "preparing", liveUrl: null };
  // Only consider comments from around when the manager approved, so a live
  // link from a previous publish can't make a new one look already-done.
  const fresh = comments.filter((c) => new Date(c.createdAt).getTime() >= sinceMs - 15_000);
  for (const c of fresh) {
    const live = c.body.match(LIVE_RE);
    if (live) return { phase: "live", liveUrl: live[1] };
  }
  if (fresh.some((c) => SNAG_RE.test(c.body))) return { phase: "failed", liveUrl: null };
  if (fresh.some((c) => DELAYED_RE.test(c.body))) return { phase: "delayed", liveUrl: null };
  if (fresh.some((c) => DEPLOYING_RE.test(c.body))) return { phase: "deploying", liveUrl: null };
  return { phase: "preparing", liveUrl: null };
}

const PERCENT: Record<Phase, number> = {
  preparing: 22,
  deploying: 66,
  delayed: 80,
  live: 100,
  failed: 100,
};

function StepRow({
  label,
  state,
}: {
  label: string;
  state: "done" | "active" | "pending" | "failed";
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
          state === "done" && "border-transparent bg-emerald-500 text-white",
          state === "active" && "border-primary/40 bg-primary/10 text-primary",
          state === "pending" && "border-border text-transparent",
          state === "failed" && "border-transparent bg-destructive text-white",
        )}
      >
        {state === "done" ? (
          <Check className="h-3.5 w-3.5" />
        ) : state === "active" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : state === "failed" ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-border" />
        )}
      </span>
      <span
        className={cn(
          "text-[15px]",
          state === "pending" ? "text-muted-foreground/60" : "text-foreground",
          state === "active" && "font-medium",
        )}
      >
        {label}
      </span>
    </div>
  );
}

export function PublishingProgressDialog({
  open,
  onOpenChange,
  issueId,
  sinceMs,
  fallbackUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueId: string;
  sinceMs: number;
  fallbackUrl?: string | null;
}) {
  const { data } = useQuery({
    queryKey: [...queryKeys.issues.comments(issueId), "publish-progress"],
    queryFn: () => issuesApi.listComments(issueId, { order: "desc", limit: 20 }),
    enabled: open,
    refetchInterval: (query) => {
      const result = query.state.data as Array<{ body: string; createdAt: string }> | undefined;
      const { phase } = derivePhase(result, sinceMs);
      return phase === "live" || phase === "failed" ? false : 4000;
    },
  });

  const { phase, liveUrl } = useMemo(() => derivePhase(data, sinceMs), [data, sinceMs]);
  const percent = PERCENT[phase];
  const inProgress = phase !== "live" && phase !== "failed";
  const url = liveUrl ?? fallbackUrl ?? null;

  const publishingState: "done" | "active" | "pending" | "failed" =
    phase === "live" ? "done" : phase === "failed" ? "failed" : "active";
  const liveState: "done" | "active" | "pending" | "failed" =
    phase === "live" ? "done" : phase === "failed" ? "failed" : "pending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="pm-view max-w-md rounded-2xl border-border"
        showCloseButton={!inProgress}
      >
        <DialogTitle className="pm-display text-[1.4rem] leading-tight text-foreground">
          {phase === "live"
            ? "Your change is live 🎉"
            : phase === "failed"
              ? "This is taking a little longer"
              : "Publishing your change"}
        </DialogTitle>

        <p className="-mt-1 text-[14px] leading-6 text-muted-foreground">
          {phase === "live"
            ? "It's now live on your website for everyone to see."
            : phase === "failed"
              ? "Our team has been notified and is getting it live. You can close this — we'll post the link here as soon as it's up."
              : "Hang tight while we publish this to your live website. This usually takes a couple of minutes."}
        </p>

        {/* Progress bar */}
        <div className="mt-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-700 ease-out",
                phase === "failed"
                  ? "bg-destructive"
                  : phase === "live"
                    ? "bg-emerald-500"
                    : "pm-progress-active bg-primary",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {/* Steps */}
        <div className="mt-2 flex flex-col gap-3">
          <StepRow label="Approved" state="done" />
          <StepRow label="Publishing to your website" state={publishingState} />
          <StepRow label="Live on your site" state={liveState} />
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center justify-end gap-2">
          {phase === "live" && url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-all duration-200 hover:shadow-md hover:brightness-[1.06] active:scale-[0.98]"
            >
              View your website
              <ArrowUpRight className="h-4 w-4" />
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={cn(
              "rounded-full px-4 py-2.5 text-sm font-medium transition-colors duration-200",
              phase === "live"
                ? "text-muted-foreground hover:text-foreground"
                : "border border-border bg-card text-foreground hover:bg-secondary",
            )}
          >
            {phase === "live" ? "Done" : inProgress ? "Hide" : "Close"}
          </button>
        </div>

        {inProgress ? (
          <p className="text-center text-[12px] text-muted-foreground/70">
            You can keep working — we'll post the live link in the conversation too.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
