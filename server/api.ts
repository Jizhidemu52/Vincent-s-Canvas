import {
  createInitialWorkspace,
  type GenerationRequest,
  type GenerationResult,
  type HistoryEntry,
  type LibraryAsset,
  type ModelDefinition,
  type Profile,
  type Project,
  type PromptPreset,
  type Workspace
} from "../src/domain/workspace";
import { getProviderHealth, runProviderModel, type ProviderHealth } from "./providers";

export interface ServerState {
  profile: Profile;
  models: ModelDefinition[];
  history: HistoryEntry[];
  projects: Project[];
  activeProjectId?: string;
  assets: LibraryAsset[];
  prompts: PromptPreset[];
  accounts: Record<string, AccountWorkspace>;
  submittedRequestIds: Set<string>;
}

export type WorkspaceSnapshot = Pick<
  Workspace,
  "profile" | "projects" | "activeProjectId" | "history" | "assets" | "prompts" | "modelRegistry"
>;

export type AccountWorkspace = Omit<WorkspaceSnapshot, "modelRegistry">;

export interface ApiError {
  status: "failed";
  errorMessage: string;
}

export interface CreditAdjustmentRequest {
  targetUserId: string;
  delta: number;
  reason?: string;
}

export interface AdminUsageSummary {
  totalCreditsUsed: number;
  totalHistoryEntries: number;
  modelUsage: Array<{ modelId: string; count: number; credits: number }>;
}

export type { ProviderHealth } from "./providers";

export function createServerState(profile: Partial<Profile> = {}): ServerState {
  const workspace = createInitialWorkspace(profile);
  return {
    profile: workspace.profile,
    models: workspace.modelRegistry,
    history: [],
    projects: [],
    activeProjectId: undefined,
    assets: [],
    prompts: workspace.prompts,
    accounts: {},
    submittedRequestIds: new Set()
  };
}

function normalizeUserId(userId?: string) {
  const normalized = userId?.trim().toLowerCase();
  return normalized || undefined;
}

function accountFromState(state: ServerState): AccountWorkspace {
  return {
    profile: state.profile,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    history: state.history,
    assets: state.assets,
    prompts: state.prompts
  };
}

function createAccountWorkspace(state: ServerState, userId: string): AccountWorkspace {
  const isAdmin = userId.includes("admin");
  const workspace = createInitialWorkspace({
    userId,
    designerName: isAdmin ? "Admin Ops" : userId.split("@")[0] || "Designer",
    role: isAdmin ? "admin" : "designer",
    creditBalance: state.profile.creditBalance,
    creditUsed: 0
  });
  return {
    profile: workspace.profile,
    projects: [],
    activeProjectId: undefined,
    history: [],
    assets: [],
    prompts: state.prompts.length ? state.prompts : workspace.prompts
  };
}

function getAccountWorkspace(state: ServerState, userId?: string): AccountWorkspace {
  const normalized = normalizeUserId(userId);
  if (!normalized) return accountFromState(state);
  state.accounts[normalized] ??= createAccountWorkspace(state, normalized);
  return state.accounts[normalized];
}

function saveAccountWorkspace(state: ServerState, account: AccountWorkspace, userId?: string) {
  const normalized = normalizeUserId(userId);
  if (!normalized) {
    state.profile = account.profile;
    state.projects = account.projects;
    state.activeProjectId = account.activeProjectId;
    state.history = account.history;
    state.assets = account.assets;
    state.prompts = account.prompts;
    return;
  }
  state.accounts[normalized] = account;
}

function allHistory(state: ServerState) {
  return [...state.history, ...Object.values(state.accounts).flatMap((account) => account.history)];
}

function totalCreditsUsed(state: ServerState) {
  return state.profile.creditUsed + Object.values(state.accounts).reduce((sum, account) => sum + account.profile.creditUsed, 0);
}

function isAdminUser(state: ServerState, userId?: string) {
  const account = getAccountWorkspace(state, userId);
  return account.profile.role === "admin" || Boolean(normalizeUserId(userId)?.includes("admin"));
}

export function adjustAccountCredits(state: ServerState, request: Partial<CreditAdjustmentRequest>, adminUserId?: string): Profile | ApiError {
  try {
    if (!isAdminUser(state, adminUserId)) {
      throw new Error("Admin role required");
    }
    const targetUserId = normalizeUserId(request.targetUserId);
    if (!targetUserId) {
      throw new Error("Target user is required");
    }
    const delta = Number(request.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000) {
      throw new Error("Credit delta must be a non-zero integer between -10000 and 10000");
    }
    const account = getAccountWorkspace(state, targetUserId);
    const nextBalance = account.profile.creditBalance + delta;
    if (nextBalance < 0) {
      throw new Error("Credit balance cannot be negative");
    }
    account.profile = {
      ...account.profile,
      creditBalance: nextBalance,
      credits: nextBalance
    };
    saveAccountWorkspace(state, account, targetUserId);
    return account.profile;
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    };
  }
}

export function getWorkspaceSnapshot(state: ServerState, userId?: string): WorkspaceSnapshot {
  const account = getAccountWorkspace(state, userId);
  return {
    ...account,
    modelRegistry: state.models
  };
}

