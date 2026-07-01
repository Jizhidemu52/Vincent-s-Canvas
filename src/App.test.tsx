import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createInitialWorkspace, type GenerationRequest, type HistoryEntry, type LibraryAsset, type ModelDefinition, type Profile, type Workspace } from "./domain/workspace";
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
let backendArchivedAdminHistory: HistoryEntry[] = [];
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
      references: [{ name: "alice-original.jpg", source: "/fixtures/alice-original.jpg", width: 512, height: 512 }],
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
      references: [{ name: "bob-original.jpg", source: "/fixtures/bob-original.jpg", width: 512, height: 512 }],
      userId: "bob@company.local",
      designerName: "Bob Designer",
      createdAt: "2026-06-28T02:05:00.000Z",
      outputs: [{ name: "bob-upscale-1.jpg", source: "/fixtures/bob-upscale-1.jpg", width: 1024, height: 1024 }]
    }
  ];
  backendArchivedAdminHistory = [];
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
      if (url.includes("/api/prompts/") && init?.method === "PATCH") {
        const promptId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        const request = JSON.parse(String(init?.body)) as { tags?: string[] };
        backendWorkspace = {
          ...backendWorkspace,
          prompts: backendWorkspace.prompts.map((prompt) =>
            prompt.id === promptId
              ? { ...prompt, tags: Array.from(new Set((request.tags ?? prompt.tags).map((tag) => tag.toLowerCase()))) }
              : prompt
          )
        };
        return jsonResponse(backendWorkspace.prompts.find((prompt) => prompt.id === promptId));
      }
      if (url.includes("/api/prompts/") && init?.method === "DELETE") {
        const promptId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        backendWorkspace = { ...backendWorkspace, prompts: backendWorkspace.prompts.filter((prompt) => prompt.id !== promptId) };
        return jsonResponse(backendWorkspace.prompts);
      }
      if (url.endsWith("/api/assets") && init?.method === "POST") {
        const request = JSON.parse(String(init?.body)) as {
          title?: string;
          type?: LibraryAsset["type"];
          source?: string;
          tags?: string[];
          folder?: string;
          width?: number;
          height?: number;
        };
        const savedAsset: LibraryAsset = {
          id: `asset-hosted-${backendWorkspace.assets.length + 1}`,
          type: request.type ?? "image",
          title: request.title ?? "Saved asset",
          source: `/api/assets/asset-hosted-${backendWorkspace.assets.length + 1}/content`,
          tags: Array.from(new Set((request.tags ?? ["canvas"]).map((tag) => tag.trim().toLowerCase()).filter(Boolean))),
          createdAt: "2026-06-29T08:00:00.000Z",
          metadata: {
            folder: request.folder ?? "Unfiled",
            width: request.width,
            height: request.height,
            storage: "server",
            sourcePreview: request.source?.slice(0, 22)
          }
        };
        backendWorkspace = { ...backendWorkspace, assets: [savedAsset, ...backendWorkspace.assets] };
        return jsonResponse(savedAsset);
      }
      if (url.includes("/api/assets/") && init?.method === "PATCH") {
        const assetId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        const request = JSON.parse(String(init?.body)) as { tags?: string[]; folder?: string };
        backendWorkspace = {
          ...backendWorkspace,
          assets: backendWorkspace.assets.map((asset) =>
            asset.id === assetId
              ? {
                  ...asset,
                  tags: Array.from(new Set((request.tags ?? asset.tags).map((tag) => tag.trim().toLowerCase()).filter(Boolean))),
                  metadata: { ...asset.metadata, folder: request.folder?.trim() || asset.metadata?.folder }
                }
              : asset
          )
        };
        return jsonResponse(backendWorkspace.assets.find((asset) => asset.id === assetId));
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
      if (url.endsWith("/api/admin/history/archive") && init?.method === "POST") {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { historyIds?: string[]; reason?: string };
        const ids = new Set(request.historyIds ?? []);
        const archived = backendAdminHistory.filter((entry) => ids.has(entry.id));
        backendAdminHistory = backendAdminHistory.filter((entry) => !ids.has(entry.id));
        backendArchivedAdminHistory = [
          ...archived.map((entry) => ({
            ...entry,
            archivedAt: "2026-06-28T02:30:00.000Z",
            archivedBy: adminUserId,
            archiveReason: request.reason
          })),
          ...backendArchivedAdminHistory
        ];
        const auditEntry: AdminAuditEntry = {
          id: `admin-history-archive-${backendAdminAudit.length + 1}`,
          eventType: "history-archive",
          actorUserId: adminUserId,
          targetUserId: archived.length === 1 ? archived[0].userId : undefined,
          prompt: request.reason,
          summary: `Archived ${archived.length} team history record${archived.length === 1 ? "" : "s"}`,
          outputCount: archived.length,
          creditCost: 0,
          createdAt: new Date().toISOString()
        };
        backendAdminAudit = [auditEntry, ...backendAdminAudit];
        return jsonResponse({ archivedCount: archived.length, history: backendAdminHistory, auditEntry });
      }
      if (url.endsWith("/api/admin/history/restore") && init?.method === "POST") {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { historyIds?: string[]; reason?: string };
        const ids = new Set(request.historyIds ?? []);
        const restored = backendArchivedAdminHistory.filter((entry) => ids.has(entry.id));
        backendArchivedAdminHistory = backendArchivedAdminHistory.filter((entry) => !ids.has(entry.id));
        backendAdminHistory = [
          ...restored.map(({ archivedAt, archivedBy, archiveReason, ...entry }) => {
            void archivedAt;
            void archivedBy;
            void archiveReason;
            return entry;
          }),
          ...backendAdminHistory
        ];
        const auditEntry: AdminAuditEntry = {
          id: `admin-history-restore-${backendAdminAudit.length + 1}`,
          eventType: "history-restore",
          actorUserId: adminUserId,
          targetUserId: restored.length === 1 ? restored[0].userId : undefined,
          prompt: request.reason,
          summary: `Restored ${restored.length} team history record${restored.length === 1 ? "" : "s"}`,
          outputCount: restored.length,
          creditCost: 0,
          createdAt: new Date().toISOString()
        };
        backendAdminAudit = [auditEntry, ...backendAdminAudit];
        return jsonResponse({ restoredCount: restored.length, history: backendAdminHistory, auditEntry });
      }
      if (url.endsWith("/api/admin/history/delete") && init?.method === "POST") {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { historyIds?: string[]; reason?: string };
        const ids = new Set(request.historyIds ?? []);
        const deleted = backendArchivedAdminHistory.filter((entry) => ids.has(entry.id));
        backendArchivedAdminHistory = backendArchivedAdminHistory.filter((entry) => !ids.has(entry.id));
        const auditEntry: AdminAuditEntry = {
          id: `admin-history-delete-${backendAdminAudit.length + 1}`,
          eventType: "history-delete",
          actorUserId: adminUserId,
          targetUserId: deleted.length === 1 ? deleted[0].userId : undefined,
          prompt: request.reason,
          summary: `Permanently deleted ${deleted.length} archived team history record${deleted.length === 1 ? "" : "s"}`,
          outputCount: deleted.length,
          creditCost: 0,
          createdAt: new Date().toISOString()
        };
        backendAdminAudit = [auditEntry, ...backendAdminAudit];
        return jsonResponse({ deletedCount: deleted.length, history: backendAdminHistory, auditEntry });
      }
      if (url.includes("/api/admin/history")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const query = new URL(url, "http://localhost").searchParams;
        const from = query.get("from");
        const to = query.get("to");
        const fromTime = from ? Date.parse(from) : undefined;
        const toTime = to ? Date.parse(to) : undefined;
        const status = query.get("status");
        const sourceHistory =
          status === "archived"
            ? backendArchivedAdminHistory
            : status === "all"
              ? [...backendAdminHistory, ...backendArchivedAdminHistory]
              : backendAdminHistory;
        return jsonResponse(
          sourceHistory.filter((entry) => {
            if (query.get("userId") && entry.userId !== query.get("userId")) return false;
            if (query.get("projectId") && entry.projectId !== query.get("projectId")) return false;
            if (query.get("modelId") && entry.modelId !== query.get("modelId")) return false;
            if (query.get("operation") && entry.operation !== query.get("operation")) return false;
            const createdAt = Date.parse(entry.createdAt);
            if (fromTime !== undefined && createdAt < fromTime) return false;
            if (toTime !== undefined && createdAt > toTime) return false;
            return true;
          })
        );
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
        const project = backendWorkspace.projects.find((item) => item.id === request.projectId);
        const references = request.referenceNodeIds
          .map((referenceId) =>
            project?.nodes.find(
              (node) => node.id === referenceId || node.name === referenceId || (typeof node.metadata.sourceFile === "string" && node.metadata.sourceFile === referenceId)
            )
          )
          .filter((node): node is NonNullable<typeof node> => Boolean(node))
          .map((node) => ({ name: node.name, source: node.source, width: node.width, height: node.height }));
        backendProfile = {
          ...backendProfile,
          creditBalance: backendProfile.creditBalance - creditCost,
          creditUsed: backendProfile.creditUsed + creditCost,
          credits: backendProfile.creditBalance - creditCost
        };
        const providerProgress = {
          providerJobId: `provider-history-${backendHistory.length + 1}`,
          status: "succeeded",
          statusUrl: `https://provider.example/jobs/provider-history-${backendHistory.length + 1}`,
          pollAttempts: 1
        } satisfies NonNullable<HistoryEntry["providerProgress"]>;
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
          references,
          providerProgress,
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
          providerProgress,
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
    const promptLibrary = screen.getByText("Prompt library").closest(".dock-list") as HTMLElement;
    await user.click(promptLibrary.querySelector(".prompt-preset-main") as HTMLElement);
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

  it("offers a clear back-to-projects command from the canvas toolbar", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByRole("region", { name: "Infinite canvas" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to projects" }));

    expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch to new UI" })).not.toBeInTheDocument();
  });

  it("lets designers choose the prompt panel reference image before generating", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Upload images/i }));

    const referencePicker = screen.getByRole("combobox", { name: "Reference image" });
    await user.selectOptions(referencePicker, within(referencePicker).getByRole("option", { name: "Reference: reference-texture.jpg" }));
    const selectedReferenceId = (referencePicker as HTMLSelectElement).value;
    expect(screen.getByRole("button", { name: /Image reference-texture\.jpg/i })).toHaveClass("selected");
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Use the texture reference for a new embroidered jacket.");
    await user.click(screen.getAllByRole("button", { name: "Generate" })[0]);

    expect(await screen.findByRole("button", { name: /Image backend result 1\.jpg/i })).toBeInTheDocument();
    const generationCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const request = JSON.parse(String(generationCalls[generationCalls.length - 1]?.[1]?.body)) as GenerationRequest;
    expect(request.referenceNodeIds).toEqual([selectedReferenceId]);
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
    expect(screen.getByRole("option", { name: /Recraft V3.*8 credits.*generate.*edit/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /RunningHub Fashion Workflow.*8 credits.*generate.*edit.*upscale.*removeBackground/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /ComfyUI Fashion Workflow.*5 credits.*generate.*edit.*upscale.*removeBackground/i })).toBeInTheDocument();
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
    expect(imageNode).toHaveClass("selected");
    expect(screen.getByLabelText("Resize image top-left")).toBeInTheDocument();
    expect(screen.getByLabelText("Resize image top-right")).toBeInTheDocument();
    expect(screen.getByLabelText("Resize image bottom-left")).toBeInTheDocument();
    expect(screen.getByLabelText("Resize image bottom-right")).toBeInTheDocument();
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
    expect(document.querySelector(".stage")).toHaveClass("has-selection");

    const resizeHandle = screen.getByLabelText("Resize image bottom-right");
    await act(async () => {
      dispatchPointer(resizeHandle, "pointerdown", 1000, 650);
      dispatchPointer(window, "pointermove", 1060, 710);
      dispatchPointer(window, "pointerup", 1060, 710);
    });
    await waitFor(() => {
      expect(imageNode).toHaveStyle({ width: `${initialWidth + 60}px` });
    });

    let previousLeft = Number.parseInt(imageNode.style.left, 10);
    let previousTop = Number.parseInt(imageNode.style.top, 10);
    let previousWidth = Number.parseInt(imageNode.style.width, 10);
    const topLeftResizeHandle = screen.getByLabelText("Resize image top-left");
    await act(async () => {
      dispatchPointer(topLeftResizeHandle, "pointerdown", 700, 220);
      dispatchPointer(window, "pointermove", 650, 170);
      dispatchPointer(window, "pointerup", 650, 170);
    });
    await waitFor(() => {
      expect(Number.parseInt(imageNode.style.left, 10)).toBeLessThan(previousLeft);
      expect(Number.parseInt(imageNode.style.top, 10)).toBeLessThan(previousTop);
      expect(Number.parseInt(imageNode.style.width, 10)).toBeGreaterThan(previousWidth);
    });

    previousLeft = Number.parseInt(imageNode.style.left, 10);
    previousTop = Number.parseInt(imageNode.style.top, 10);
    previousWidth = Number.parseInt(imageNode.style.width, 10);
    const topRightResizeHandle = screen.getByLabelText("Resize image top-right");
    await act(async () => {
      dispatchPointer(topRightResizeHandle, "pointerdown", 1000, 220);
      dispatchPointer(window, "pointermove", 1000, 160);
      dispatchPointer(window, "pointerup", 1000, 160);
    });
    await waitFor(() => {
      expect(Number.parseInt(imageNode.style.left, 10)).toBe(previousLeft);
      expect(Number.parseInt(imageNode.style.top, 10)).toBeLessThan(previousTop);
      expect(Number.parseInt(imageNode.style.width, 10)).toBeGreaterThan(previousWidth);
    });

    previousLeft = Number.parseInt(imageNode.style.left, 10);
    previousTop = Number.parseInt(imageNode.style.top, 10);
    previousWidth = Number.parseInt(imageNode.style.width, 10);
    const bottomLeftResizeHandle = screen.getByLabelText("Resize image bottom-left");
    await act(async () => {
      dispatchPointer(bottomLeftResizeHandle, "pointerdown", 700, 650);
      dispatchPointer(window, "pointermove", 640, 650);
      dispatchPointer(window, "pointerup", 640, 650);
    });
    await waitFor(() => {
      expect(Number.parseInt(imageNode.style.left, 10)).toBeLessThan(previousLeft);
      expect(Number.parseInt(imageNode.style.top, 10)).toBe(previousTop);
      expect(Number.parseInt(imageNode.style.width, 10)).toBeGreaterThan(previousWidth);
    });
  });

  it("keeps every selected image resize corner inside the visible viewport", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 999 });
    const user = userEvent.setup();

    try {
      await login(user);
      await user.click(screen.getByRole("button", { name: "New project" }));

      const handleCenters = [
        "Resize image top-left",
        "Resize image top-right",
        "Resize image bottom-left",
        "Resize image bottom-right"
      ].map((label) => {
        const handle = screen.getByLabelText(label) as HTMLElement;
        return Number.parseFloat(handle.style.left) + 9;
      });

      expect(handleCenters.every((centerX) => centerX >= 0 && centerX <= window.innerWidth)).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    }
  });

  it("lets designers pan the infinite canvas by dragging blank canvas space", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const stageWorld = document.querySelector(".stage-world") as HTMLElement;
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

    expect(stageWorld).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });

    await act(async () => {
      dispatchPointer(stageWorld, "pointerdown", 420, 260);
      dispatchPointer(window, "pointermove", 500, 315);
      dispatchPointer(window, "pointerup", 500, 315);
    });

    await waitFor(() => {
      expect(stageWorld.style.transform).toContain("translate(80px, 55px) scale(1)");
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
    expect(stageWorld.style.transform).toContain("translate(340px, 70px) scale(1)");
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

  it("puts copy and delete actions directly in the selected image toolbar", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const imageNode = screen.getByRole("button", { name: /Image fashion-reference\.jpg/i });
    await user.click(imageNode);
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;
    const imageToolbar = within(screen.getByLabelText("selected image toolbar"));

    await user.click(imageToolbar.getByRole("button", { name: "Copy selected image" }));

    const copiedNode = await screen.findByRole("button", { name: /Image fashion-reference\.jpg copy/i });
    expect(screen.getAllByTestId("canvas-node")).toHaveLength(initialNodeCount + 1);

    await user.click(copiedNode);
    await user.click(within(screen.getByLabelText("selected image toolbar")).getByRole("button", { name: "Delete selected image" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Image fashion-reference\.jpg copy/i })).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId("canvas-node")).toHaveLength(initialNodeCount);
  });

  it("exposes the first-pass selected image toolbar operations with clear action names", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));

    const imageToolbar = within(screen.getByLabelText("selected image toolbar"));
    expect(imageToolbar.getByRole("button", { name: "Upscale selected image" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Remove selected image background" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Frame edit selected image" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Group selected references" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Save selected image to assets" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Download selected image" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Copy selected image" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Delete selected image" })).toBeInTheDocument();
    expect(imageToolbar.getByRole("button", { name: "Magic edit selected image" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /fashion-reference\.jpg prompt.*pleated silk/i })).toBeInTheDocument();
    expect(screen.getByText("Saved by Admin Ops")).toBeInTheDocument();

    await user.clear(promptBox);
    await user.click(screen.getByRole("button", { name: /fashion-reference\.jpg prompt.*pleated silk/i }));
    expect(promptBox).toHaveValue("Create a pleated silk vest with tiny tonal embroidery and clean studio lighting.");

    await user.click(screen.getByRole("button", { name: "Delete prompt fashion-reference.jpg prompt" }));
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prompts\/prompt-backend-\d+$/),
      expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ "x-user-id": "admin@company.local" }) })
    );
    expect(screen.queryByRole("button", { name: /fashion-reference\.jpg prompt.*pleated silk/i })).not.toBeInTheDocument();
  });

  it("filters prompt presets by reusable categories and favorites", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      prompts: [
        {
          id: "prompt-favorite-editorial",
          title: "Editorial silk cleanup",
          prompt: "Create a polished editorial silk variation with soft studio shadows.",
          tags: ["editorial", "favorite"],
          source: "designer",
          userId: "admin@company.local",
          designerName: "Admin Ops",
          createdAt: "2026-06-28T10:00:00.000Z"
        },
        {
          id: "prompt-ecommerce-cleanup",
          title: "Ecommerce background cleanup",
          prompt: "Remove clutter and keep ecommerce product edges crisp.",
          tags: ["ecommerce"],
          source: "designer",
          userId: "admin@company.local",
          designerName: "Admin Ops",
          createdAt: "2026-06-28T10:05:00.000Z"
        }
      ]
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Prompts" }));
    const promptLibrary = screen.getByText("Prompt library").closest(".dock-list") as HTMLElement;

    expect(within(promptLibrary).getByText("Editorial silk cleanup")).toBeInTheDocument();
    expect(within(promptLibrary).getByText("Ecommerce background cleanup")).toBeInTheDocument();

    await user.click(within(promptLibrary).getByRole("button", { name: "Show favorite prompts" }));

    expect(within(promptLibrary).getByText("Editorial silk cleanup")).toBeInTheDocument();
    expect(within(promptLibrary).queryByText("Ecommerce background cleanup")).not.toBeInTheDocument();
    expect(within(promptLibrary).getByText("1 favorite prompt")).toBeInTheDocument();

    await user.click(within(promptLibrary).getByRole("button", { name: "Show all prompts" }));
    await user.click(within(promptLibrary).getByRole("button", { name: "Filter prompts by ecommerce" }));

    expect(within(promptLibrary).queryByText("Editorial silk cleanup")).not.toBeInTheDocument();
    expect(within(promptLibrary).getByText("Ecommerce background cleanup")).toBeInTheDocument();
    expect(within(promptLibrary).getByText("1 prompt tagged ecommerce")).toBeInTheDocument();
  });

  it("lets designers favorite prompt presets and persist the reusable tag", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      prompts: [
        {
          id: "prompt-ecommerce-cleanup",
          title: "Ecommerce background cleanup",
          prompt: "Remove clutter and keep ecommerce product edges crisp.",
          tags: ["ecommerce"],
          source: "designer",
          userId: "admin@company.local",
          designerName: "Admin Ops",
          createdAt: "2026-06-28T10:05:00.000Z"
        }
      ]
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Prompts" }));

    const promptLibrary = screen.getByText("Prompt library").closest(".dock-list") as HTMLElement;
    await user.click(within(promptLibrary).getByRole("button", { name: "Add prompt favorite Ecommerce background cleanup" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prompts\/prompt-ecommerce-cleanup$/),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ tags: ["favorite", "ecommerce"] })
      })
    );
    expect(within(promptLibrary).getByRole("button", { name: "Remove prompt favorite Ecommerce background cleanup" })).toBeInTheDocument();
    expect(within(promptLibrary).getByText("favorite, ecommerce")).toBeInTheDocument();

    await user.click(within(promptLibrary).getByRole("button", { name: "Show favorite prompts" }));

    expect(within(promptLibrary).getByText("Ecommerce background cleanup")).toBeInTheDocument();
    expect(within(promptLibrary).getByText("1 favorite prompt")).toBeInTheDocument();
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

  it("lets designers pause and resume a running backend batch queue", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation();
    let resolveFirstGeneration: (response: Response) => void = () => {};
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/generations")) {
        const request = JSON.parse(String(init?.body)) as GenerationRequest;
        if (request.referenceNodeIds[0] === "pause-front.png") {
          return new Promise<Response>((resolve) => {
            resolveFirstGeneration = resolve;
          });
        }
      }
      return originalFetch?.(input, init) ?? jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    });
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const folderInput = screen.getByLabelText("Batch folder input");
    const first = new File(["front look"], "pause-front.png", { type: "image/png" });
    const second = new File(["back look"], "pause-back.png", { type: "image/png" });

    await user.upload(folderInput, [first, second]);

    expect(await screen.findByText("Running backend batch for 2 images...")).toBeInTheDocument();
    expect(await screen.findByText("Batch queue")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause remaining batch items" }));

    expect(await screen.findByText("Batch queue paused")).toBeInTheDocument();
    expect(screen.getAllByText("paused").length).toBeGreaterThanOrEqual(1);

    resolveFirstGeneration(
      new Response(
        JSON.stringify({
          status: "succeeded",
          creditCost: 2,
          historyId: "history-pause-front",
          outputs: [{ name: "pause-front-result.jpg", source: "mock://pause/front", width: 512, height: 512 }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    expect(await screen.findByText("Backend batch stopped after 1 of 2 images; 0 failed; 1 skipped")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume paused batch items" }));

    expect(await screen.findByText("Backend batch completed for 1 images")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("done").length).toBeGreaterThanOrEqual(2));
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
    expect(screen.getByRole("img", { name: "Team history original alice-original.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.getByText("Bob Designer · Bob upscale · upscale-pro")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history original bob-original.jpg" })).toBeInTheDocument();
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

  it("lets admins pick a designer account before changing credits or limits", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    await screen.findByText("Team accounts");
    await user.click(await screen.findByRole("button", { name: "Manage credits for Alice Designer" }));

    expect(screen.getByRole("textbox", { name: "Designer account" })).toHaveValue("alice@company.local");
    expect(screen.getByRole("textbox", { name: "Limit designer account" })).toHaveValue("alice@company.local");
    expect(screen.getByRole("spinbutton", { name: "Credit limit" })).toHaveValue(120);
    expect(screen.getByText("Managing credits for Alice Designer: 88 remaining")).toBeInTheDocument();
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

  it("filters admin team history by project, model, type, and recent time window", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    expect(await screen.findByText("Team history")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Team history designer filter" }), "bob@company.local");
    await user.selectOptions(screen.getByRole("combobox", { name: "Team history project filter" }), "bob-upscale");
    await user.selectOptions(screen.getByRole("combobox", { name: "Team history model filter" }), "upscale-pro");
    await user.selectOptions(screen.getByRole("combobox", { name: "Team history type filter" }), "upscale");
    await user.selectOptions(screen.getByRole("combobox", { name: "Team history time filter" }), "recent-30");

    const adminHistoryCalls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.includes("/api/admin/history"));
    const adminHistoryCall = adminHistoryCalls[adminHistoryCalls.length - 1];
    expect(adminHistoryCall).toBeDefined();
    const query = new URL(adminHistoryCall!, "http://localhost").searchParams;
    expect(query.get("userId")).toBe("bob@company.local");
    expect(query.get("projectId")).toBe("bob-upscale");
    expect(query.get("modelId")).toBe("upscale-pro");
    expect(query.get("operation")).toBe("upscale");
    expect(query.get("from")).toBe("2026-05-29T02:10:00.000Z");
    expect(query.get("to")).toBe("2026-06-28T02:10:00.000Z");
    expect(screen.queryByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).not.toBeInTheDocument();
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

  it("exports the filtered admin team history as CSV for finance review", async () => {
    backendAdminHistory = backendAdminHistory.map((entry) =>
      entry.userId === "bob@company.local"
        ? { ...entry, prompt: "Bob upscale pass, preserve edges\nSecond line" }
        : entry
    );
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
        return "blob:team-history-csv-export";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    try {
      await user.click(screen.getByRole("button", { name: "Export team history CSV" }));
      const exportedText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exportedBlob!);
      });

      expect(exportAnchor?.download).toBe("team-history-bob-company-local.csv");
      expect(exportedBlob?.type).toBe("text/csv;charset=utf-8");
      expect(exportedText).toContain("designerName,userId,projectName,modelId,operation,outputCount,creditCost,priceCents,currency,prompt,outputSources,createdAt");
      expect(exportedText).toContain('"Bob upscale pass, preserve edges\nSecond line"');
      expect(exportedText).toContain("/fixtures/bob-upscale-1.jpg");
      expect(exportedText).not.toContain("Alice campaign cleanup");
    } finally {
      createElementSpy.mockRestore();
      if (previousCreateObjectURL) Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (previousRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("exports only selected admin team history rows as CSV", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    await screen.findByText("Team history");
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output bob-upscale-1.jpg" })).toBeInTheDocument();

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
        return "blob:selected-team-history-csv-export";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    try {
      await user.click(screen.getByRole("checkbox", { name: "Select team history history-bob-team-1" }));
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Export selected team history CSV" }));
      const exportedText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exportedBlob!);
      });

      expect(exportAnchor?.download).toBe("team-history-selected.csv");
      expect(exportedBlob?.type).toBe("text/csv;charset=utf-8");
      expect(exportedText).toContain("Bob Designer,bob@company.local,Bob upscale,upscale-pro");
      expect(exportedText).toContain("/fixtures/bob-upscale-1.jpg");
      expect(exportedText).not.toContain("Alice Designer");
      expect(exportedText).not.toContain("Alice campaign cleanup");
    } finally {
      createElementSpy.mockRestore();
      if (previousCreateObjectURL) Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (previousRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
  });

  it("archives selected admin team history rows from the default team review list", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    await screen.findByText("Team history");
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output bob-upscale-1.jpg" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select team history history-bob-team-1" }));
    await user.click(screen.getByRole("button", { name: "Archive selected team history" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/admin\/history\/archive$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-user-id": "admin@company.local" }),
        body: expect.stringContaining("history-bob-team-1")
      })
    );
    expect((await screen.findAllByText("Archived 1 team history record")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("img", { name: "Team history output bob-upscale-1.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(screen.getByText(/history-archive/i)).toBeInTheDocument();
  });

  it("lets admins review archived team history and either restore or permanently delete selected rows", async () => {
    const archivedBob = {
      ...backendAdminHistory.find((entry) => entry.id === "history-bob-team-1")!,
      archivedAt: "2026-06-28T02:30:00.000Z",
      archivedBy: "admin@company.local",
      archiveReason: "duplicate provider test"
    };
    const archivedAlice = {
      ...backendAdminHistory.find((entry) => entry.id === "history-alice-team-1")!,
      id: "history-alice-archived-1",
      archivedAt: "2026-06-28T02:35:00.000Z",
      archivedBy: "admin@company.local",
      archiveReason: "finance exported"
    };
    backendAdminHistory = backendAdminHistory.filter((entry) => entry.id === "history-alice-team-1");
    backendArchivedAdminHistory = [archivedBob, archivedAlice];
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));
    await screen.findByText("Team history");

    await user.selectOptions(screen.getByRole("combobox", { name: "Team history status filter" }), "archived");
    expect(await screen.findByRole("img", { name: "Team history output bob-upscale-1.jpg" })).toBeInTheDocument();
    expect(screen.getAllByText(/Archived by admin@company.local/)).toHaveLength(2);
    expect(screen.getByText(/duplicate provider test/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select team history history-bob-team-1" }));
    await user.click(screen.getByRole("button", { name: "Restore selected team history" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/admin\/history\/restore$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-user-id": "admin@company.local" }),
        body: expect.stringContaining("history-bob-team-1")
      })
    );
    expect((await screen.findAllByText("Restored 1 team history record")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("img", { name: "Team history output bob-upscale-1.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select team history history-alice-archived-1" }));
    await user.click(screen.getByRole("button", { name: "Permanently delete selected team history" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/admin\/history\/delete$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-user-id": "admin@company.local" }),
        body: expect.stringContaining("history-alice-archived-1")
      })
    );
    expect((await screen.findAllByText("Permanently deleted 1 archived team history record")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("img", { name: "Team history output alice-cleanup-1.jpg" })).not.toBeInTheDocument();
    expect(screen.getByText(/history-delete/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /Mask edit model GPT Image 2 Medium/i }));
    await user.click(screen.getByRole("option", { name: /Nano Banana 2.*11 credits/i }));
    expect(screen.getByRole("button", { name: /Mask edit model Nano Banana 2/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "circle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "rectangle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "freehand" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "circle" }));
    expect(screen.getByRole("application", { name: "Mask placement preview" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "Mask size" }), { target: { value: "60" } });
    expect(screen.getByLabelText("Mask coordinates")).toHaveTextContent("w 60");
    await user.click(screen.getByRole("button", { name: "Confirm edit" }));
    expect(screen.getByText("fashion-reference.jpg mask edit")).toBeInTheDocument();
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend mask edit succeeded, 11 credits used")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Context" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg mask edit/i }));
    expect(screen.getByRole("region", { name: "Selected node task" })).toHaveTextContent("Mask shape: circle");
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/edits$/), expect.objectContaining({ method: "POST" }));
    const editCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/edits"));
    const editRequest = JSON.parse(String(editCall?.[1]?.body)) as GenerationRequest;
    expect(editRequest.modelId).toBe("nanobanana2");
    expect(editRequest.mask).toMatchObject({ width: 60, height: 52 });

    await user.click(screen.getByRole("button", { name: /Target frame/i }));
    expect(screen.getByText("Generation target frame")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-image-2-medium").length).toBeGreaterThan(0);
  });

  it("records freehand mask paths when confirming local image edits", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Edit area/i }));
    await user.click(screen.getByRole("button", { name: "freehand" }));
    const preview = screen.getByRole("application", { name: "Mask placement preview" });
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({})
    });
    const drawPoint = (type: "pointerdown" | "pointermove", clientX: number, clientY: number) => {
      const event = createEvent[type === "pointerdown" ? "pointerDown" : "pointerMove"](preview, { pointerId: 1, buttons: 1 });
      Object.defineProperty(event, "clientX", { value: clientX });
      Object.defineProperty(event, "clientY", { value: clientY });
      Object.defineProperty(event, "buttons", { value: 1 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(preview, event);
    };
    drawPoint("pointerdown", 40, 60);
    drawPoint("pointermove", 90, 120);
    drawPoint("pointermove", 140, 80);
    await user.click(screen.getByRole("button", { name: "Confirm edit" }));

    const editCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/edits"));
    const editRequest = JSON.parse(String(editCall?.[1]?.body)) as GenerationRequest;
    expect(editRequest.mask).toMatchObject({
      path: [
        { x: 20, y: 30 },
        { x: 45, y: 60 },
        { x: 70, y: 40 }
      ]
    });
  });

  it("runs toolbar upscale through the backend operation API", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Upscale selected image" }));

    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend upscale succeeded, 4 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/upscale$/), expect.objectContaining({ method: "POST" }));
  });

  it("routes Make Mockup and Vectorize through the shared generation flow", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Text Prompt note/i }));
    const initialGenerationCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations")).length;

    await user.click(screen.getByRole("button", { name: "Make Mockup" }));

    expect(await screen.findByText("Backend generate succeeded, 7 credits used")).toBeInTheDocument();
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"))).toHaveLength(initialGenerationCalls + 1);
    });
    const mockupGenerationCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const mockupCall = mockupGenerationCalls[mockupGenerationCalls.length - 1];
    const mockupRequest = JSON.parse(String(mockupCall?.[1]?.body)) as GenerationRequest;
    expect(mockupRequest).toMatchObject({
      operation: "generate",
      modelId: "gpt-image-2-medium",
      outputCount: 1
    });
    expect(mockupRequest.prompt).toContain("product mockup");

    await user.click(screen.getByRole("button", { name: "Vectorize" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"))).toHaveLength(initialGenerationCalls + 2);
    });
    const vectorGenerationCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    const vectorCall = vectorGenerationCalls[vectorGenerationCalls.length - 1];
    const vectorRequest = JSON.parse(String(vectorCall?.[1]?.body)) as GenerationRequest;
    expect(vectorRequest).toMatchObject({
      operation: "generate",
      modelId: "gpt-image-2-medium",
      outputCount: 1
    });
    expect(vectorRequest.prompt).toContain("vector-style");
    expect(screen.getAllByText("backend result 1.jpg").length).toBeGreaterThan(0);
  });

  it("shows a clear notice instead of submitting preset tools when no image exists in the project", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Image fashion-reference\.jpg/i })).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Text Prompt note/i }));
    const initialGenerationCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations")).length;

    await user.click(screen.getByRole("button", { name: "Make Mockup" }));

    expect(screen.getByText("Add or select an image before running this tool")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"))).toHaveLength(initialGenerationCalls);
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
      await user.click(screen.getByRole("button", { name: "Download selected image" }));
      expect(downloadAnchor?.download).toBe("fashion-reference.jpg");
      expect(downloadAnchor?.href).toContain("/fixtures/fashion-reference.jpg");
    } finally {
      createElementSpy.mockRestore();
    }

    await user.click(screen.getByRole("button", { name: "Magic edit selected image" }));
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
    const stage = screen.getByRole("region", { name: "Infinite canvas" });
    const front = new File(["front reference"], "dropped-front.png", { type: "image/png" });
    const dropEvent = createEvent.drop(stage, {
      dataTransfer: { files: [front], dropEffect: "copy" }
    });
    Object.defineProperties(dropEvent, {
      clientX: { value: 320 },
      clientY: { value: 280 }
    });
    fireEvent(stage, dropEvent);
    await user.click(await screen.findByRole("button", { name: /Image dropped-front\.png/i }));
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;

    await user.click(screen.getByRole("button", { name: "Save selected image to assets" }));

    expect(screen.getByText("My assets")).toBeInTheDocument();
    const assetPostCall = await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, init]) => url.toString().endsWith("/api/assets") && init?.method === "POST");
      expect(call).toBeTruthy();
      return call;
    });
    const assetPayload = JSON.parse(String(assetPostCall?.[1]?.body)) as { title: string; source: string; folder: string };
    expect(assetPayload).toMatchObject({ title: "dropped-front.png" });
    expect(assetPayload.folder).toMatch(/^Untitled/);
    expect(assetPayload.source).toMatch(/^data:image\/png;base64,/);
    const savedAsset = await screen.findByRole("button", { name: /dropped-front\.png.*Use in canvas/i });
    expect(savedAsset).toBeInTheDocument();
    expect(backendWorkspace.assets[0]).toMatchObject({
      title: "dropped-front.png",
      source: "/api/assets/asset-hosted-1/content",
      metadata: { storage: "server" }
    });

    await user.click(savedAsset);

    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node")).toHaveLength(initialNodeCount + 1);
    });
    expect(screen.getAllByRole("button", { name: /Image dropped-front\.png/i }).length).toBeGreaterThan(1);
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

  it("searches saved assets by title and tag in the canvas dock", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      assets: [
        {
          id: "asset-edit-reference",
          type: "image",
          title: "embroidered-reference.jpg",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "edit", "embroidery"],
          createdAt: "2026-06-28T10:00:00.000Z"
        },
        {
          id: "asset-remove-bg",
          type: "image",
          title: "cutout-result.png",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "removebackground", "cutout"],
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

    const searchAssets = screen.getByRole("textbox", { name: "Search assets" });
    await user.type(searchAssets, "cutout");

    expect(screen.queryByRole("button", { name: /embroidered-reference\.jpg.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cutout-result\.png.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.getByText("1 asset matching cutout")).toBeInTheDocument();

    await user.clear(searchAssets);
    await user.type(searchAssets, "embroidery");

    expect(screen.getByRole("button", { name: /embroidered-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cutout-result\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 asset matching embroidery")).toBeInTheDocument();
  });

  it("filters saved assets by reusable folders in the canvas dock", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      assets: [
        {
          id: "asset-editorial",
          type: "image",
          title: "editorial-reference.jpg",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "edit"],
          createdAt: "2026-06-28T10:00:00.000Z",
          metadata: { folder: "Editorial" }
        },
        {
          id: "asset-ecommerce",
          type: "image",
          title: "ecommerce-cutout.png",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "removebackground"],
          createdAt: "2026-06-28T10:05:00.000Z",
          metadata: { folder: "Ecommerce" }
        }
      ]
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Assets" }));

    expect(screen.getByRole("button", { name: /editorial-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ecommerce-cutout\.png.*Use in canvas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter assets by folder Editorial" }));

    expect(screen.getByRole("button", { name: /editorial-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ecommerce-cutout\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 asset in folder Editorial")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all folders" }));

    expect(screen.getByRole("button", { name: /editorial-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ecommerce-cutout\.png.*Use in canvas/i })).toBeInTheDocument();
  });

  it("filters saved assets by operation and orientation metadata in the canvas dock", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      assets: [
        {
          id: "asset-upscale-landscape",
          type: "image",
          title: "campaign-upscale.png",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "upscale"],
          createdAt: "2026-06-28T10:00:00.000Z",
          metadata: { folder: "Campaign A", operation: "upscale", width: 1536, height: 1024 }
        },
        {
          id: "asset-edit-portrait",
          type: "image",
          title: "lookbook-edit.png",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "edit"],
          createdAt: "2026-06-28T10:05:00.000Z",
          metadata: { folder: "Campaign A", operation: "edit", width: 800, height: 1200 }
        },
        {
          id: "asset-remove-bg-square",
          type: "image",
          title: "ecommerce-cutout.png",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated", "removebackground"],
          createdAt: "2026-06-28T10:10:00.000Z",
          metadata: { folder: "Ecommerce", operation: "removeBackground", width: 1024, height: 1024 }
        }
      ]
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Assets" }));

    expect(screen.getByText("Operation: upscale / 1536x1024 / Landscape")).toBeInTheDocument();
    expect(screen.getByText("Operation: edit / 800x1200 / Portrait")).toBeInTheDocument();
    expect(screen.getByText("Operation: removeBackground / 1024x1024 / Square")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter assets by operation upscale" }));

    expect(screen.getByRole("button", { name: /campaign-upscale\.png.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /lookbook-edit\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ecommerce-cutout\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 asset from operation upscale")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all operations" }));
    await user.click(screen.getByRole("button", { name: "Filter assets by orientation Portrait" }));

    expect(screen.getByRole("button", { name: /lookbook-edit\.png.*Use in canvas/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /campaign-upscale\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ecommerce-cutout\.png.*Use in canvas/i })).not.toBeInTheDocument();
    expect(screen.getByText("1 asset with Portrait orientation")).toBeInTheDocument();
  });

  it("lets designers edit saved asset folders and tags for reusable organization", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      assets: [
        {
          id: "asset-editorial",
          type: "image",
          title: "editorial-reference.jpg",
          source: "/fixtures/fashion-reference.jpg",
          tags: ["generated"],
          createdAt: "2026-06-28T10:00:00.000Z",
          metadata: { folder: "Unfiled" }
        }
      ]
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: "Assets" }));

    await user.click(screen.getByRole("button", { name: "Edit asset metadata editorial-reference.jpg" }));
    await user.clear(screen.getByRole("textbox", { name: "Asset folder" }));
    await user.type(screen.getByRole("textbox", { name: "Asset folder" }), "Campaign A");
    await user.clear(screen.getByRole("textbox", { name: "Asset tags" }));
    await user.type(screen.getByRole("textbox", { name: "Asset tags" }), "Editorial, reference, reference");
    await user.click(screen.getByRole("button", { name: "Save asset metadata" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/assets\/asset-editorial$/),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ tags: ["editorial", "reference"], folder: "Campaign A" })
      })
    );
    expect(screen.getByText("Folder: Campaign A")).toBeInTheDocument();
    expect(screen.getByText("editorial, reference")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter assets by folder Campaign A" }));

    expect(screen.getByText("1 asset in folder Campaign A")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /editorial-reference\.jpg.*Use in canvas/i })).toBeInTheDocument();
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

  it("marks final workflow handoffs after backend workflow modules complete", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Remove BG node" }));
    const removeBgModule = await screen.findByRole("button", { name: /Workflow removeBackground module/i });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from removeBackground module"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Final approved handoff/i }));
    const finalModule = await screen.findByRole("button", { name: /Workflow final module/i });

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Backend workflow completed 1 module")).toBeInTheDocument();
    expect(removeBgModule).toHaveTextContent("Done");
    expect(finalModule).toHaveTextContent("Done");

    await user.click(screen.getByRole("button", { name: "Assets" }));

    expect(await screen.findByText("final module final")).toBeInTheDocument();
    expect(screen.getByText("final, handoff, download")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/remove-bg"))).toHaveLength(1);
  });

  it("allows a final-only workflow handoff without submitting model requests", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Final node" }));
    const finalModule = await screen.findByRole("button", { name: /Workflow final module/i });

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Workflow final handoff completed")).toBeInTheDocument();
    expect(finalModule).toHaveTextContent("Done");
    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(await screen.findByText("final module final")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => /\/api\/(generations|edits|upscale|remove-bg)$/.test(url.toString()))).toHaveLength(0);
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
    expect(screen.getByRole("button", { name: "Final node" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Final node" }));

    expect(await screen.findByRole("button", { name: /Workflow final module/i })).toBeInTheDocument();
    expect(screen.getAllByText("Mark this image as the approved final handoff for review.").length).toBeGreaterThan(0);
    expect(screen.getByText("handoff-final")).toBeInTheDocument();

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

  it("creates a standard workflow chain from the context dock", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Create standard workflow chain" }));

    expect(await screen.findByText("Standard workflow chain created")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Workflow upload module/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workflow generate module/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workflow edit module/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workflow upscale module/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workflow removeBackground module/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Workflow final module/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Workflow execution plan")).toHaveTextContent("5 executable steps");
    expect(screen.getByLabelText("Workflow execution plan")).toHaveTextContent("removeBackground / background-cleaner / 1 refs");
  });

  it("falls back to the project image when creating a standard chain from a text selection", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Text Prompt note/i }));
    await user.click(screen.getByRole("button", { name: "Create standard workflow chain" }));

    expect(await screen.findByText("Standard workflow chain created")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Workflow upload module/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Workflow execution plan")).toHaveTextContent("5 executable steps");
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

  it("sends advanced provider settings from workflow settings nodes", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Generate node" }));
    await screen.findByRole("button", { name: /Workflow generate module/i });
    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: "Settings node" }));
    await screen.findByRole("button", { name: /Workflow settings/i });

    await user.selectOptions(screen.getByLabelText("Provider size"), "1024x1536");
    await user.selectOptions(screen.getByLabelText("Provider quality"), "medium");
    await user.type(screen.getByLabelText("Provider webapp ID"), "rh-webapp-7788");
    await user.selectOptions(screen.getByLabelText("Provider task type"), "ASYNC");
    await user.type(screen.getByLabelText("Provider instance type"), "plus");
    fireEvent.change(screen.getByLabelText("RunningHub node info JSON"), {
      target: {
        value: JSON.stringify([
          { nodeId: "3", fieldName: "prompt", fieldValue: "clean product shadow", valueType: "text" },
          { nodeId: "9", fieldName: "image", fieldValue: "uploaded-reference.png", valueType: "image" }
        ])
      }
    });
    fireEvent.change(screen.getByLabelText("ComfyUI workflow JSON"), {
      target: { value: JSON.stringify({ nodes: [{ id: "12", type: "KSampler" }] }) }
    });
    await user.click(screen.getByRole("checkbox", { name: "Provider add metadata" }));

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from Workflow settings"));
    fireEvent.pointerUp(screen.getByLabelText("Provider settings input port on generate module"));

    await user.click(screen.getByRole("button", { name: /Image fashion-reference\.jpg/i }));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));
    expect(await screen.findByText("Backend workflow completed 1 module")).toBeInTheDocument();

    const generationCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/generations"));
    const request = JSON.parse(String(generationCall?.[1]?.body)) as GenerationRequest;
    expect(request.providerSettings).toMatchObject({
      size: "1024x1536",
      quality: "medium",
      webappId: "rh-webapp-7788",
      taskType: "ASYNC",
      instanceType: "plus",
      addMetadata: true,
      nodeInfoList: [
        { nodeId: "3", fieldName: "prompt", fieldValue: "clean product shadow", valueType: "text" },
        { nodeId: "9", fieldName: "image", fieldValue: "uploaded-reference.png", valueType: "image" }
      ],
      workflow: { nodes: [{ id: "12", type: "KSampler" }] }
    });
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

    const projectCard = screen.getByRole("button", { name: "Open project Untitled 1" });
    expect(within(projectCard).getByRole("img", { name: "Project Untitled 1 preview fashion-reference.jpg" })).toBeInTheDocument();
    expect(within(projectCard).getByRole("img", { name: "Project Untitled 1 preview backend result 1.jpg" })).toBeInTheDocument();
    expect(projectCard).toHaveTextContent("3 nodes / 1 history / 7 credits spent");
    expect(projectCard).toHaveTextContent("1 outputs");
    expect(projectCard).toHaveTextContent("1 results");

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("region", { name: "History management" })).toBeInTheDocument();
    expect(screen.getAllByText(/生成一款带盘扣的黑色马甲/).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "History original fashion-reference.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "History thumbnail grid" })).toBeInTheDocument();
    const historyCard = screen.getByRole("article", { name: "History record history-1" });
    expect(within(historyCard).getByRole("img", { name: "History grid output backend result 1.jpg" })).toBeInTheDocument();
    expect(within(historyCard).getByRole("img", { name: "History grid original fashion-reference.jpg" })).toBeInTheDocument();
    expect(within(historyCard).getByText("Project")).toBeInTheDocument();
    expect(within(historyCard).getByText("Untitled 1")).toBeInTheDocument();
    expect(within(historyCard).getByText("Operator")).toBeInTheDocument();
    expect(within(historyCard).getByText("Lina Zhou")).toBeInTheDocument();
    expect(within(historyCard).getByText("Outputs")).toBeInTheDocument();
    expect(within(historyCard).getAllByText("1").length).toBeGreaterThan(0);
    expect(within(historyCard).getByText("Credits")).toBeInTheDocument();
    expect(within(historyCard).getByText("7")).toBeInTheDocument();
    const thumbnailGrid = screen.getByRole("group", { name: "History thumbnails for history-1" });
    expect(within(thumbnailGrid).getByText("Original")).toBeInTheDocument();
    expect(within(thumbnailGrid).getByText("Result")).toBeInTheDocument();
    const originalThumbnail = within(thumbnailGrid).getByRole("img", { name: "History original fashion-reference.jpg" });
    const outputThumbnail = within(thumbnailGrid).getByRole("img", { name: "History output backend result 1.jpg" });
    expect(originalThumbnail).toHaveAttribute("width", "56");
    expect(originalThumbnail).toHaveAttribute("height", "56");
    expect(outputThumbnail).toHaveAttribute("width", "56");
    expect(outputThumbnail).toHaveAttribute("height", "56");
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

  it("opens a clicked home history output thumbnail on its generated canvas node", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "open this generated image from history");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);
    await screen.findByText("backend result 1.jpg");

    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "History" }));
    await user.click(screen.getByRole("button", { name: "Open history output backend result 1.jpg" }));

    const selectedCanvasNode = document.querySelector(".stage-node.selected") as HTMLElement | null;
    expect(selectedCanvasNode).toBeTruthy();
    expect(within(selectedCanvasNode!).getByText("backend result 1.jpg")).toBeInTheDocument();
  });

  it("filters home history records by project", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "first project embroidery concept");
    let generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);
    await screen.findByText("backend result 1.jpg");

    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "second project cutout direction");
    generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);
    await screen.findByText("backend result 1.jpg");

    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByText("first project embroidery concept").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("second project cutout direction").length).toBeGreaterThanOrEqual(1);

    const projectFilter = screen.getByRole("combobox", { name: "History project filter" });
    await user.selectOptions(projectFilter, screen.getByRole("option", { name: "Untitled 1" }));

    expect(screen.getAllByText("first project embroidery concept").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("second project cutout direction")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 records")).toBeInTheDocument();

    await user.selectOptions(projectFilter, "all");

    expect(screen.getAllByText("first project embroidery concept").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("second project cutout direction").length).toBeGreaterThanOrEqual(1);
  });

  it("filters home history records by model, type, designer, and recent time window", async () => {
    backendHistory = [
      {
        id: "history-filter-generate",
        projectId: "project-filter-a",
        projectName: "Filter campaign",
        nodeId: "node-filter-a",
        prompt: "recent generate campaign",
        modelId: "gpt-image-2-medium",
        outputCount: 1,
        creditCost: 7,
        operation: "generate",
        referenceCount: 1,
        userId: "lina@company.local",
        designerName: "Lina Zhou",
        createdAt: "2026-06-28T02:00:00.000Z",
        outputs: [{ name: "recent-generate.jpg", source: "/fixtures/recent-generate.jpg", width: 1024, height: 1024 }]
      },
      {
        id: "history-filter-upscale",
        projectId: "project-filter-b",
        projectName: "Filter upscale",
        nodeId: "node-filter-b",
        prompt: "recent upscale pass",
        modelId: "upscale-pro",
        outputCount: 1,
        creditCost: 4,
        operation: "upscale",
        referenceCount: 1,
        userId: "maya@company.local",
        designerName: "Maya Chen",
        createdAt: "2026-06-27T02:00:00.000Z",
        outputs: [{ name: "recent-upscale.jpg", source: "/fixtures/recent-upscale.jpg", width: 1024, height: 1024 }]
      },
      {
        id: "history-filter-old-edit",
        projectId: "project-filter-a",
        projectName: "Filter campaign",
        nodeId: "node-filter-c",
        prompt: "old edit archive",
        modelId: "nanobanana2",
        outputCount: 1,
        creditCost: 11,
        operation: "edit",
        referenceCount: 1,
        userId: "lina@company.local",
        designerName: "Lina Zhou",
        createdAt: "2026-05-01T02:00:00.000Z",
        outputs: [{ name: "old-edit.jpg", source: "/fixtures/old-edit.jpg", width: 1024, height: 1024 }]
      }
    ];
    backendWorkspace = { ...backendWorkspace, history: backendHistory };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByText("recent generate campaign").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("recent upscale pass").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("old edit archive").length).toBeGreaterThanOrEqual(1);

    await user.selectOptions(screen.getByRole("combobox", { name: "History model filter" }), "upscale-pro");
    expect(screen.queryByText("recent generate campaign")).not.toBeInTheDocument();
    expect(screen.getAllByText("recent upscale pass").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("old edit archive")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 records")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "History model filter" }), "all");
    await user.selectOptions(screen.getByRole("combobox", { name: "History type filter" }), "edit");
    expect(screen.getAllByText("old edit archive").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("recent generate campaign")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "History type filter" }), "all");
    await user.selectOptions(screen.getByRole("combobox", { name: "History designer filter" }), "maya@company.local");
    expect(screen.getAllByText("recent upscale pass").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("old edit archive")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "History designer filter" }), "all");
    await user.selectOptions(screen.getByRole("combobox", { name: "History time filter" }), "recent-7");
    expect(screen.getAllByText("recent generate campaign").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("recent upscale pass").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("old edit archive")).not.toBeInTheDocument();
    expect(screen.getByText("2 of 3 records")).toBeInTheDocument();
  });

  it("shows provider progress details in designer history records", async () => {
    backendHistory = [
      {
        id: "history-provider-progress",
        projectId: "project-provider-progress",
        projectName: "Provider audit",
        nodeId: "node-provider-progress",
        prompt: "track the external provider job",
        modelId: "nanobanana2",
        outputCount: 1,
        creditCost: 11,
        operation: "generate",
        referenceCount: 1,
        userId: "lina@company.local",
        designerName: "Lina Zhou",
        createdAt: "2026-06-28T02:00:00.000Z",
        providerProgress: {
          providerJobId: "nano-job-7788",
          status: "succeeded",
          statusUrl: "https://provider.example/jobs/nano-job-7788",
          pollAttempts: 2
        },
        outputs: [{ name: "provider-output.jpg", source: "/fixtures/provider-output.jpg", width: 1024, height: 1024 }]
      }
    ];
    backendWorkspace = { ...backendWorkspace, history: backendHistory };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByText("track the external provider job").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Provider succeeded / nano-job-7788 / 2 polls")).toBeInTheDocument();
  });

  it("exports the filtered designer history CSV with original and result image sources", async () => {
    backendHistory = [
      {
        id: "history-export-generate",
        projectId: "project-export-a",
        projectName: "Export campaign",
        nodeId: "node-export-a",
        prompt: "export this generated look",
        modelId: "gpt-image-2-medium",
        outputCount: 2,
        creditCost: 14,
        operation: "generate",
        referenceCount: 1,
        userId: "lina@company.local",
        designerName: "Lina Zhou",
        createdAt: "2026-06-28T02:00:00.000Z",
        references: [{ name: "export-original.jpg", source: "/fixtures/export-original.jpg", width: 512, height: 512 }],
        outputs: [{ name: "export-result.jpg", source: "/fixtures/export-result.jpg", width: 1024, height: 1024 }]
      },
      {
        id: "history-export-upscale",
        projectId: "project-export-b",
        projectName: "Hidden upscale",
        nodeId: "node-export-b",
        prompt: "do not export after model filter",
        modelId: "upscale-pro",
        outputCount: 1,
        creditCost: 4,
        operation: "upscale",
        referenceCount: 1,
        userId: "maya@company.local",
        designerName: "Maya Chen",
        createdAt: "2026-06-27T02:00:00.000Z",
        references: [{ name: "hidden-original.jpg", source: "/fixtures/hidden-original.jpg", width: 512, height: 512 }],
        outputs: [{ name: "hidden-result.jpg", source: "/fixtures/hidden-result.jpg", width: 1024, height: 1024 }]
      }
    ];
    backendWorkspace = { ...backendWorkspace, history: backendHistory };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "History" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "History model filter" }), "gpt-image-2-medium");

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
        return "blob:designer-history-csv-export";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    try {
      await user.click(screen.getByRole("button", { name: "Export history CSV" }));
      const exportedText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exportedBlob!);
      });

      expect(exportAnchor?.download).toBe("designer-history-gpt-image-2-medium.csv");
      expect(exportedBlob?.type).toBe("text/csv;charset=utf-8");
      expect(exportedText).toContain("designerName,userId,projectName,modelId,operation,outputCount,creditCost,prompt,referenceSources,outputSources,createdAt");
      expect(exportedText).toContain("Lina Zhou");
      expect(exportedText).toContain("Export campaign");
      expect(exportedText).toContain("gpt-image-2-medium");
      expect(exportedText).toContain("/fixtures/export-original.jpg");
      expect(exportedText).toContain("/fixtures/export-result.jpg");
      expect(exportedText).not.toContain("do not export after model filter");
      expect(exportedText).not.toContain("/fixtures/hidden-result.jpg");
    } finally {
      createElementSpy.mockRestore();
      if (previousCreateObjectURL) Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
      else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
      if (previousRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
      else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
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

    expect(screen.getByText("12 credits used / limit 120")).toBeInTheDocument();
    expect(document.querySelector(".credit-meter i")).toHaveStyle({ width: "10%" });
  });

  it("shows designer-visible credit pricing rules from the model registry", async () => {
    backendWorkspace = {
      ...backendWorkspace,
      modelRegistry: backendWorkspace.modelRegistry.map((model) =>
        model.id === "gpt-image-2-medium"
          ? { ...model, cost: 9, priceCents: 450, currency: "CNY", operationPricing: { edit: { cost: 12, priceCents: 680, currency: "CNY" } } }
          : model.id === "background-cleaner"
            ? { ...model, cost: 3, priceCents: 120, currency: "CNY", operationPricing: { removeBackground: { cost: 4, priceCents: 160, currency: "CNY" } } }
            : model
      )
    };
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "Profile" }));

    const pricing = screen.getByRole("region", { name: "Credit pricing rules" });
    const mediumModel = within(pricing).getByRole("article", { name: "GPT Image 2 Medium pricing rule" });
    const removeBgModel = within(pricing).getByRole("article", { name: "Remove Background pricing rule" });
    expect(within(mediumModel).getByText("GPT Image 2 Medium")).toBeInTheDocument();
    expect(within(mediumModel).getByText("9 credits / 4.50 CNY")).toBeInTheDocument();
    expect(within(mediumModel).getByText("generate + edit")).toBeInTheDocument();
    expect(within(removeBgModel).getByText("Remove Background")).toBeInTheDocument();
    expect(within(removeBgModel).getByText("3 credits / 1.20 CNY")).toBeInTheDocument();
    expect(within(removeBgModel).getByText("removeBackground")).toBeInTheDocument();

    const operationPricing = screen.getByRole("region", { name: "Operation pricing rules" });
    const editRule = within(operationPricing).getByRole("article", { name: "GPT Image 2 Medium edit operation pricing rule" });
    const removeBgRule = within(operationPricing).getByRole("article", { name: "Remove Background removeBackground operation pricing rule" });
    expect(within(editRule).getByText("edit")).toBeInTheDocument();
    expect(within(editRule).getByText("GPT Image 2 Medium")).toBeInTheDocument();
    expect(within(editRule).getByText("12 credits / 6.80 CNY")).toBeInTheDocument();
    expect(within(removeBgRule).getByText("removeBackground")).toBeInTheDocument();
    expect(within(removeBgRule).getByText("Remove Background")).toBeInTheDocument();
    expect(within(removeBgRule).getByText("4 credits / 1.60 CNY")).toBeInTheDocument();
  });
});
