import {
  createInitialWorkspace,
  type GenerationRequest,
  type GenerationResult,
  type HistoryEntry,
  type LibraryAsset,
  type ModelDefinition,
  type ModuleType,
  type Profile,
  type Project,
  type PromptPreset,
  type Workspace
} from "../src/domain/workspace";
import {
  getProviderHealth,
  providerNames,
  runProviderModel,
  type ProviderHealth,
  type ProviderName,
  type ProviderRuntimeSettingsMap
} from "./providers";

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
  providerSettings: ProviderRuntimeSettingsMap;
  adminAudit: AdminAuditEntry[];
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

export interface ModelRegistryRequest {
  modelId: string;
  name: string;
  provider: ProviderName;
  group: ModelDefinition["group"];
  capability: ModuleType[];
  cost: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
}

export interface ProviderSettingsRequest {
  provider: ProviderName;
  mode?: ProviderHealth["mode"];
  endpointUrl?: string;
  secretName?: string;
  secretValue?: string;
}

export interface AdminAuditEntry {
  id: string;
  eventType: "generation" | "credit-adjustment" | "credit-limit" | "model-pricing" | "model-registry" | "provider-settings";
  actorUserId?: string;
  userId?: string;
  targetUserId?: string;
  designerName?: string;
  projectId?: string;
  projectName?: string;
  nodeId?: string;
  modelId?: string;
  provider?: ProviderName;
  prompt?: string;
  operation?: string;
  outputCount?: number;
  creditCost?: number;
  creditDelta?: number;
  creditBalance?: number;
  creditLimit?: number;
  referenceCount?: number;
  summary: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
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
    submittedRequestIds: new Set(),
    providerSettings: {},
    adminAudit: []
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

function auditId(state: ServerState, eventType: AdminAuditEntry["eventType"]) {
  return `audit-${eventType}-${Date.now()}-${state.adminAudit.length + 1}`;
}

function recordAdminAudit(
  state: ServerState,
  entry: Omit<AdminAuditEntry, "id" | "createdAt"> & { id?: string; createdAt?: string }
) {
  state.adminAudit = [
    {
      ...entry,
      id: entry.id ?? auditId(state, entry.eventType),
      createdAt: entry.createdAt ?? new Date().toISOString()
    },
    ...state.adminAudit
  ];
}

function adminAuditFromHistory(entry: HistoryEntry): AdminAuditEntry {
  const actor = entry.designerName ?? entry.userId ?? "Designer";
  return {
    id: entry.id,
    eventType: "generation",
    actorUserId: entry.userId,
    userId: entry.userId,
    targetUserId: entry.userId,
    designerName: entry.designerName,
    projectId: entry.projectId,
    projectName: entry.projectName,
    nodeId: entry.nodeId,
    modelId: entry.modelId,
    prompt: entry.prompt,
    operation: entry.operation,
    outputCount: entry.outputCount,
    creditCost: entry.creditCost,
    referenceCount: entry.referenceCount,
    summary: `${actor} generated ${entry.outputCount} output${entry.outputCount === 1 ? "" : "s"} with ${entry.modelId}`,
    createdAt: entry.createdAt,
    metadata: { operation: entry.operation, outputs: entry.outputs }
  };
}

function allAdminAudit(state: ServerState) {
  return [...state.adminAudit, ...allHistory(state).map(adminAuditFromHistory)].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
}

function totalCreditsUsed(state: ServerState) {
  return state.profile.creditUsed + Object.values(state.accounts).reduce((sum, account) => sum + account.profile.creditUsed, 0);
}

function isAdminUser(state: ServerState, userId?: string) {
  const account = getAccountWorkspace(state, userId);
  return account.profile.role === "admin" || Boolean(normalizeUserId(userId)?.includes("admin"));
}

const modelGroups: ModelDefinition["group"][] = ["Trending models", "Image", "Edit", "Operations"];
const modelCapabilities: ModuleType[] = ["generate", "edit", "upscale", "removeBackground"];

function normalizeModelPrice(
  request: Pick<Partial<ModelRegistryRequest>, "cost" | "priceCents" | "currency">,
  current?: Pick<ModelDefinition, "priceCents" | "currency">
) {
  const cost = Number(request.cost);
  if (!Number.isInteger(cost) || cost < 1 || cost > 10_000) {
    throw new Error("Model cost must be an integer between 1 and 10000");
  }
  const priceCents = request.priceCents === undefined ? current?.priceCents : Number(request.priceCents);
  if (priceCents !== undefined && (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000)) {
    throw new Error("Model price must be a non-negative integer amount in cents");
  }
  const currency = request.currency ?? current?.currency ?? "CNY";
  if (currency !== "CNY" && currency !== "USD") {
    throw new Error("Currency must be CNY or USD");
  }
  return { cost, priceCents, currency };
}

function normalizeModelCapability(capability: unknown): ModuleType[] {
  if (!Array.isArray(capability)) {
    throw new Error("Model capability must contain supported operations");
  }
  const normalized = Array.from(new Set(capability.map((item) => String(item).trim()).filter(Boolean)));
  if (!normalized.length || normalized.some((item): item is string => !modelCapabilities.includes(item as ModuleType))) {
    throw new Error("Model capability must contain supported operations");
  }
  return normalized as ModuleType[];
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
    recordAdminAudit(state, {
      eventType: "credit-adjustment",
      actorUserId: normalizeUserId(adminUserId),
      targetUserId,
      creditDelta: delta,
      creditBalance: nextBalance,
      summary: `Adjusted ${targetUserId} by ${delta} credits${request.reason ? `: ${request.reason}` : ""}`,
      metadata: { reason: request.reason }
    });
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
    recordAdminAudit(state, {
      eventType: "credit-limit",
      actorUserId: normalizeUserId(adminUserId),
      targetUserId,
      creditLimit,
      creditBalance: account.profile.creditBalance,
      summary: `Set ${targetUserId} credit limit to ${creditLimit}${request.reason ? `: ${request.reason}` : ""}`,
      metadata: { reason: request.reason }
    });
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
    const { cost, priceCents, currency } = normalizeModelPrice(request, model);
    const updated = { ...model, cost, priceCents, currency };
    state.models = state.models.map((item) => (item.id === modelId ? updated : item));
    recordAdminAudit(state, {
      eventType: "model-pricing",
      actorUserId: normalizeUserId(adminUserId),
      modelId,
      creditCost: cost,
      summary: `Set ${modelId} pricing to ${cost} credits${priceCents !== undefined ? ` / ${priceCents} ${currency}` : ""}`,
      metadata: { priceCents, currency }
    });
    return updated;
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    };
  }
}

