import { gitHubApiBase, ghFetch } from "./github-fetch.js";

export function parseGitHubRepo(
  repoUrl: string,
): { owner: string; repo: string; hostname: string } | null {
  if (!repoUrl) return null;
  const ssh = repoUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { hostname: ssh[1], owner: ssh[2], repo: ssh[3] };
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/");
    if (parts.length < 2) return null;
    return { hostname: u.hostname, owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

type DeployState = "success" | "pending" | "failure" | "none";

export async function getLatestProductionDeployStatus(args: {
  repoUrl: string;
  token: string;
  sinceIso: string;
}): Promise<DeployState> {
  const parsed = parseGitHubRepo(args.repoUrl);
  if (!parsed) return "none";
  const base = gitHubApiBase(parsed.hostname);
  const headers = {
    Authorization: `token ${args.token}`,
    Accept: "application/vnd.github+json",
  };
  const listRes = await ghFetch(
    `${base}/repos/${parsed.owner}/${parsed.repo}/deployments?per_page=30`,
    { headers },
  );
  if (!listRes.ok) return "pending";
  const deployments = (await listRes.json()) as Array<{ id: number; created_at: string; environment: string }>;
  const since = new Date(args.sinceIso).getTime();
  const recent = deployments
    .filter((d) => d.environment?.toLowerCase() === "production" && new Date(d.created_at).getTime() >= since - 60_000)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  if (!recent) return "none";

  const statusRes = await ghFetch(
    `${base}/repos/${parsed.owner}/${parsed.repo}/deployments/${recent.id}/statuses?per_page=1`,
    { headers },
  );
  if (!statusRes.ok) return "pending";
  const statuses = (await statusRes.json()) as Array<{ state: string }>;
  const state = statuses[0]?.state;
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  return "pending";
}
