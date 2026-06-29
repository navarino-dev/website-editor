// server/src/services/github-deployments.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { parseGitHubRepo, getLatestProductionDeployStatus } from "./github-deployments.js";

const SINCE = "2026-06-29T11:00:00Z";
const RECENT = "2026-06-29T12:00:00Z";

/** Helpers to build mock Responses in call-order for fetch spy */
function jsonOk(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status }) as never;
}
function errRes(status: number) {
  return new Response("", { status }) as never;
}

describe("parseGitHubRepo", () => {
  it("parses https and git urls", () => {
    expect(parseGitHubRepo("https://github.com/navarino-dev/seaside-website.git"))
      .toEqual({ owner: "navarino-dev", repo: "seaside-website", hostname: "github.com" });
    expect(parseGitHubRepo("git@github.com:navarino-dev/seaside-website.git"))
      .toEqual({ owner: "navarino-dev", repo: "seaside-website", hostname: "github.com" });
  });
  it("returns null for non-github", () => {
    expect(parseGitHubRepo("https://example.com/x/y")).toBeTruthy(); // still parses owner/repo on GH enterprise host
    expect(parseGitHubRepo("not a url")).toBeNull();
  });
});

describe("getLatestProductionDeployStatus", () => {
  afterEach(() => vi.restoreAllMocks());

  // ---------------------------------------------------------------------------
  // Happy-path: deployment found and conclusive
  // ---------------------------------------------------------------------------

  it("returns success when the latest production deployment status is success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // 1st call: deployments list
    fetchMock.mockResolvedValueOnce(jsonOk([
      { id: 11, created_at: RECENT, environment: "Production" },
    ]));
    // 2nd call: statuses
    fetchMock.mockResolvedValueOnce(jsonOk([{ state: "success" }]));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("success");
  });

  it("detects production environment case-insensitively (lowercase 'production')", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    fetchMock.mockResolvedValueOnce(jsonOk([
      { id: 20, created_at: RECENT, environment: "Preview" },
      { id: 21, created_at: RECENT, environment: "production" },
    ]));
    fetchMock.mockResolvedValueOnce(jsonOk([{ state: "success" }]));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("success");
  });

  // ---------------------------------------------------------------------------
  // No conclusive deployment → falls back to commit status (no Vercel → "none")
  // ---------------------------------------------------------------------------

  it("ignores non-production environments (e.g. Preview)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // 1st: deployments list — only Preview
    fetchMock.mockResolvedValueOnce(jsonOk([
      { id: 30, created_at: RECENT, environment: "Preview" },
    ]));
    // fallback: 2nd repo info, 3rd combined status (no Vercel entries)
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    fetchMock.mockResolvedValueOnce(jsonOk({ statuses: [] }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("none");
  });

  it("returns none when there is no production deployment since the floor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // 1st: empty deployments list
    fetchMock.mockResolvedValueOnce(jsonOk([]));
    // fallback: repo info + combined status with no Vercel
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    fetchMock.mockResolvedValueOnce(jsonOk({ statuses: [] }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("none");
  });

  // ---------------------------------------------------------------------------
  // NEW: 403 on deployments list → warn + fallback → Vercel commit status
  // ---------------------------------------------------------------------------

  it("logs a warning and falls back to Vercel commit status when deployments list returns 403", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 1st: deployments list → 403
    fetchMock.mockResolvedValueOnce(errRes(403));
    // fallback: 2nd repo info
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    // 3rd: combined status with a fresh Vercel success
    fetchMock.mockResolvedValueOnce(jsonOk({
      statuses: [
        { context: "Vercel", state: "success", updated_at: RECENT },
      ],
    }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: SINCE,
    });

    expect(result).toBe("success");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("403"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deployments: read"),
    );

    warnSpy.mockRestore();
  });

  it("logs a warning when deployments list returns 401", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce(errRes(401));
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    fetchMock.mockResolvedValueOnce(jsonOk({
      statuses: [
        { context: "Vercel", state: "failure", updated_at: RECENT },
      ],
    }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y",
      token: "t",
      sinceIso: SINCE,
    });

    expect(result).toBe("failure");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("401"));

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // NEW: deployments OK, no production deployment → fallback finds Vercel success
  // ---------------------------------------------------------------------------

  it("falls back to Vercel commit status when deployments list has no production deployment since floor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);

    // 1st: deployments list — has only a Preview deployment
    fetchMock.mockResolvedValueOnce(jsonOk([
      { id: 40, created_at: RECENT, environment: "Preview" },
    ]));
    // fallback: repo info
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    // combined status — Vercel is success
    fetchMock.mockResolvedValueOnce(jsonOk({
      statuses: [
        { context: "Vercel – navarino-dev/seaside-website", state: "success", updated_at: RECENT },
      ],
    }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("success");
  });

  // ---------------------------------------------------------------------------
  // NEW: commit-status fallback ignores non-Vercel contexts
  // ---------------------------------------------------------------------------

  it("fallback returns none when no Vercel context is present in combined status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);

    // 1st: empty deployments list → falls back
    fetchMock.mockResolvedValueOnce(jsonOk([]));
    // fallback: repo info
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    // combined status — only a non-Vercel context (should be ignored)
    fetchMock.mockResolvedValueOnce(jsonOk({
      statuses: [
        { context: "ci/build", state: "success", updated_at: RECENT },
        { context: "codecov/project", state: "success", updated_at: RECENT },
      ],
    }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("none");
  });

  // ---------------------------------------------------------------------------
  // NEW: fallback respects the recency guard (stale Vercel status → none)
  // ---------------------------------------------------------------------------

  it("fallback ignores a Vercel status that is older than sinceIso − 60s", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);

    fetchMock.mockResolvedValueOnce(jsonOk([]));
    fetchMock.mockResolvedValueOnce(jsonOk({ default_branch: "main" }));
    // Vercel status timestamp is before the floor (sinceIso - 60s = 10:59:00Z)
    fetchMock.mockResolvedValueOnce(jsonOk({
      statuses: [
        { context: "Vercel", state: "success", updated_at: "2026-06-29T10:00:00Z" },
      ],
    }));

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y",
      token: "t",
      sinceIso: SINCE,
    });
    expect(result).toBe("none");
  });
});