export function saveWorkspaceSnapshot(state: ServerState, snapshot: Partial<WorkspaceSnapshot>, userId?: string): WorkspaceSnapshot {
  const current = getAccountWorkspace(state, userId);
  const account: AccountWorkspace = {
    profile: snapshot.profile ?? current.profile,
    projects: Array.isArray(snapshot.projects) ? snapshot.projects : current.projects,
    activeProjectId: Object.prototype.hasOwnProperty.call(snapshot, "activeProjectId") ? snapshot.activeProjectId : current.activeProjectId,
    history: Array.isArray(snapshot.history) ? snapshot.history : current.history,
    assets: Array.isArray(snapshot.assets) ? snapshot.assets : current.assets,
    prompts: Array.isArray(snapshot.prompts) ? snapshot.prompts : current.prompts
  };
  saveAccountWorkspace(state, account, userId);
  state.models = Array.isArray(snapshot.modelRegistry) && snapshot.modelRegistry.length ? snapshot.modelRegistry : state.models;
  return getWorkspaceSnapshot(state, userId);
}

function assertRequest(state: ServerState, request: GenerationRequest, requestId?: string, userId?: string) {
  if (requestId && state.submittedRequestIds.has(requestId)) {
    throw new Error("Duplicate request");
  }
  if (!request.prompt.trim() && request.operation !== "upscale" && request.operation !== "removeBackground") {
    throw new Error("Prompt is required");
  }
  const model = state.models.find((item) => item.id === request.modelId);
  if (!model) {
    throw new Error("Model not found");
  }
  if (request.outputCount < 1 || request.outputCount > 8) {
    throw new Error("Output count must be between 1 and 8");
  }
  const cost = Math.max(1, model.cost) * request.outputCount;
  const account = getAccountWorkspace(state, userId);
  if (account.profile.creditBalance < cost) {
    throw new Error("Not enough credits");
  }
  return { model, cost, account };
}

function runModel(state: ServerState, request: GenerationRequest, requestId?: string, userId?: string): GenerationResult {
  const { model, cost, account } = assertRequest(state, request, requestId, userId);
  if (requestId) {
    state.submittedRequestIds.add(requestId);
  }
  account.profile = {
    ...account.profile,
    creditBalance: account.profile.creditBalance - cost,
    creditUsed: account.profile.creditUsed + cost,
    credits: account.profile.creditBalance - cost
  };

  const historyId = `history-${allHistory(state).length + 1}`;
  const entry: HistoryEntry = {
    id: historyId,
    projectId: request.projectId,
    nodeId: request.nodeId,
    prompt: request.prompt,
    modelId: request.modelId,
    outputCount: request.outputCount,
    creditCost: cost,
    operation: request.operation,
    referenceCount: request.referenceNodeIds.length,
    createdAt: new Date().toISOString()
  };
  account.history = [entry, ...account.history];
  saveAccountWorkspace(state, account, userId);

  return runProviderModel(request, model, historyId, cost);
}

export const apiRoutes = {
  "/api/models": (state: ServerState) => state.models,
  "/api/profile": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    getAccountWorkspace(state, userId).profile,
  "/api/history": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    getAccountWorkspace(state, userId).history,
  "/api/admin/audit": (state: ServerState) => allHistory(state),
  "/api/admin/usage": (state: ServerState): AdminUsageSummary => {
    const byModel = new Map<string, { modelId: string; count: number; credits: number }>();
    const history = allHistory(state);
    for (const entry of history) {
      const current = byModel.get(entry.modelId) ?? { modelId: entry.modelId, count: 0, credits: 0 };
      byModel.set(entry.modelId, {
        modelId: entry.modelId,
        count: current.count + entry.outputCount,
        credits: current.credits + entry.creditCost
      });
    }
    return {
      totalCreditsUsed: totalCreditsUsed(state),
      totalHistoryEntries: history.length,
      modelUsage: Array.from(byModel.values())
    };
  },
  "/api/admin/providers": (state: ServerState): ProviderHealth[] => getProviderHealth(state.models),
  "/api/generations": (state: ServerState, request: GenerationRequest, requestId?: string, userId?: string) =>
    runModel(state, { ...request, operation: "generate" }, requestId, userId),
  "/api/edits": (state: ServerState, request: GenerationRequest, requestId?: string, userId?: string) =>
    runModel(state, { ...request, operation: "edit" }, requestId, userId),
  "/api/upscale": (state: ServerState, request: GenerationRequest, requestId?: string, userId?: string) =>
    runModel(state, { ...request, operation: "upscale" }, requestId, userId),
  "/api/remove-bg": (state: ServerState, request: GenerationRequest, requestId?: string, userId?: string) =>
    runModel(state, { ...request, operation: "removeBackground" }, requestId, userId)
};

export function callApi(
  state: ServerState,
  path: keyof typeof apiRoutes,
  request?: GenerationRequest,
  requestId?: string,
  userId?: string
) {
  try {
    const route = apiRoutes[path];
    if (
      path === "/api/models" ||
      path === "/api/profile" ||
      path === "/api/history" ||
      path === "/api/admin/audit" ||
      path === "/api/admin/usage" ||
      path === "/api/admin/providers"
    ) {
      return route(state, request as GenerationRequest, requestId, userId);
    }
    if (!request) {
      throw new Error("Request body is required");
    }
    return route(state, request, requestId, userId);
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    } satisfies ApiError;
  }
}