export function configureModelRegistry(state: ServerState, request: Partial<ModelRegistryRequest>, adminUserId?: string): ModelDefinition | ApiError {
  try {
    if (!isAdminUser(state, adminUserId)) {
      throw new Error("Admin role required");
    }
    const modelId = request.modelId?.trim();
    if (!modelId) {
      throw new Error("Model is required");
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(modelId)) {
      throw new Error("Model id must be 2-80 letters, numbers, dots, underscores or hyphens");
    }
    const name = request.name?.trim();
    if (!name || name.length > 80) {
      throw new Error("Model name is required and must be 80 characters or fewer");
    }
    const provider = request.provider;
    if (!provider || !providerNames.includes(provider)) {
      throw new Error("Provider is required");
    }
    const group = request.group;
    if (!group || !modelGroups.includes(group)) {
      throw new Error("Model group is required");
    }
    const existing = state.models.find((item) => item.id === modelId);
    const capability = normalizeModelCapability(request.capability);
    const { cost, priceCents, currency } = normalizeModelPrice(request, existing);
    const model: ModelDefinition = {
      id: modelId,
      name,
      provider,
      group,
      capability,
      cost,
      priceCents,
      currency
    };
    state.models = existing ? state.models.map((item) => (item.id === modelId ? model : item)) : [...state.models, model];
    recordAdminAudit(state, {
      eventType: "model-registry",
      actorUserId: normalizeUserId(adminUserId),
      modelId,
      provider,
      creditCost: cost,
      summary: `${existing ? "Updated" : "Registered"} ${modelId} for ${provider} with ${capability.join(", ")}`,
      metadata: { name, group, capability, priceCents, currency }
    });
    return model;
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    };
  }
}

export function configureProviderSettings(
  state: ServerState,
  request: Partial<ProviderSettingsRequest>,
  adminUserId?: string
): ProviderHealth | ApiError {
  try {
    if (!isAdminUser(state, adminUserId)) {
      throw new Error("Admin role required");
    }
    const provider = request.provider;
    if (!provider || !providerNames.includes(provider)) {
      throw new Error("Provider is required");
    }
    const mode = request.mode ?? "mock";
    if (mode !== "mock" && mode !== "live-ready") {
      throw new Error("Provider mode must be mock or live-ready");
    }
    const endpointUrl = request.endpointUrl?.trim();
    if (endpointUrl) {
      try {
        const parsed = new URL(endpointUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Provider endpoint must be an http or https URL");
        }
      } catch {
        throw new Error("Provider endpoint must be a valid URL");
      }
    }
    const secretName = request.secretName?.trim();
    const secretValue = request.secretValue?.trim();
    if (secretValue && !secretName) {
      throw new Error("Secret name is required when setting a provider secret");
    }
    const existing = state.providerSettings[provider] ?? {};
    const configuredSecrets = secretValue && secretName ? Array.from(new Set([...(existing.configuredSecrets ?? []), secretName])) : existing.configuredSecrets ?? [];
    state.providerSettings = {
      ...state.providerSettings,
      [provider]: {
        ...existing,
        mode,
        endpointUrl: endpointUrl || undefined,
        configuredSecrets,
        secretConfigured: configuredSecrets.length > 0 || Boolean(existing.secretConfigured),
        updatedAt: new Date().toISOString()
      }
    };
    const health = getProviderHealth(state.models, state.providerSettings).find((item) => item.provider === provider)!;
    recordAdminAudit(state, {
      eventType: "provider-settings",
      actorUserId: normalizeUserId(adminUserId),
      provider,
      summary: `${provider} provider set to ${health.mode}; configured ${health.configuredSecrets.join(", ") || "no secret"}`,
      metadata: {
        mode: health.mode,
        endpointUrl: health.endpointUrl,
        configuredSecrets: health.configuredSecrets,
        missingSecrets: health.missingSecrets
      }
    });
    return health;
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
  if (!model.capability.some((capability) => capability === request.operation)) {
    throw new Error(`Model ${model.id} does not support ${request.operation}`);
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
  "/api/admin/audit": (state: ServerState) => allAdminAudit(state),
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
  "/api/admin/providers": (state: ServerState): ProviderHealth[] => getProviderHealth(state.models, state.providerSettings),
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
