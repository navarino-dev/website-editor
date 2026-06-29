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

async function fallbackToVercelCommitStatus(args: {
  base: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  sinceIso: string;
}): Promise<DeployState> {
  const { base, owner, repo, headers, sinceIso } = args;
  const floorMs = new Date(sinceIso).getTime() - 60_000;

  // Resolve default branch
  let defaultBranch = "main";
  try {
    const repoRes = await ghFetch(`${base}/repos/${owner}/${repo}`, { headers });
    if (repoRes.ok) {
      const repoData = (await repoRes.json()) as { default_branch?: string };
      if (repoData.default_branch) defaultBranch = repoData.default_branch;
    }
  } catch {
    // Stick with "main"
  }

  // Get combined commit status
  let statusRes: Response;
  try {
    statusRes = await ghFetch(
      `${base}/repos/${owner}/${repo}/commits/${defaultBranch}/status`,
      { headers },
    );
  } catch {
    return "none";
  }

  if (!statusRes.ok) {
    if (statusRes.status === 401 || statusRes.status === 403) {
      console.warn(
        `[deployment-watch] GitHub commit status API returned ${statusRes.status} for ${owner}/${repo} — the token may lack read access.`,
      );
      return "pending";
    }
    return "none";
  }

  const combined = (await statusRes.json()) as {
    statuses: Array<{
      context: string;
      state: string;
      updated_at?: string;
      created_at?: string;
    }>;
  };

  // Find the first (most recent) Vercel status entry that passes the recency guard
  for (const s of combined.statuses) {
    if (!/vercel/i.test(s.context)) continue;
    const ts = s.updated_at ?? s.created_at;
    if (ts && new Date(ts).getTime() < floorMs) continue;
    // Accept this entry
    if (s.state === "success") return "success";
    if (s.state === "failure" || s.state === "error") return "failure";
    return "pending";
  }

  return "none";
}

export async function getLatestProductionDeployStatus(args: {
  repoUrl: string;
  token: string;
  sinceIso: string;
}): Promise<DeployState> {
  try {
    const parsed = parseGitHubRepo(args.repoUrl);
    if (!parsed) return "none";
    const base = gitHubApiBase(parsed.hostname);
    const headers = {
      Authorization: `token ${args.token}`,
      Accept: "application/vnd.github+json",
    };
    const { owner, repo } = parsed;

    const listRes = await ghFetch(
      `${base}/repos/${owner}/${repo}/deployments?per_page=30`,
      { headers },
    );

    if (!listRes.ok) {
      if (listRes.status === 401 || listRes.status === 403) {
        console.warn(
          `[deployment-watch] GitHub deployments API returned ${listRes.status} for ${owner}/${repo} — the token likely lacks 'Deployments: read'; falling back to commit status.`,
        );
      } else {
        console.warn(
          `[deployment-watch] GitHub deployments API returned ${listRes.status} for ${owner}/${repo}; falling back to commit status.`,
        );
      }
      return fallbackToVercelCommitStatus({ base, owner, repo, headers, sinceIso: args.sinceIso });
    }

    const deployments = (await listRes.json()) as Array<{
      id: number;
      created_at: string;
      environment: string;
    }>;
    const since = new Date(args.sinceIso).getTime();
    const recent = deployments
      .filter(
        (d) =>
          d.environment?.toLowerCase() === "production" &&
          new Date(d.created_at).getTime() >= since - 60_000,
      )
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (!recent) {
      return fallbackToVercelCommitStatus({ base, owner, repo, headers, sinceIso: args.sinceIso });
    }

    const statusRes = await ghFetch(
      `${base}/repos/${owner}/${repo}/deployments/${recent.id}/statuses?per_page=1`,
      { headers },
    );
    if (!statusRes.ok) {
      return fallbackToVercelCommitStatus({ base, owner, repo, headers, sinceIso: args.sinceIso });
    }
    const statuses = (await statusRes.json()) as Array<{ state: string }>;
    const state = statuses[0]?.state;
    if (state === "success") return "success";
    if (state === "failure" || state === "error") return "failure";
    // Pending or unknown deployment state — fall through to commit-status
    return fallbackToVercelCommitStatus({ base, owner, repo, headers, sinceIso: args.sinceIso });
  } catch (err) {
    console.warn("[deployment-watch] Unexpected error in getLatestProductionDeployStatus:", err);
    return "pending";
  }
}
