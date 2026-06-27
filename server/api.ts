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

export interface CreditLimitRequest {
  targetUserId: string;
  creditLimit: number;
  reason?: string;
}

export interface ModelPricingRequest {
  modelId: string;
  cost: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
}

export interface AdminUsageSummary {
  totalCreditsUsed: number;
  totalHistoryEntries: number;
  modelUsage: Array<{ modelId: string; count: number; credits: number }>;
}

export interface AdminAccountSummary {
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

function historyWithAccountContext(account: AccountWorkspace): HistoryEntry[] {
  return account.history.map((entry) => ({
    ...entry,
    userId: entry.userId ?? account.profile.userId,
    designerName: entry.designerName ?? account.profile.designerName,
    projectName: entry.projectName ?? account.projects.find((project) => project.id === entry.projectId)?.name ?? entry.projectId
  }));
}

function allHistory(state: ServerState) {
  return [accountFromState(state), ...Object.values(state.accounts)]
    .flatMap(historyWithAccountContext)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
    if (account.profile.creditLimit !== undefined && nextBalance > account.profile.creditLimit) {
      throw new Error("Credit balance cannot exceed assigned limit");
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

export function setAccountCreditLimit(state: ServerState, request: Partial<CreditLimitRequest>, adminUserId?: string): Profile | ApiError {
  try {
    if (!isAdminUser(state, adminUserId)) {
      throw new Error("Admin role required");
    }
    const targetUserId = normalizeUserId(request.targetUserId);
    if (!targetUserId) {
      throw new Error("Target user is required");
    }
    const creditLimit = Number(request.creditLimit);
    if (!Number.isInteger(creditLimit) || creditLimit < 0 || creditLimit > 100_000) {
      throw new Error("Credit limit must be an integer between 0 and 100000");
    }
    const account = getAccountWorkspace(state, targetUserId);
    account.profile = {
      ...account.profile,
      creditLimit,
      creditBalance: Math.min(account.profile.creditBalance, creditLimit),
      credits: Math.min(account.profile.creditBalance, creditLimit)
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

export function configureModelPricing(state: ServerState, request: Partial<ModelPricingRequest>, adminUserId?: string): ModelDefinition | ApiError {
  try {
    if (!isAdminUser(state, adminUserId)) {
      throw new Error("Admin role required");
    }
    const modelId = request.modelId?.trim();
    if (!modelId) {
      throw new Error("Model is required");
    }
    const model = state.models.find((item) => item.id === modelId);
    if (!model) {
      throw new Error("Model not found");
    }
    const cost = Number(request.cost);
    if (!Number.isInteger(cost) || cost < 1 || cost > 10_000) {
      throw new Error("Model cost must be an integer between 1 and 10000");
    }
    const priceCents = request.priceCents === undefined ? model.priceCents : Number(request.priceCents);
    if (priceCents !== undefined && (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000)) {
      throw new Error("Model price must be a non-negative integer amount in cents");
    }
    const currency = request.currency ?? model.currency ?? "CNY";
    if (currency !== "CNY" && currency !== "USD") {
      throw new Error("Currency must be CNY or USD");
    }
    const updated = { ...model, cost, priceCents, currency };
    state.models = state.models.map((item) => (item.id === modelId ? updated : item));
    return updated;
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    };
  }
}

function summarizeAccount(account: AccountWorkspace): AdminAccountSummary {
  return {
    userId: account.profile.userId,
    designerName: account.profile.designerName,
    role: account.profile.role,
    creditBalance: account.profile.creditBalance,
    creditUsed: account.profile.creditUsed,
    credits: account.profile.credits,
    creditLimit: account.profile.creditLimit,
    projectCount: account.projects.length,
    historyCount: account.history.length,
    assetCount: account.assets.length,
    lastActivityAt: account.history[0]?.createdAt
  };
}

export function listAdminAccounts(state: ServerState, adminUserId?: string): AdminAccountSummary[] | ApiError {
  try {
    if (!isAdminUser(state, adminUserId)) {
      throw new Error("Admin role required");
    }
    const accounts = [accountFromState(state), ...Object.values(state.accounts)].map(summarizeAccount);
    const unique = new Map<string, AdminAccountSummary>();
    for (const account of accounts) {
      unique.set(account.userId.toLowerCase(), account);
    }
    return Array.from(unique.values()).sort((left, right) => left.userId.localeCompare(right.userId));
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
  const incomingProfile = snapshot.profile;
  const account: AccountWorkspace = {
    profile: {
      ...current.profile,
      userId: incomingProfile?.userId ?? current.profile.userId,
      designerName: incomingProfile?.designerName ?? current.profile.designerName,
      role: incomingProfile?.role ?? current.profile.role
    },
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
  const historyId = `history-${allHistory(state).length + 1}`;
  const result = runProviderModel(request, model, historyId, cost);
  const projectName = account.projects.find((project) => project.id === request.projectId)?.name;

  if (requestId) {
    state.submittedRequestIds.add(requestId);
  }
  account.profile = {
    ...account.profile,
    creditBalance: account.profile.creditBalance - cost,
    creditUsed: account.profile.creditUsed + cost,
    credits: account.profile.creditBalance - cost
  };

  const entry: HistoryEntry = {
    id: historyId,
    projectId: request.projectId,
    projectName,
    nodeId: request.nodeId,
    prompt: request.prompt,
    modelId: request.modelId,
    outputCount: request.outputCount,
    creditCost: cost,
    userId: account.profile.userId,
    designerName: account.profile.designerName,
    operation: request.operation,
    referenceCount: request.referenceNodeIds.length,
    outputs: result.outputs,
    createdAt: new Date().toISOString()
  };
  account.history = [entry, ...account.history];
  saveAccountWorkspace(state, account, userId);

  return result;
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
  "/api/admin/accounts": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    listAdminAccounts(state, userId),
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
      path === "/api/admin/accounts" ||
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
