// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockEnvironmentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
}));

vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("./EnvVarEditor", () => ({
  EnvVarEditor: () => <div />,
}));
vi.mock("./PathInstructionsModal", () => ({
  ChoosePathButton: () => null,
}));
vi.mock("./InlineEditor", () => ({
  InlineEditor: () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "@/components/ui/tooltip";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Test Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    productionUrl: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "~/.paperclip/managed",
      effectiveLocalFolder: "~/.paperclip/managed",
      origin: "local_folder",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("ProjectProperties", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    mockGoalsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    mockSecretsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  async function renderComponent(
    project: Project,
    onFieldUpdate: (field: string, data: Record<string, unknown>) => void,
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const currentRoot = createRoot(container);
    root = currentRoot;
    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ProjectProperties
              project={project}
              onFieldUpdate={onFieldUpdate as Parameters<typeof ProjectProperties>[0]["onFieldUpdate"]}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("fires onFieldUpdate with productionUrl when Live website URL is edited", async () => {
    const onFieldUpdate = vi.fn();
    await renderComponent(makeProject(), onFieldUpdate);

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://example.com"]',
    );
    expect(input, "Live website URL input should be rendered").not.toBeNull();

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      nativeSetter?.call(input!, "https://seasidehoa.com");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onFieldUpdate).toHaveBeenCalledWith("productionUrl", {
      productionUrl: "https://seasidehoa.com",
    });
  });
});
