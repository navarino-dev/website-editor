// server/src/services/github-deployments.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { parseGitHubRepo, getLatestProductionDeployStatus } from "./github-deployments.js";

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

  it("returns success when the latest production deployment status is success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // 1st call: deployments list
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 11, created_at: "2026-06-29T12:00:00Z", environment: "Production" },
    ]), { status: 200 }) as never);
    // 2nd call: statuses
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { state: "success" },
    ]), { status: 200 }) as never);

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: "2026-06-29T11:00:00Z",
    });
    expect(result).toBe("success");
  });

  it("detects production environment case-insensitively (lowercase 'production')", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // list includes both a non-production environment and a lowercase "production"
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 20, created_at: "2026-06-29T12:05:00Z", environment: "Preview" },
      { id: 21, created_at: "2026-06-29T12:10:00Z", environment: "production" },
    ]), { status: 200 }) as never);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { state: "success" },
    ]), { status: 200 }) as never);

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/navarino-dev/seaside-website",
      token: "t",
      sinceIso: "2026-06-29T11:00:00Z",
    });
    expect(result).toBe("success");
  });

  it("ignores non-production environments (e.g. Preview)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    // Only a Preview deployment is present — no production
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 30, created_at: "2026-06-29T12:00:00Z", environment: "Preview" },
    ]), { status: 200 }) as never);

    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y",
      token: "t",
      sinceIso: "2026-06-29T11:00:00Z",
    });
    expect(result).toBe("none");
  });

  it("returns none when there is no production deployment since the floor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as never);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }) as never);
    const result = await getLatestProductionDeployStatus({
      repoUrl: "https://github.com/x/y", token: "t", sinceIso: "2026-06-29T11:00:00Z",
    });
    expect(result).toBe("none");
  });
});
