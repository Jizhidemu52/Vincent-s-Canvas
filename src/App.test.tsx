import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createInitialWorkspace, type GenerationRequest, type HistoryEntry, type ModelDefinition, type Profile, type Workspace } from "./domain/workspace";
import type { AdminAuditEntry, ProviderHealth } from "./services/modelApi";

let backendProfile: Profile = {
  userId: "designer-lina",
  designerName: "Lina Zhou",
  role: "designer" as const,
  creditBalance: 180,
  creditUsed: 0,
  credits: 180
};
let backendHistory: HistoryEntry[] = [];
let backendWorkspace: Workspace = createInitialWorkspace();
let backendAdminAudit: AdminAuditEntry[] = [];
let backendAdminHistory: HistoryEntry[] = [];
let backendAdminUsage: {
  totalCreditsUsed: number;
  totalHistoryEntries: number;
  totalPriceCents?: number;
  currency?: "CNY" | "USD";
  totalCreditsAllocated: number;
  totalCreditsRemoved: number;
  creditAdjustments: Array<{
    id: string;
    actorUserId?: string;
    targetUserId: string;
    creditDelta: number;
    creditBalance?: number;
    summary: string;
    createdAt: string;
  }>;
  modelUsage: Array<{ modelId: string; count: number; credits: number; priceCents?: number; currency?: "CNY" | "USD" }>;
};
let backendAdminJobs: Array<Record<string, unknown>> = [];
let backendAccounts: Array<{
  userId: string;
  designerName: string;
  role: Profile["role"];
  creditBalance: number;
  creditUsed: number;
  credits: number;
  creditLimit?: number;
  projectCount: number;
  historyCount: number;
  assetCount: number;
  lastActivityAt?: string;
}> = [];
let backendProviderHealth: ProviderHealth[] = [];

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    })
  );
}

beforeEach(() => {
  backendProfile = {
    userId: "designer-lina",
    designerName: "Lina Zhou",
    role: "designer",
    creditBalance: 180,
    creditUsed: 0,
    credits: 180
  };
  backendHistory = [];
  backendWorkspace = {
    ...createInitialWorkspace({ userId: "designer-lina", designerName: "Lina Zhou", creditBalance: 180, role: "designer" }),
    history: backendHistory
  };
  backendAdminHistory = [
    {
      id: "history-alice-team-1",
      projectId: "alice-campaign",
      projectName: "Alice campaign",
      nodeId: "alice-node-1",
      prompt: "Alice campaign cleanup",
      modelId: "gpt-image-2-medium",
      outputCount: 2,
      creditCost: 14,
      operation: "generate",
      referenceCount: 1,
      userId: "alice@company.local",
      designerName: "Alice Designer",
      createdAt: "2026-06-28T02:10:00.000Z",
      outputs: [
        { name: "alice-cleanup-1.jpg", source: "/fixtures/alice-cleanup-1.jpg", width: 1024, height: 1024 },
        { name: "alice-cleanup-2.jpg", source: "/fixtures/alice-cleanup-2.jpg", width: 1024, height: 1024 }
      ]
    },
    {
      id: "history-bob-team-1",
      projectId: "bob-upscale",
      projectName: "Bob upscale",
      nodeId: "bob-node-1",
      prompt: "Bob upscale pass",
      modelId: "upscale-pro",
      outputCount: 1,
      creditCost: 4,
      operation: "upscale",
      referenceCount: 1,
      userId: "bob@company.local",
      designerName: "Bob Designer",
      createdAt: "2026-06-28T02:05:00.000Z",
      outputs: [{ name: "bob-upscale-1.jpg", source: "/fixtures/bob-upscale-1.jpg", width: 1024, height: 1024 }]
    }
  ];
  backendAdminAudit = [
    {
      id: "audit-alice-1",
      projectId: "alice-campaign",
      nodeId: "alice-node-1",
      prompt: "Alice campaign cleanup",
      modelId: "gpt-image-2-medium",
      outputCount: 2,
      creditCost: 14,
      priceCents: 620,
      currency: "CNY",
      eventType: "generation",
      operation: "generate",
      referenceCount: 1,
      userId: "alice@company.local",
      actorUserId: "alice@company.local",
      designerName: "Alice Designer",
      projectName: "Alice campaign",
      summary: "Alice Designer generated 2 outputs with gpt-image-2-medium",
      createdAt: "2026-06-28T02:10:00.000Z"
    },
    {
      id: "audit-bob-1",
      projectId: "bob-upscale",
      nodeId: "bob-node-1",
      prompt: "Bob upscale pass",
      modelId: "upscale-pro",
      outputCount: 1,
      creditCost: 4,
      eventType: "generation",
      operation: "upscale",
      referenceCount: 1,
      userId: "bob@company.local",
      actorUserId: "bob@company.local",
      designerName: "Bob Designer",
      projectName: "Bob upscale",
      summary: "Bob Designer generated 1 output with upscale-pro",
      createdAt: "2026-06-28T02:05:00.000Z"
    }
  ];
  backendAdminUsage = {
    totalCreditsUsed: 24,
    totalHistoryEntries: 3,
    totalPriceCents: 860,
    currency: "CNY",
    totalCreditsAllocated: 55,
    totalCreditsRemoved: 5,
    creditAdjustments: [
      {
        id: "admin-credit-alice-return",
        actorUserId: "admin@company.local",
        targetUserId: "alice@company.local",
        creditDelta: -5,
        creditBalance: 35,
        summary: "Adjusted alice@company.local by -5 credits: returned unused credits",
        createdAt: "2026-06-28T02:25:00.000Z"
      },
      {
        id: "admin-credit-bob-rush",
        actorUserId: "admin@company.local",
        targetUserId: "bob@company.local",
        creditDelta: 15,
        creditBalance: 15,
        summary: "Adjusted bob@company.local by 15 credits: rush campaign",
        createdAt: "2026-06-28T02:20:00.000Z"
      }
    ],
    modelUsage: [
      { modelId: "gpt-image-2-medium", count: 2, credits: 14, priceCents: 620, currency: "CNY" },
      { modelId: "upscale-pro", count: 1, credits: 4, priceCents: 240, currency: "CNY" }
    ]
  };
  backendAdminJobs = [
    {
      id: "job-history-alice-1",
      historyId: "audit-alice-1",
      userId: "alice@company.local",
      designerName: "Alice Designer",
      projectId: "alice-campaign",
      projectName: "Alice campaign",
      nodeId: "alice-node-1",
      modelId: "gpt-image-2-medium",
      operation: "generate",
      status: "succeeded",
      outputCount: 2,
      creditCost: 14,
      priceCents: 620,
      currency: "CNY",
      referenceCount: 1,
      outputs: [
        { name: "alice-job-cleanup-1.jpg", source: "/fixtures/alice-job-cleanup-1.jpg", width: 1024, height: 1024 },
        { name: "alice-job-cleanup-2.jpg", source: "/fixtures/alice-job-cleanup-2.jpg", width: 1024, height: 1024 }
      ],
      createdAt: "2026-06-28T02:10:00.000Z"
    },
    {
      id: "job-history-bob-1",
      historyId: "audit-bob-1",
      userId: "bob@company.local",
      designerName: "Bob Designer",
      projectId: "bob-upscale",
      projectName: "Bob upscale",
      nodeId: "bob-node-1",
      modelId: "upscale-pro",
      operation: "upscale",
      status: "succeeded",
      outputCount: 1,
      creditCost: 4,
      priceCents: 240,
      currency: "CNY",
      referenceCount: 1,
      createdAt: "2026-06-28T02:05:00.000Z"
    },
    {
      id: "job-history-cara-failed-1",
      historyId: "history-cara-failed-1",
      userId: "cara@company.local",
      designerName: "Cara Designer",
      projectId: "cara-provider",
      projectName: "Cara provider test",
      nodeId: "cara-node-1",
      modelId: "broken-provider-model",
      operation: "generate",
      status: "failed",
      outputCount: 1,
      creditCost: 0,
      referenceCount: 1,
      errorMessage: "Provider adapter not configured for retired-provider",
      createdAt: "2026-06-28T02:00:00.000Z",
      updatedAt: "2026-06-28T02:00:00.000Z"
    }
  ];
  backendAccounts = [
    {
      userId: "admin@company.local",
      designerName: "Admin Ops",
      role: "admin",
      creditBalance: 180,
      creditUsed: 0,
      credits: 180,
      projectCount: 0,
      historyCount: 0,
      assetCount: 0
    },
    {
      userId: "alice@company.local",
      designerName: "Alice Designer",
      role: "designer",
      creditBalance: 88,
      creditUsed: 12,
      credits: 88,
      creditLimit: 120,
      projectCount: 2,
      historyCount: 5,
      assetCount: 7,
      lastActivityAt: "2026-06-28T02:00:00.000Z"
    }
  ];
  backendProviderHealth = [
    {
      provider: "openai",
      status: "degraded",
      modelCount: 1,
      keyLocation: "server",
      mode: "mock",
      secretConfigured: false,
      adapterId: "openai-image-adapter",
      requiredSecrets: ["OPENAI_API_KEY"],
      configuredSecrets: [],
      missingSecrets: ["OPENAI_API_KEY"],
      supportedOperations: ["generate", "edit"]
    },
    {
      provider: "internal",
      status: "healthy",
      modelCount: 2,
      keyLocation: "server",
      mode: "live-ready",
      secretConfigured: true,
      adapterId: "internal-operations-adapter",
      requiredSecrets: [],
      configuredSecrets: [],
      missingSecrets: [],
      supportedOperations: ["upscale", "removeBackground"]
    }
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/prompts")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const userId = headers?.["x-user-id"] ?? backendProfile.userId;
        if (init?.method === "POST") {
          const request = JSON.parse(String(init?.body)) as { title?: string; prompt: string; tags?: string[] };
          const savedPrompt = {
            id: `prompt-backend-${backendWorkspace.prompts.length + 1}`,
            title: request.title ?? "Saved prompt",
            prompt: request.prompt,
            tags: Array.from(new Set((request.tags ?? ["designer"]).map((tag) => tag.toLowerCase()))),
            source: "designer" as const,
            userId,
            designerName: userId.includes("admin") ? "Admin Ops" : backendProfile.designerName,
            createdAt: "2026-06-28T10:00:00.000Z"
          };
          backendWorkspace = { ...backendWorkspace, prompts: [savedPrompt, ...backendWorkspace.prompts] };
          return jsonResponse(savedPrompt);
        }
        return jsonResponse(backendWorkspace.prompts);
      }
      if (url.includes("/api/prompts/") && init?.method === "DELETE") {
        const promptId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        backendWorkspace = { ...backendWorkspace, prompts: backendWorkspace.prompts.filter((prompt) => prompt.id !== promptId) };
        return jsonResponse(backendWorkspace.prompts);
      }
      if (url.endsWith("/api/workspace")) {
        if (init?.method === "POST") {
          const snapshot = JSON.parse(String(init.body)) as Workspace;
          const incomingProfile = snapshot.profile ?? backendWorkspace.profile;
          backendWorkspace = {
            ...backendWorkspace,
            ...snapshot,
            profile: {
              ...backendProfile,
              userId: incomingProfile.userId,
              designerName: incomingProfile.designerName,
              role: incomingProfile.role
            },
            history: snapshot.history ?? backendHistory
          };
          backendProfile = backendWorkspace.profile;
          backendHistory = backendWorkspace.history;
        }
        return jsonResponse({
          profile: backendProfile,
          projects: backendWorkspace.projects,
          activeProjectId: backendWorkspace.activeProjectId,
          history: backendHistory,
          assets: backendWorkspace.assets,
          prompts: backendWorkspace.prompts,
          modelRegistry: backendWorkspace.modelRegistry
        });
      }
      if (url.endsWith("/api/admin/credits")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { targetUserId: string; delta: number; reason?: string };
        const nextBalance = backendProfile.creditBalance + Number(request.delta);
        if (!Number.isInteger(Number(request.delta)) || Number(request.delta) === 0 || nextBalance < 0) {
          return jsonResponse({ status: "failed", errorMessage: "Credit balance cannot be negative" }, 400);
        }
        backendProfile = {
          ...backendProfile,
          userId: request.targetUserId,
          designerName: request.targetUserId.includes("admin") ? "Admin Ops" : request.targetUserId.split("@")[0],
          role: request.targetUserId.includes("admin") ? "admin" : "designer",
          creditBalance: nextBalance,
          credits: nextBalance
        };
        backendWorkspace = { ...backendWorkspace, profile: backendProfile };
        backendAdminAudit = [
          {
            id: `admin-credit-${backendAdminAudit.length + 1}`,
            eventType: "credit-adjustment",
            actorUserId: adminUserId,
            targetUserId: request.targetUserId,
            prompt: `Credit adjustment ${request.delta}: ${request.reason ?? ""}`,
            summary: `Adjusted ${request.targetUserId} by ${request.delta} credits`,
            projectId: "admin",
            nodeId: "admin-credit",
            modelId: "admin",
            outputCount: 0,
            creditCost: 0,
            createdAt: new Date().toISOString()
          } as HistoryEntry,
          ...backendAdminAudit
        ];
        return jsonResponse(backendProfile);
      }
      if (url.endsWith("/api/admin/credit-limit")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { targetUserId: string; creditLimit: number; reason?: string };
        const limit = Number(request.creditLimit);
        backendProfile = {
          ...backendProfile,
          userId: request.targetUserId,
          designerName: request.targetUserId.includes("admin") ? "Admin Ops" : request.targetUserId.split("@")[0],
          role: request.targetUserId.includes("admin") ? "admin" : "designer",
          creditBalance: Math.min(backendProfile.creditBalance, limit),
          credits: Math.min(backendProfile.creditBalance, limit),
          creditLimit: limit
        };
        backendWorkspace = { ...backendWorkspace, profile: backendProfile };
        backendAdminAudit = [
          {
            id: `admin-limit-${backendAdminAudit.length + 1}`,
            eventType: "credit-limit",
            actorUserId: adminUserId,
            targetUserId: request.targetUserId,
            prompt: `Credit limit set to ${limit}: ${request.reason ?? ""}`,
            summary: `Set ${request.targetUserId} limit to ${limit}`,
            projectId: "admin",
            nodeId: "admin-limit",
            modelId: "admin",
            outputCount: 0,
            creditCost: 0,
            createdAt: new Date().toISOString()
          } as HistoryEntry,
          ...backendAdminAudit
        ];
        return jsonResponse(backendProfile);
      }
      if (url.endsWith("/api/admin/model-pricing")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { modelId: string; cost: number; priceCents?: number; currency?: "CNY" | "USD" };
        const current = backendWorkspace.modelRegistry.find((model) => model.id === request.modelId);
        const updated = {
          ...(current ?? { id: request.modelId, name: request.modelId, provider: "internal", group: "Image", capability: ["generate"] }),
          cost: request.cost,
          priceCents: request.priceCents,
          currency: request.currency
        };
        backendWorkspace = {
          ...backendWorkspace,
          modelRegistry: backendWorkspace.modelRegistry.map((model) => (model.id === request.modelId ? updated : model))
        } as Workspace;
        backendAdminAudit = [
          {
            id: `admin-pricing-${backendAdminAudit.length + 1}`,
            eventType: "model-pricing",
            actorUserId: adminUserId,
            prompt: `${request.modelId} now costs ${request.cost} credits`,
            summary: `${request.modelId} pricing set to ${request.cost} credits`,
            projectId: "admin",
            nodeId: "admin-pricing",
            modelId: request.modelId,
            outputCount: 0,
            creditCost: request.cost,
            createdAt: new Date().toISOString()
          } as HistoryEntry,
          ...backendAdminAudit
        ];
        return jsonResponse(updated);
      }
      if (url.endsWith("/api/admin/models")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as {
          modelId: string;
          name: string;
          provider: ModelDefinition["provider"];
          group: ModelDefinition["group"];
          capability: ModelDefinition["capability"];
          cost: number;
          priceCents?: number;
          currency?: "CNY" | "USD";
        };
        if (!request.capability.length) {
          return jsonResponse({ status: "failed", errorMessage: "Model capability must contain supported operations" }, 400);
        }
        const registered: ModelDefinition = {
          id: request.modelId,
          name: request.name,
          provider: request.provider,
          group: request.group,
          capability: request.capability,
          cost: request.cost,
          priceCents: request.priceCents,
          currency: request.currency
        };
        backendWorkspace = {
          ...backendWorkspace,
          modelRegistry: backendWorkspace.modelRegistry.some((model) => model.id === registered.id)
            ? backendWorkspace.modelRegistry.map((model) => (model.id === registered.id ? registered : model))
            : [...backendWorkspace.modelRegistry, registered]
        };
        backendAdminAudit = [
          {
            id: `admin-model-${backendAdminAudit.length + 1}`,
            eventType: "model-registry",
            actorUserId: adminUserId,
            provider: request.provider,
            prompt: `${request.modelId} registered for ${request.provider}`,
            summary: `${request.modelId} registered for ${request.provider}`,
            projectId: "admin",
            nodeId: "admin-model",
            modelId: request.modelId,
            outputCount: 0,
            creditCost: request.cost,
            createdAt: new Date().toISOString()
          } as HistoryEntry,
          ...backendAdminAudit
        ];
        backendProviderHealth = backendProviderHealth.map((provider) =>
          provider.provider === request.provider ? { ...provider, modelCount: provider.modelCount + 1 } : provider
        );
        return jsonResponse(registered);
      }
      if (url.endsWith("/api/admin/provider-settings")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as {
          provider: ModelDefinition["provider"];
          mode: "mock" | "live-ready";
          endpointUrl?: string;
          secretName?: string;
          secretValue?: string;
        };
        const configured: ProviderHealth = {
          provider: request.provider,
          status: "healthy",
          modelCount: backendProviderHealth.find((provider) => provider.provider === request.provider)?.modelCount ?? 0,
          keyLocation: "server",
          mode: request.mode,
          endpointUrl: request.endpointUrl,
          secretConfigured: Boolean(request.secretValue),
          adapterId: `${request.provider}-adapter`,
          requiredSecrets: request.secretName ? [request.secretName] : [],
          configuredSecrets: request.secretName && request.secretValue ? [request.secretName] : [],
          missingSecrets: request.secretName && request.secretValue ? [] : request.secretName ? [request.secretName] : [],
          supportedOperations: ["generate", "edit"]
        };
        backendProviderHealth = backendProviderHealth.some((provider) => provider.provider === request.provider)
          ? backendProviderHealth.map((provider) => (provider.provider === request.provider ? configured : provider))
          : [...backendProviderHealth, configured];
        backendAdminAudit = [
          {
            id: `admin-provider-${backendAdminAudit.length + 1}`,
            eventType: "provider-settings",
            actorUserId: adminUserId,
            provider: request.provider,
            prompt: `${request.provider} provider set to ${request.mode}; secret ${request.secretName ?? "not set"}`,
            summary: `${request.provider} provider set to ${request.mode}; configured ${request.secretName ?? "no secret"}`,
            projectId: "admin",
            nodeId: "admin-provider",
            modelId: "admin",
            outputCount: 0,
            creditCost: 0,
            createdAt: new Date().toISOString()
          } as HistoryEntry,
          ...backendAdminAudit
        ];
        return jsonResponse(configured);
      }
      if (url.endsWith("/api/admin/accounts")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        return jsonResponse(backendAccounts);
      }
      if (url.endsWith("/api/admin/usage")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        return jsonResponse(backendAdminUsage);
      }
      if (url.endsWith("/api/admin/audit")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        return jsonResponse(backendAdminAudit);
      }
      if (url.includes("/api/admin/history")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const filterUserId = new URL(url, "http://localhost").searchParams.get("userId");
        return jsonResponse(filterUserId ? backendAdminHistory.filter((entry) => entry.userId === filterUserId) : backendAdminHistory);
      }
      if (url.endsWith("/api/admin/jobs")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        return jsonResponse(backendAdminJobs);
      }
      if (url.endsWith("/api/profile")) return jsonResponse(backendProfile);
      if (url.endsWith("/api/history")) return jsonResponse(backendHistory);
      if (url.endsWith("/api/models")) {
        return jsonResponse(backendWorkspace.modelRegistry);
      }
      if (url.endsWith("/api/admin/providers")) {
        return jsonResponse(backendProviderHealth);
      }
      if (url.endsWith("/api/generations") || url.endsWith("/api/edits") || url.endsWith("/api/upscale") || url.endsWith("/api/remove-bg")) {
        const request = JSON.parse(String(init?.body)) as GenerationRequest;
        const unitCost = request.modelId === "nanobanana2" ? 11 : request.modelId === "upscale-pro" ? 4 : request.modelId === "background-cleaner" ? 2 : 7;
        const creditCost = unitCost * request.outputCount;
        backendProfile = {
          ...backendProfile,
          creditBalance: backendProfile.creditBalance - creditCost,
          creditUsed: backendProfile.creditUsed + creditCost,
          credits: backendProfile.creditBalance - creditCost
        };
        const historyEntry: HistoryEntry = {
          id: `history-${backendHistory.length + 1}`,
          projectId: request.projectId,
          nodeId: request.nodeId,
          prompt: request.prompt,
          modelId: request.modelId,
          outputCount: request.outputCount,
          creditCost,
          operation: request.operation,
          referenceCount: request.referenceNodeIds.length,
          createdAt: new Date().toISOString(),
          outputs: Array.from({ length: request.outputCount }, (_, index) => ({
            name: `backend result ${index + 1}.jpg`,
            source: `mock://${request.operation}/${request.nodeId}/${index + 1}`,
            width: 1024,
            height: 1024
          }))
        };
        backendHistory = [historyEntry, ...backendHistory];
        return jsonResponse({
          status: "succeeded",
          creditCost,
          historyId: historyEntry.id,
          providerProgress: {
            providerJobId: `provider-${historyEntry.id}`,
            status: "succeeded",
            statusUrl: `https://provider.example/jobs/provider-${historyEntry.id}`,
            pollAttempts: 1
          },
          outputs: historyEntry.outputs
        });
      }
      return jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function login(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  expect(screen.getByText("登录 Canvas Ops")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("Designer canvas app shell", () => {
  it("shows account, history, and project management before opening the canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getAllByText("Projects").length).toBeGreaterThan(0);
    expect(screen.getAllByText("History").length).toBeGreaterThan(0);
    expect(screen.getByText("Designer credits")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByText("IMAGE")).not.toBeInTheDocument();
    expect(screen.queryByText("Context panel")).not.toBeInTheDocument();
  });

  it("opens the Recraft-like infinite canvas only after a project is created", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));

    expect(screen.getByText("IMAGE")).toBeInTheDocument();
    expect(screen.getByText("Context panel")).toBeInTheDocument();
    expect(screen.getByText("Batch mode")).toBeInTheDocument();
    expect(screen.getByText("Workflow modules")).toBeInTheDocument();
    expect(screen.getByText("fashion-reference.jpg")).toBeInTheDocument();
  });

  it("lets designers delete one project without removing other project canvases", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Projects" }));

    expect(screen.getByRole("button", { name: "Open project Untitled 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open project Untitled 2" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete project Untitled 1" }));

    expect(screen.queryByRole("button", { name: "Open project Untitled 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open project Untitled 2" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open project Untitled 2" }));
    expect(screen.getByText("Context panel")).toBeInTheDocument();
    expect(screen.getByText("fashion-reference.jpg")).toBeInTheDocument();
  });

  it("lets designers rename one project without changing other project canvases", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Projects" }));

    await user.click(screen.getByRole("button", { name: "Rename project Untitled 1" }));
    const renameInput = screen.getByRole("textbox", { name: "Project name for Untitled 1" });
    await user.clear(renameInput);
    await user.type(renameInput, "Holiday capsule shoot");
    await user.click(screen.getByRole("button", { name: "Save project name for Untitled 1" }));

    expect(screen.getByRole("button", { name: "Open project Holiday capsule shoot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open project Untitled 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open project Untitled 1" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open project Holiday capsule shoot" }));
    expect(screen.getByText("Holiday capsule shoot")).toBeInTheDocument();
    expect(screen.getByText("fashion-reference.jpg")).toBeInTheDocument();
  });

  it("autosaves created project workspaces to the backend snapshot", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));

    await waitFor(() => {
      const workspaceSaves = vi.mocked(fetch).mock.calls.filter(([url, init]) => url.toString().endsWith("/api/workspace") && init?.method === "POST");
      const latestSave = workspaceSaves[workspaceSaves.length - 1];
      expect(latestSave).toBeTruthy();
      expect(latestSave?.[1]?.headers).toMatchObject({ "x-user-id": "admin@company.local" });
      const body = JSON.parse(String(latestSave?.[1]?.body)) as Partial<Workspace>;
      expect(body.projects?.length).toBeGreaterThan(0);
      expect(body.activeProjectId).toBe(body.projects?.[0].id);
      expect(body.projects?.[0].nodes.some((node) => node.name === "fashion-reference.jpg")).toBe(true);
      expect(body).not.toHaveProperty("modelRegistry");
    });
  });

  it("supports reference uploads, model prompt controls, and right dock panels after entering canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Upload images/i }));

    expect(screen.getByText("reference-front.jpg")).toBeInTheDocument();
    expect(screen.getByText("reference-texture.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Model GPT Image 2 Medium/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Prompts" }));
    const promptButtons = screen.getAllByRole("button", { name: /局部服装改款/i });
    await user.click(promptButtons[promptButtons.length - 1]);
    expect(screen.getByPlaceholderText(/\[TARGET\]/)).toHaveValue("只修改选区内的服装细节，保持模特姿势、背景、光线和版型不变。");

    await user.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByText("Generate node")).toBeInTheDocument();
    expect(screen.getByText("Workflow modules")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Assistant" }));
    expect(screen.getByText("Two-reference concept")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Use as prompt" })[0]);
    expect((screen.getByPlaceholderText(/\[TARGET\]/) as HTMLTextAreaElement).value).toContain("Use the selected references");
    const nodeCount = screen.getAllByTestId("canvas-node").length;
    await user.click(screen.getAllByRole("button", { name: "Add note node" })[0]);
    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(nodeCount);
    });
  });

  it("opens grouped Recraft-style model menus from the prompt panel and inline image editor", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Model GPT Image 2 Medium/i }));

    expect(screen.getByRole("listbox", { name: "Model options" })).toBeInTheDocument();
    expect(screen.getByText("Trending models")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Nano Banana 2.*11 credits.*generate.*edit/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Creative Upscale/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Remove Background/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Nano Banana 2.*11 credits/i }));
    expect(screen.getByRole("button", { name: /Model Nano Banana 2/i })).toBeInTheDocument();

    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Inline model Nano Banana 2/i }));
    expect(screen.getByRole("listbox", { name: "Inline model options" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Creative Upscale/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Flux Pro.*6 credits/i }));
    expect(screen.getByRole("button", { name: /Inline model Flux Pro/i })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Upscale clean high-res output/i }));
    await user.click(screen.getByRole("button", { name: /Model Creative Upscale/i }));
    expect(screen.getByRole("listbox", { name: "Model options" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Creative Upscale.*4 credits.*upscale/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT Image 2 Medium/i })).not.toBeInTheDocument();
  });

  it("lets designers drag and resize image nodes on the infinite canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const imageNode = screen.getByRole("button", { name: /Image fashion-reference\.jpg/i });
    const dispatchPointer = (target: EventTarget, type: string, clientX: number, clientY: number) => {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        })
      );
    };
    const initialLeft = Number.parseInt(imageNode.style.left, 10);
    const initialTop = Number.parseInt(imageNode.style.top, 10);
    const initialWidth = Number.parseInt(imageNode.style.width, 10);

    await act(async () => {
      dispatchPointer(imageNode, "pointerdown", 700, 220);
      dispatchPointer(window, "pointermove", 748, 260);
      dispatchPointer(window, "pointerup", 748, 260);
    });
    await waitFor(() => {
      expect(imageNode).toHaveStyle({ left: `${initialLeft + 48}px`, top: `${initialTop + 40}px` });
    });

    const resizeHandle = screen.getByLabelText("Resize image");
    await act(async () => {
      dispatchPointer(resizeHandle, "pointerdown", 1000, 650);
      dispatchPointer(window, "pointermove", 1060, 710);
      dispatchPointer(window, "pointerup", 1060, 710);
    });
    await waitFor(() => {
      expect(imageNode).toHaveStyle({ width: `${initialWidth + 60}px` });
    });
  });

  it("lets designers jump to canvas nodes from the minimap", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const stageWorld = document.querySelector(".stage-world") as HTMLElement;
    expect(stageWorld).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });

    await user.click(screen.getByRole("button", { name: "Focus minimap image node 1" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i })).toHaveClass("selected");
    });
    expect(stageWorld.style.transform).toContain("translate(130px, 70px) scale(1)");
  });

  it("lets designers copy, delete, undo, and redo selected image nodes", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const imageNode = screen.getByRole("button", { name: /Image fashion-reference\.jpg/i });
    await user.click(imageNode);
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;
    const initialLeft = Number.parseInt(imageNode.style.left, 10);
    const initialTop = Number.parseInt(imageNode.style.top, 10);

    await user.click(screen.getByRole("button", { name: "Copy/Paste" }));

    const copiedNode = await screen.findByRole("button", { name: /Image fashion-reference\.jpg copy/i });
    expect(screen.getAllByTestId("canvas-node")).toHaveLength(initialNodeCount + 1);
    expect(copiedNode).toHaveStyle({ left: `${initialLeft + 42}px`, top: `${initialTop + 42}px` });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Image fashion-reference\.jpg copy/i })).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId("canvas-node")).toHaveLength(initialNodeCount);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: /Image fashion-reference\.jpg copy/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Image fashion-reference\.jpg copy/i })).not.toBeInTheDocument();
    });
  });

  it("imports externally dropped image files onto the canvas at the drop point", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const stage = screen.getByRole("region", { name: "Infinite canvas" });
    const front = new File(["front reference"], "dropped-front.png", { type: "image/png" });
    const texture = new File(["texture reference"], "dropped-texture.png", { type: "image/png" });

    fireEvent.dragOver(stage, {
      dataTransfer: { files: [front, texture], dropEffect: "move" }
    });
    const dropEvent = createEvent.drop(stage, {
      dataTransfer: { files: [front, texture], dropEffect: "copy" }
    });
    Object.defineProperties(dropEvent, {
      clientX: { value: 320 },
      clientY: { value: 280 }
    });
    fireEvent(stage, dropEvent);

    expect(await screen.findByText("dropped-front.png")).toBeInTheDocument();
    expect(await screen.findByText("dropped-texture.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image dropped-front.png" })).toHaveStyle({ left: "320px", top: "280px" });
    expect(screen.getByRole("button", { name: "Image dropped-texture.png" })).toHaveStyle({ left: "356px", top: "316px" });
    expect(document.querySelector(".stage-node.selected")).toHaveTextContent("dropped-texture.png");
  });

  it("pastes image files into the active canvas as new selectable image nodes", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const stage = screen.getByRole("region", { name: "Infinite canvas" });
    const pasted = new File(["pasted reference"], "pasted-look.png", { type: "image/png" });

    stage.focus();
    fireEvent.paste(stage, {
      clipboardData: { files: [pasted] }
    });

    expect(await screen.findByText("pasted-look.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image pasted-look.png" })).toHaveStyle({ left: "640px", top: "360px" });
    expect(document.querySelector(".stage-node.selected")).toHaveTextContent("pasted-look.png");
  });

  it("lets designers save, search, insert, and delete prompt presets from the canvas dock", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Create a pleated silk vest with tiny tonal embroidery and clean studio lighting.");

    await user.click(screen.getByRole("button", { name: "Prompts" }));
    await user.click(screen.getByRole("button", { name: "Save current prompt" }));

    expect(screen.getByText("Prompt saved to library")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prompts$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-user-id": "admin@company.local" }),
        body: expect.stringContaining("pleated silk vest")
      })
    );
    await user.type(screen.getByRole("textbox", { name: "Search prompts" }), "pleated silk");
    expect(screen.getByRole("button", { name: /Prompt note prompt.*pleated silk/i })).toBeInTheDocument();
    expect(screen.getByText("Saved by Admin Ops")).toBeInTheDocument();

    await user.clear(promptBox);
    await user.click(screen.getByRole("button", { name: /Prompt note prompt.*pleated silk/i }));
    expect(promptBox).toHaveValue("Create a pleated silk vest with tiny tonal embroidery and clean studio lighting.");

    await user.click(screen.getByRole("button", { name: "Delete prompt Prompt note prompt" }));
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prompts\/prompt-backend-\d+$/),
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ "x-user-id": "admin@company.local" }) })
    );
    expect(screen.queryByRole("button", { name: /Prompt note prompt.*pleated silk/i })).not.toBeInTheDocument();
  });

  it("shows prompt preset details and turns a preset into a canvas note", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Prompts" }));

    await user.click(screen.getByRole("button", { name: "View prompt details 1" }));
    expect(screen.getByRole("region", { name: "Prompt preset detail" })).toHaveTextContent("局部服装改款");

    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.click(screen.getByRole("button", { name: "Use detailed prompt" }));
    expect((promptBox as HTMLTextAreaElement).value).toMatch(/只修改选区内/);

    const initialTextNodes = screen.getAllByRole("button", { name: /Text Prompt note/i }).length;
    await user.click(screen.getByRole("button", { name: "Add detailed prompt note" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Text Prompt note/i })).toHaveLength(initialTextNodes + 1);
    });
    expect(screen.getAllByText(/只修改选区内/).length).toBeGreaterThan(1);
  });

  it("runs batch mode and writes visible generation history", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByPlaceholderText(/\[TARGET\]/), "统一去背并保持服装边缘清晰");
    await user.click(screen.getByRole("button", { name: "Batch mode" }));
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByText(/background-cleaner/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/credits/i).length).toBeGreaterThan(0);
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/remove-bg"));
    expect(calls).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(screen.getByText("My assets")).toBeInTheDocument();
    const existingCanvasNodes = screen.getAllByTestId("canvas-node").length;
    await user.click(screen.getAllByRole("button", { name: /backend result 1\.jpg.*Use in canvas/i })[0]);
    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(existingCanvasNodes);
    });
  });

  it("imports a batch folder and processes every selected image with the same prompt", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Apply one consistent showroom cleanup to every imported garment image.");
    const folderInput = screen.getByLabelText("Batch folder input");
    const first = new File(["front look"], "folder-front.png", { type: "image/png" });
    const second = new File(["back look"], "folder-back.png", { type: "image/png" });

    await user.upload(folderInput, [first, second]);

    expect(await screen.findByText("Backend batch completed for 2 images")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Image folder-front\.png/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Image folder-back\.png/i })).toBeInTheDocument();
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThanOrEqual(2);
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    expect(calls).toHaveLength(2);
    const requests = calls.map(([, init]) => JSON.parse(String(init?.body)) as GenerationRequest);
    expect(requests.map((request) => request.referenceNodeIds[0])).toEqual(["folder-front.png", "folder-back.png"]);
    expect(requests.every((request) => request.prompt === "Apply one consistent showroom cleanup to every imported garment image.")).toBe(true);

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getAllByText(/Apply one consistent showroom cleanup/i).length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(screen.getAllByRole("button", { name: /backend result 1\.jpg.*Use in canvas/i }).length).toBeGreaterThanOrEqual(2);
  });

  it("uses prompt panel batch settings before any image is selected", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Run three variations for every imported flat lay.");
    fireEvent.change(screen.getByRole("slider", { name: "Output count" }), { target: { value: "3" } });
    const folderInput = screen.getByLabelText("Batch folder input");
    const first = new File(["front look"], "batch-three-front.png", { type: "image/png" });
    const second = new File(["back look"], "batch-three-back.png", { type: "image/png" });

    await user.upload(folderInput, [first, second]);

    expect(await screen.findByText("Backend batch completed for 2 images")).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const requests = calls.map(([, init]) => JSON.parse(String(init?.body)) as GenerationRequest);
    expect(calls).toHaveLength(2);
    expect(requests.every((request) => request.prompt === "Run three variations for every imported flat lay.")).toBe(true);
    expect(requests.every((request) => request.outputCount === 3)).toBe(true);
  });

  it("routes imported batch folders through the selected operation model", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Upscale node" }));
    const folderInput = screen.getByLabelText("Batch folder input");
    const first = new File(["front look"], "upscale-front.png", { type: "image/png" });
    const second = new File(["back look"], "upscale-back.png", { type: "image/png" });

    await user.upload(folderInput, [first, second]);

    expect(await screen.findByText("Backend batch completed for 2 images")).toBeInTheDocument();
    const upscaleCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/upscale"));
    const generationCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const requests = upscaleCalls.map(([, init]) => JSON.parse(String(init?.body)) as GenerationRequest);

    expect(upscaleCalls).toHaveLength(2);
    expect(generationCalls).toHaveLength(0);
    expect(requests.map((request) => request.operation)).toEqual(["upscale", "upscale"]);
    expect(requests.every((request) => request.modelId === "upscale-pro")).toBe(true);
  });

  it("keeps processing a batch when one imported image fails", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation();
    let rejectedBackOnce = false;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/generations")) {
        const request = JSON.parse(String(init?.body)) as GenerationRequest;
        if (request.referenceNodeIds[0] === "folder-back.png" && !rejectedBackOnce) {
          rejectedBackOnce = true;
          return jsonResponse({ status: "failed", errorMessage: "Provider rejected folder-back.png" }, 500);
        }
      }
      return originalFetch?.(input, init) ?? jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    });
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Apply one consistent showroom cleanup to every imported garment image.");
    const folderInput = screen.getByLabelText("Batch folder input");
    const first = new File(["front look"], "folder-front.png", { type: "image/png" });
    const second = new File(["back look"], "folder-back.png", { type: "image/png" });

    await user.upload(folderInput, [first, second]);

    expect(await screen.findByText("Backend batch completed for 1 of 2 images; 1 failed")).toBeInTheDocument();
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Image folder-front\.png/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Image folder-back\.png/i })).toBeInTheDocument();
    expect(screen.getByText("Batch queue")).toBeInTheDocument();
    expect(screen.getAllByText("folder-front.png").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("folder-back.png").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Provider rejected folder-back.png").length).toBeGreaterThanOrEqual(1);
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    expect(calls).toHaveLength(2);
    expect(screen.getByText("Batch progress 1/2 succeeded · 1 failed · 100% complete")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry failed batch items" }));

    expect(await screen.findByText("Backend batch completed for 1 images")).toBeInTheDocument();
    const retryCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const retryRequest = JSON.parse(String(retryCalls[retryCalls.length - 1][1]?.body)) as GenerationRequest;
    expect(retryCalls).toHaveLength(3);
    expect(retryRequest.referenceNodeIds).toEqual(["folder-back.png"]);
    expect(screen.getByText("Batch progress 2/2 succeeded · 0 failed · 100% complete")).toBeInTheDocument();
    expect(screen.getAllByText("done").length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getAllByText(/Apply one consistent showroom cleanup/i).length).toBeGreaterThanOrEqual(1);
  });

  it("stops backend batch submission after the first failure when the batch policy is stop", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/generations")) {
        const request = JSON.parse(String(init?.body)) as GenerationRequest;
        if (request.referenceNodeIds[0] === "stop-back.png") {
          return jsonResponse({ status: "failed", errorMessage: "Stop policy provider failure" }, 500);
        }
      }
      return originalFetch?.(input, init) ?? jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    });
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Settings node" }));
    expect(await screen.findByRole("button", { name: /Workflow settings/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch concurrency"), { target: { value: "2" } });
    await user.selectOptions(screen.getByLabelText("Batch failure policy"), "stop");
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Stop this batch if the provider rejects one item.");
    const folderInput = screen.getByLabelText("Batch folder input");
    const front = new File(["front look"], "stop-front.png", { type: "image/png" });
    const back = new File(["back look"], "stop-back.png", { type: "image/png" });
    const side = new File(["side look"], "stop-side.png", { type: "image/png" });

    await user.upload(folderInput, [front, back, side]);

    expect(await screen.findByText("Backend batch stopped after 1 of 3 images; 1 failed; 1 skipped")).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const requests = calls.map(([, init]) => JSON.parse(String(init?.body)) as GenerationRequest);
    expect(calls).toHaveLength(2);
    expect(requests.map((request) => request.referenceNodeIds[0])).toEqual(["stop-front.png", "stop-back.png"]);
    expect(requests.every((request) => request.batchSettings?.failurePolicy === "stop")).toBe(true);
    expect(requests.every((request) => request.batchSettings?.concurrency === 2)).toBe(true);
    expect(screen.getAllByText("Stop policy provider failure").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Skipped after stop-on-failure").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Batch progress 1\/3 succeeded.*1 failed.*100% complete/)).toBeInTheDocument();
  });

  it("opens admin monitoring for an admin session", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));

    expect(screen.getByRole("heading", { name: "Admin monitoring" })).toBeInTheDocument();
    expect(screen.getByText("Model providers")).toBeInTheDocument();
    expect(await screen.findByText(/openai-image-adapter/i)).toBeInTheDocument();
    expect(screen.getByText(/missing: OPENAI_API_KEY/i)).toBeInTheDocument();
    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
    expect(screen.getByText("Access policy")).toBeInTheDocument();
    expect(screen.getByText("Server only")).toBeInTheDocument();
    expect(screen.getByText("Provider configuration")).toBeInTheDocument();
    expect(screen.getByText("Credit management")).toBeInTheDocument();
    expect(await screen.findByText("Team accounts")).toBeInTheDocument();
    expect(screen.getByText("Model usage")).toBeInTheDocument();
    expect(screen.getByText("Team credit ledger")).toBeInTheDocument();
    expect(screen.getByText("55 credits allocated")).toBeInTheDocument();
    expect(screen.getByText("5 credits removed")).toBeInTheDocument();
    expect(screen.getByText("-5 credits")).toBeInTheDocument();
    expect(screen.getByText("Balance 35")).toBeInTheDocument();
    expect(screen.getByText("returned unused credits")).toBeInTheDocument();
    expect(screen.getByText("Generation jobs")).toBeInTheDocument();
    expect(screen.getByText("Alice Designer · generate")).toBeInTheDocument();
    expect(screen.getByText("succeeded · 14 credits · 2 outputs")).toBeInTheDocument();
    expect(screen.getByText("Job spend 6.20 CNY estimated spend")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Job output alice-job-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.getByText("Bob Designer · upscale")).toBeInTheDocument();
    expect(screen.getByText("succeeded · 4 credits · 1 output")).toBeInTheDocument();
    expect(screen.getByText("Job spend 2.40 CNY estimated spend")).toBeInTheDocument();
    expect(screen.getByText("Cara Designer · generate")).toBeInTheDocument();
    expect(screen.getByText("failed · 0 credits · 1 output")).toBeInTheDocument();
    expect(screen.getByText("Provider adapter not configured for retired-provider")).toBeInTheDocument();
    expect(screen.getByText("Admin audit")).toBeInTheDocument();
    expect(screen.getByText("Audit spend 6.20 CNY estimated spend")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(screen.getByText("3 history entries")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-image-2-medium").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("14 credits / 2 outputs")).toBeInTheDocument();
    expect(screen.getByText("6.20 CNY estimated spend")).toBeInTheDocument();
    expect(screen.getAllByText("upscale-pro").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2.40 CNY estimated spend")).toBeInTheDocument();
    expect(screen.getAllByText("Alice campaign cleanup").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Alice Designer · Alice campaign")).toBeInTheDocument();
    expect(screen.getAllByText("Bob upscale pass").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Bob Designer · Bob upscale")).toBeInTheDocument();
    expect(screen.getByText("Team history")).toBeInTheDocument();
    expect(screen.getByText("Alice Designer · Alice campaign · gpt-image-2-medium")).toBeInTheDocument();
    expect(screen.getByText("14 credits · 2 outputs")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.getByText("Bob Designer · Bob upscale · upscale-pro")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output bob-upscale-1.jpg" })).toBeInTheDocument();
    expect(screen.getAllByText("alice@company.local").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Alice Designer").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("88 remaining")).toBeInTheDocument();
    expect(screen.getByText("12 used / limit 120")).toBeInTheDocument();
    expect(screen.getByText("2 projects / 5 history / 7 assets")).toBeInTheDocument();
    expect(screen.getByText("Last active 2026-06-28 02:00")).toBeInTheDocument();

    await user.clear(screen.getByRole("spinbutton", { name: "Credit delta" }));
    await user.type(screen.getByRole("spinbutton", { name: "Credit delta" }), "20");
    await user.click(screen.getByRole("button", { name: "Update credits" }));

    expect(await screen.findByText("Admin Ops now has 200 credits")).toBeInTheDocument();
    expect(screen.getByText("Designer credit limit")).toBeInTheDocument();
    await user.clear(screen.getByRole("spinbutton", { name: "Credit limit" }));
    await user.type(screen.getByRole("spinbutton", { name: "Credit limit" }), "210");
    await user.click(screen.getByRole("button", { name: "Set credit limit" }));
    expect(await screen.findByText("Admin Ops credit limit set to 210")).toBeInTheDocument();

    expect(screen.getByText("Model pricing")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Pricing model" }), "gpt-image-2-medium");
    await user.clear(screen.getByRole("spinbutton", { name: "Model credit cost" }));
    await user.type(screen.getByRole("spinbutton", { name: "Model credit cost" }), "9");
    await user.clear(screen.getByRole("spinbutton", { name: "Model price cents" }));
    await user.type(screen.getByRole("spinbutton", { name: "Model price cents" }), "450");
    await user.click(screen.getByRole("button", { name: "Update model pricing" }));
    expect(await screen.findByText("GPT Image 2 Medium now costs 9 credits per output")).toBeInTheDocument();
    expect(screen.getByLabelText("Configured model pricing")).toHaveTextContent("9 credits / 4.50 CNY");

    expect(screen.getByText("Model registry")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Register model" }));
    expect(await screen.findByText("Custom Fashion V1 registered for runninghub")).toBeInTheDocument();
    expect(screen.getByLabelText("Registered model registry")).toHaveTextContent("Custom Fashion V1: runninghub / generate + edit / 6 credits");
    expect(screen.getByRole("combobox", { name: "Pricing model" })).toHaveValue("custom-fashion-v1");
    expect(screen.getByText(/model-registry/i)).toBeInTheDocument();
    expect(screen.getByText(/custom-fashion-v1 registered for runninghub/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Provider to configure" }), "openai");
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider mode" }), "live-ready");
    await user.type(screen.getByRole("textbox", { name: "Provider endpoint URL" }), "https://api.openai.example/v1/images");
    await user.clear(screen.getByRole("textbox", { name: "Provider secret name" }));
    await user.type(screen.getByRole("textbox", { name: "Provider secret name" }), "OPENAI_API_KEY");
    await user.type(screen.getByLabelText("Provider secret value"), "sk-ui-secret");
    await user.click(screen.getByRole("button", { name: "Update provider" }));
    expect(await screen.findByText("openai provider set to live-ready")).toBeInTheDocument();
    expect(screen.getByText(/configured: OPENAI_API_KEY/i)).toBeInTheDocument();
    expect(screen.queryByText("sk-ui-secret")).not.toBeInTheDocument();
    expect(screen.getByText(/provider-settings/i)).toBeInTheDocument();
    expect(screen.getByText(/openai provider set to live-ready; configured OPENAI_API_KEY/i)).toBeInTheDocument();
    expect(screen.getByText(/model-pricing/i)).toBeInTheDocument();
    expect(screen.getByText(/credit-adjustment/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to projects" }));
    await user.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.getByRole("region", { name: "Profile credit management" })).toHaveTextContent("200");
  });

  it("filters team history by designer in the admin workspace", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    expect(await screen.findByText("Team history")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Team history output alice-cleanup-1.jpg" }, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Team history output bob-upscale-1.jpg" }, { timeout: 4000 })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Team history designer filter" }), "bob@company.local");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/admin\/history\?userId=bob%40company\.local$/),
      expect.objectContaining({ headers: expect.objectContaining({ "x-user-id": "admin@company.local" }) })
    );
    expect(screen.queryByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output bob-upscale-1.jpg" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Team history designer filter" }), "alice@company.local");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/admin\/history\?userId=alice%40company\.local$/),
      expect.objectContaining({ headers: expect.objectContaining({ "x-user-id": "admin@company.local" }) })
    );
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Team history output bob-upscale-1.jpg" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Team history designer filter" }), "all");

    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output bob-upscale-1.jpg" })).toBeInTheDocument();
  });

  it("exports the filtered admin team history for audit handoff", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    await screen.findByText("Team history");
    await user.selectOptions(screen.getByRole("combobox", { name: "Team history designer filter" }), "bob@company.local");

    let exportAnchor: HTMLAnchorElement | undefined;
    let exportedBlob: Blob | undefined;
    const createElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = createElement(tagName, options);
      if (tagName === "a") {
        exportAnchor = element as HTMLAnchorElement;
        vi.spyOn(exportAnchor, "click").mockImplementation(() => undefined);
      }
      return element;
    });
    const previousCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const previousRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return "blob:team-history-export";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    try {
      await user.click(screen.getByRole("button", { name: "Export team history" }));
      const exportedText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exportedBlob!);
      });
      const payload = JSON.parse(exportedText) as { filterUserId: string; entries: HistoryEntry[] };

      expect(exportAnchor?.download).toBe("team-history-bob-company-local.json");
      expect(payload.filterUserId).toBe("bob@company.local");
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]).toMatchObject({ userId: "bob@company.local", projectName: "Bob upscale", modelId: "upscale-pro" });
      expect(JSON.stringify(payload)).not.toContain("Alice campaign cleanup");
    } finally {
      createElementSpy.mockRestore();
      if (previousCreateObjectURL) Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (previousRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("supports the image node inline model/prompt entry and generation loop", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Inline model GPT Image 2 Medium/i }));
    await user.click(screen.getByRole("option", { name: /Nano Banana 2.*11 credits/i }));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "参考这张图做一件新的刺绣背心");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);

    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect((await screen.findAllByText(/history-1.*11 credits/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Done")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByText("Selected node task")).toBeInTheDocument();
    expect(screen.getByText("history-1")).toBeInTheDocument();
    expect(screen.getByText("generate / nanobanana2")).toBeInTheDocument();
    expect(screen.getByText("Provider succeeded / provider-history-1 / 1 poll")).toBeInTheDocument();
    expect(screen.getByText("11 credits · 1 output")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText(/nanobanana2/i)).toBeInTheDocument();
    expect(screen.getAllByText(/参考这张图做一件新的刺绣背心/).length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/generations$/), expect.objectContaining({ method: "POST" }));
  });

  it("keeps a failed backend generation visible on the source canvas node", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/generations")) {
        return jsonResponse({ status: "failed", errorMessage: "Provider unavailable" }, 500);
      }
      return originalFetch?.(input, init) ?? jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    });
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "Make a new embroidered vest");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);

    expect(await screen.findByText("Error")).toBeInTheDocument();
    expect(screen.getAllByText("Provider unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("backend result 1.jpg")).not.toBeInTheDocument();
  });

  it("confirms mask edits, creates target frames, and keeps them visible on canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Edit area/i }));
    expect(screen.getByRole("dialog", { name: "Mask edit confirmation" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "rectangle" }));
    expect(screen.getByRole("application", { name: "Mask placement preview" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "Mask size" }), { target: { value: "60" } });
    expect(screen.getByLabelText("Mask coordinates")).toHaveTextContent("w 60");
    await user.click(screen.getByRole("button", { name: "Confirm edit" }));
    expect(screen.getByText("fashion-reference.jpg mask edit")).toBeInTheDocument();
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend mask edit succeeded, 7 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/edits$/), expect.objectContaining({ method: "POST" }));
    const editCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/edits"));
    const editRequest = JSON.parse(String(editCall?.[1]?.body)) as GenerationRequest;
    expect(editRequest.mask).toMatchObject({ width: 60, height: 52 });

    await user.click(screen.getByRole("button", { name: /Target frame/i }));
    expect(screen.getByText("Generation target frame")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-image-2-medium").length).toBeGreaterThan(0);
  });

  it("runs toolbar upscale through the backend operation API", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Upscale" }));

    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend upscale succeeded, 4 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/upscale$/), expect.objectContaining({ method: "POST" }));
  });

  it("wires toolbar download, magic edit, and top remove background actions", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));

    let downloadAnchor: HTMLAnchorElement | undefined;
    const createElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = createElement(tagName, options);
      if (tagName === "a") {
        downloadAnchor = element as HTMLAnchorElement;
        vi.spyOn(downloadAnchor, "click").mockImplementation(() => undefined);
      }
      return element;
    });
    try {
      await user.click(screen.getByRole("button", { name: "Download" }));
      expect(downloadAnchor?.download).toBe("fashion-reference.jpg");
      expect(downloadAnchor?.href).toContain("/fixtures/fashion-reference.jpg");
    } finally {
      createElementSpy.mockRestore();
    }

    await user.click(screen.getByRole("button", { name: "Magic edit" }));
    expect(screen.getByRole("dialog", { name: "Mask edit confirmation" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Remove bg" }));
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend removeBackground succeeded, 2 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/remove-bg$/), expect.objectContaining({ method: "POST" }));
  });

  it("saves a selected image node to the asset library and inserts it back onto the canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;

    await user.click(screen.getByRole("button", { name: "Save asset" }));

    expect(screen.getByText("My assets")).toBeInTheDocument();
    const savedAsset = screen.getByRole("button", { name: /fashion-reference\.jpg.*Use in canvas/i });
    expect(savedAsset).toBeInTheDocument();

    await user.click(savedAsset);

    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node")).toHaveLength(initialNodeCount + 1);
    });
    expect(screen.getAllByRole("button", { name: /Image fashion-reference\.jpg/i }).length).toBeGreaterThan(1);
  });

  it("filters saved assets by reusable tags in the canvas dock", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      assets: [
        {
          id: "asset-edit-reference",
          type: "image",
          title: "embroidered-reference.jpg",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "edit"],
          createdAt: "2026-06-28T10:00:00.000Z"
        },
        {
          id: "asset-remove-bg",
          type: "image",
          title: "cutout-result.png",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "removebackground"],
          createdAt: "2026-06-28T10:05:00.000Z"
        }
      ]
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Assets" }));

    expect(screen.getByRole("button", { name: /embroidered-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cutout-result\.png.*Use in canvas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter assets by edit" }));

    expect(screen.getByRole("button", { name: /embroidered-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cutout-result\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 asset tagged edit")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all assets" }));

    expect(screen.getByRole("button", { name: /embroidered-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cutout-result\.png.*Use in canvas/i })).toBeInTheDocument();
  });

  it("runs workflow modules through backend APIs", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Edit node" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Backend workflow completed 1 module")).toBeInTheDocument();
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/edits$/), expect.objectContaining({ method: "POST" }));
  });

  it("opens a workflow module picker from an image output port", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);

    expect(screen.getByText("Choose module")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Upscale clean high-res output/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(initialNodeCount);
    });
    expect(screen.getByText("upscale-pro")).toBeInTheDocument();

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));
    expect(await screen.findByText("Backend workflow completed 1 module")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/upscale$/), expect.objectContaining({ method: "POST" }));
  });

  it("offers a batch workflow module from image output ports", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);

    expect(screen.getByText("Choose module")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Batch same brief across selected images/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(initialNodeCount);
    });
    expect(screen.getByRole("button", { name: /Workflow batch module/i })).toBeInTheDocument();
    expect(screen.getAllByText("batch").length).toBeGreaterThan(0);
  });

  it("exposes all first-pass workflow node shortcuts in the context dock", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);
    expect(screen.getByRole("button", { name: /Upload Reference reference handoff node/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Generate node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upscale node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove BG node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Batch node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload Reference node" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings node" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove BG node" }));

    expect(await screen.findByRole("button", { name: /Workflow removeBackground module/i })).toBeInTheDocument();
    expect(screen.getByText("background-cleaner")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Upload Reference node" }));

    expect(await screen.findByRole("button", { name: /Workflow upload module/i })).toBeInTheDocument();
    expect(screen.getAllByText("Use this upload reference as an upstream image input.").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Settings node" }));

    expect(await screen.findByRole("button", { name: /Workflow settings/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Selected node task")).toHaveTextContent("Outputs: Settings");
    fireEvent.change(screen.getByLabelText("Output count value"), { target: { value: "3" } });
    expect(screen.getByText("3 images")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch concurrency"), { target: { value: "4" } });
    await user.selectOptions(screen.getByLabelText("Batch failure policy"), "stop");
    expect(screen.getByLabelText("Selected node task")).toHaveTextContent("Batch: 4 concurrent / stop on failure");
    fireEvent.change(screen.getByLabelText("Mask X"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Mask width"), { target: { value: "46" } });
    expect(screen.getByLabelText("Selected node task")).toHaveTextContent("Mask: x 12 / y 24 / w 46 / h 38");
    await user.selectOptions(screen.getByLabelText("Provider size"), "1536x1024");
    await user.selectOptions(screen.getByLabelText("Provider quality"), "high");
    fireEvent.change(screen.getByLabelText("Provider preset"), { target: { value: "lookbook-cleanup" } });
    expect(screen.getByLabelText("Selected node task")).toHaveTextContent("Provider: 1536x1024 / high / lookbook-cleanup");
  });

  it("shows typed input and output ports for the selected workflow node", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Edit node" }));

    expect(await screen.findByRole("button", { name: /Workflow edit module/i })).toBeInTheDocument();
    const selectedTask = screen.getByLabelText("Selected node task");
    expect(selectedTask).toHaveTextContent("Inputs: Image, Prompt, Mask config");
    expect(selectedTask).toHaveTextContent("Outputs: Edited result");
  });

  it("filters workflow module picker options by the dragged source port type", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from Prompt note"));
    fireEvent.pointerUp(window);

    expect(screen.getByText("Choose module")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate new design from references.*to Prompt/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit controlled image edit.*to Prompt/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Batch same brief across selected images.*to Batch prompt/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upscale clean high-res output/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove BG cutout for product use/i })).not.toBeInTheDocument();
  });

  it("highlights compatible workflow targets while dragging a port", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Generate node" }));
    const generateModule = await screen.findByRole("button", { name: /Workflow generate module/i });
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Upscale node" }));
    const upscaleModule = await screen.findByRole("button", { name: /Workflow upscale module/i });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from Prompt note"));

    expect(screen.getByRole("button", { name: /Text Prompt note/i })).toHaveClass("connection-source");
    expect(generateModule).toHaveClass("connection-compatible");
    expect(upscaleModule).toHaveClass("connection-incompatible");
    expect(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i })).toHaveClass("connection-incompatible");
    expect(screen.getByLabelText("Prompt input port on generate module")).toHaveClass("port-compatible");
    expect(screen.getByLabelText("Images input port on generate module")).toHaveClass("port-incompatible");

    fireEvent.pointerUp(window);

    expect(screen.getByText("Choose module")).toBeInTheDocument();
    expect(generateModule).not.toHaveClass("connection-compatible");
    expect(upscaleModule).not.toHaveClass("connection-incompatible");
    expect(screen.getByRole("button", { name: /Text Prompt note/i })).not.toHaveClass("connection-source");
    expect(screen.getByLabelText("Prompt input port on generate module")).not.toHaveClass("port-compatible");
  });

  it("connects a dragged output to a specific compatible input port", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Generate node" }));
    await screen.findByRole("button", { name: /Workflow generate module/i });
    const initialWireCount = document.querySelectorAll(".stage-wires path").length;

    const promptInputPort = screen.getByLabelText("Prompt input port on generate module");
    const promptPortRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("aria-label") === "Prompt input port on generate module") {
        return {
          x: 90,
          y: 90,
          left: 90,
          top: 90,
          right: 110,
          bottom: 110,
          width: 20,
          height: 20,
          toJSON: () => ({})
        } as DOMRect;
      }
      return {
        x: 1000,
        y: 1000,
        left: 1000,
        top: 1000,
        right: 1010,
        bottom: 1010,
        width: 10,
        height: 10,
        toJSON: () => ({})
      } as DOMRect;
    });
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => document.body)
    });
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from Prompt note"));
    fireEvent(window, new MouseEvent("pointerup", { clientX: 100, clientY: 100, bubbles: true }));
    promptPortRect.mockRestore();
    if (originalElementFromPoint) {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint
      });
    } else {
      delete (document as unknown as Record<string, unknown>).elementFromPoint;
    }

    expect(screen.queryByText("Choose module")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll(".stage-wires path")).toHaveLength(initialWireCount + 1);
    });
    expect(promptInputPort).not.toHaveClass("port-compatible");
  });

  it("chains workflow modules from module output ports and runs them in order", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Edit controlled image edit/i }));
    const editModule = await screen.findByRole("button", { name: /Workflow edit module/i });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from edit module"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Upscale clean high-res output/i }));
    expect(await screen.findByRole("button", { name: /Workflow upscale module/i })).toBeInTheDocument();

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Backend workflow completed 2 modules")).toBeInTheDocument();
    const editCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/edits"));
    const upscaleCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/upscale"));
    expect(editCalls).toHaveLength(1);
    expect(upscaleCalls).toHaveLength(1);
    expect(editModule).toHaveTextContent("Done");
  });

  it("shows an auditable workflow plan before designers run a node chain", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Edit controlled image edit/i }));
    const editModule = await screen.findByRole("button", { name: /Workflow edit module/i });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from edit module"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Upscale clean high-res output/i }));

    await user.click(screen.getByText("fashion-reference.jpg"));

    expect(screen.getByText("Workflow plan")).toBeInTheDocument();
    expect(screen.getByText("2 executable steps")).toBeInTheDocument();
    expect(screen.getByText("Estimated 11 credits")).toBeInTheDocument();
    expect(screen.getByText(/1\. edit module/)).toBeInTheDocument();
    expect(screen.getByText(/2\. upscale module/)).toBeInTheDocument();
    expect(editModule).toHaveTextContent("Ready");
  });

  it("blocks backend workflow submission when the preflight plan has errors", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Edit controlled image edit/i }));

    const promptInput = document.querySelector(".prompt-text") as HTMLTextAreaElement;
    fireEvent.change(promptInput, { target: { value: "   " } });
    await user.click(screen.getByText("fashion-reference.jpg"));

    expect(screen.getByText("blocked")).toBeInTheDocument();
    expect(screen.getByText("error: Prompt is required")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Workflow plan blocked: Prompt is required")).toBeInTheDocument();
    const editCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/edits"));
    expect(editCalls).toHaveLength(0);
  });

  it("keeps multi-selected images as shared references when dragging a workflow port", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Upload images/i }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("reference-front.jpg"));
    await user.keyboard("{/Shift}");
    await waitFor(() => {
      expect(document.querySelectorAll(".stage-node.selected")).toHaveLength(2);
    });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);

    expect(screen.getByText("2 references selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Generate new design from references/i }));
    expect(screen.getByText("2 refs")).toBeInTheDocument();

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));
    await screen.findByText("Backend workflow completed 1 module");

    const generationCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/generations"));
    const request = JSON.parse(String(generationCall?.[1]?.body)) as GenerationRequest;
    expect(request.referenceNodeIds).toHaveLength(2);
  });

  it("shows generation records and credit usage in the home history and profile views", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "生成一款带盘扣的黑色马甲");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);
    await screen.findByText("backend result 1.jpg");
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Projects" }));

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("region", { name: "History management" })).toBeInTheDocument();
    expect(screen.getByText(/生成一款带盘扣的黑色马甲/)).toBeInTheDocument();
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    const historyOutput = screen.getByRole("img", { name: "History output backend result 1.jpg" }) as HTMLImageElement;
    expect(historyOutput).toBeInTheDocument();
    expect(historyOutput.src).not.toMatch(/^mock:/);
    await user.click(screen.getByRole("button", { name: "Open project" }));
    expect(screen.getByText("Selected node task")).toBeInTheDocument();
    expect(screen.getByText("history-1")).toBeInTheDocument();
    expect(screen.getByText("generate / gpt-image-2-medium")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.getByRole("region", { name: "Profile credit management" })).toBeInTheDocument();
    expect(screen.getByText("Credit balance")).toBeInTheDocument();
    expect(screen.getAllByText("173").length).toBeGreaterThan(0);
  });

  it("calculates profile credit usage against the assigned credit limit", async () => {
    backendProfile = {
      ...backendProfile,
      creditBalance: 88,
      credits: 88,
      creditUsed: 12,
      creditLimit: 120
    };
    backendWorkspace = { ...backendWorkspace, profile: backendProfile };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "Profile" }));

    expect(screen.getByText(/12 credits used.*limit 120/)).toBeInTheDocument();
    expect(document.querySelector(".credit-meter i")).toHaveStyle({ width: "10%" });
  });
});
