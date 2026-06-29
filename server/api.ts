import {
  createInitialWorkspace,
  type GenerationRequest,
  type GenerationResult,
  type HistoryEntry,
  type AssetInput,
  type LibraryAsset,
  type ModelDefinition,
  type ModuleType,
  type OperationType,
  type Profile,
  type ProviderProgress,
  type Project,
  type PromptPreset,
  type Workspace,
  pricingForOperation
} from "../src/domain/workspace";
import {
  buildProviderPayload,
  executeLiveProviderPayload,
  getProviderHealth,
  providerNames,
  runProviderModel,
  type LiveProviderExecutionOptions,
  type ProviderHealth,
  type ProviderName,
  type ProviderPayload,
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
  generationJobs: GenerationJob[];
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

export interface OperationPricingRequest extends ModelPricingRequest {
  operation: OperationType;
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

export interface AdminHistoryArchiveRequest {
  historyIds?: string[];
  reason?: string;
}

export interface PromptPresetRequest {
  id?: string;
  title?: string;
  prompt?: string;
  tags?: string[];
}

export interface AssetMetadataRequest {
  id?: string;
  tags?: string[];
  folder?: string;
}

export interface AdminAuditEntry {
  id: string;
  eventType:
    | "generation"
    | "credit-adjustment"
    | "credit-limit"
    | "model-pricing"
    | "operation-pricing"
    | "model-registry"
    | "provider-settings"
    | "history-archive"
    | "history-restore"
    | "history-delete";
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
  priceCents?: number;
  currency?: ModelDefinition["currency"];
  creditDelta?: number;
  creditBalance?: number;
  creditLimit?: number;
  referenceCount?: number;
  summary: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationJob {
  id: string;
  historyId?: string;
  requestId?: string;
  userId: string;
  designerName?: string;
  projectId: string;
  projectName?: string;
  nodeId: string;
  modelId: string;
  operation: GenerationRequest["operation"];
  status: GenerationResult["status"];
  prompt: string;
  outputCount: number;
  creditCost: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
  referenceCount: number;
  references?: AssetInput[];
  mask?: GenerationRequest["mask"];
  batchSettings?: GenerationRequest["batchSettings"];
  providerSettings?: GenerationRequest["providerSettings"];
  providerPayload?: ProviderPayload;
  providerProgress?: ProviderProgress;
  outputs: AssetInput[];
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export interface AdminUsageSummary {
  totalCreditsUsed: number;
  totalHistoryEntries: number;
  totalPriceCents?: number;
  currency?: ModelDefinition["currency"] | "mixed";
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
  modelUsage: Array<{ modelId: string; count: number; credits: number; priceCents?: number; currency?: ModelDefinition["currency"] }>;
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
    adminAudit: [],
    generationJobs: []
  };
}

function normalizeUserId(userId?: string) {
  const normalized = userId?.trim().toLowerCase();
  return normalized || undefined;
}

function scopedRequestId(requestId?: string, userId?: string) {
  if (!requestId) return undefined;
  return `${normalizeUserId(userId) ?? "default"}:${requestId}`;
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

function createAccountWorkspace(state: ServerState, userId: string, initialCreditBalance = state.profile.creditBalance): AccountWorkspace {
  const isAdmin = userId.includes("admin");
  const workspace = createInitialWorkspace({
    userId,
    designerName: isAdmin ? "Admin Ops" : userId.split("@")[0] || "Designer",
    role: isAdmin ? "admin" : "designer",
    creditBalance: initialCreditBalance,
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

function getAdminManagedAccountWorkspace(state: ServerState, userId: string): AccountWorkspace {
  state.accounts[userId] ??= createAccountWorkspace(state, userId, 0);
  return state.accounts[userId];
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
  const recorded = {
    ...entry,
    id: entry.id ?? auditId(state, entry.eventType),
    createdAt: entry.createdAt ?? new Date().toISOString()
  };
  state.adminAudit = [recorded, ...state.adminAudit];
  return recorded;
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
    priceCents: entry.priceCents === undefined ? undefined : entry.priceCents * entry.outputCount,
    currency: entry.currency,
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

function listGenerationJobs(state: ServerState, adminUserId?: string): GenerationJob[] | ApiError {
  try {
    assertAdminUser(state, adminUserId);
    return [...state.generationJobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    };
  }
}

export interface ApiQuery {
  userId?: string;
  projectId?: string;
  modelId?: string;
  operation?: string;
  status?: string;
  from?: string;
  to?: string;
  dateFrom?: string;
  dateTo?: string;
}

function textFilter(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function historyDateFilter(value?: string) {
  const normalized = textFilter(value);
  if (!normalized) return undefined;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid history date filter");
  }
  return timestamp;
}

function listAdminHistory(state: ServerState, adminUserId?: string, query: ApiQuery = {}): HistoryEntry[] | ApiError {
  try {
    assertAdminUser(state, adminUserId);
    const filterUserId = textFilter(query.userId);
    const projectId = textFilter(query.projectId);
    const modelId = textFilter(query.modelId);
    const operation = textFilter(query.operation);
    const status = textFilter(query.status) ?? "active";
    if (!["active", "archived", "all"].includes(status)) {
      throw new Error("Invalid history status filter");
    }
    const from = historyDateFilter(query.from ?? query.dateFrom);
    const to = historyDateFilter(query.to ?? query.dateTo);
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error("Invalid history date filter");
    }
    return allHistory(state).filter((entry) => {
      if (status === "active" && entry.archivedAt) return false;
      if (status === "archived" && !entry.archivedAt) return false;
      if (filterUserId && entry.userId !== filterUserId) return false;
      if (projectId && entry.projectId !== projectId) return false;
      if (modelId && entry.modelId !== modelId) return false;
      if (operation && entry.operation !== operation) return false;
      const createdAt = Date.parse(entry.createdAt);
      if (from !== undefined && createdAt < from) return false;
      if (to !== undefined && createdAt > to) return false;
      return true;
    });
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    };
  }
}

function archiveAdminHistory(state: ServerState, request: AdminHistoryArchiveRequest | undefined, adminUserId?: string) {
  assertAdminUser(state, adminUserId);
  const historyIds = Array.from(new Set((request?.historyIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!historyIds.length) throw new Error("History ids are required");
  const historyIdSet = new Set(historyIds);
  const archivedAt = new Date().toISOString();
  const archiveReason = request?.reason?.trim() || undefined;
  const archivedEntries: HistoryEntry[] = [];
  const accountEntries: Array<{ userId?: string; account: AccountWorkspace }> = [
    { account: accountFromState(state) },
    ...Object.entries(state.accounts).map(([userId, account]) => ({ userId, account }))
  ];

  for (const item of accountEntries) {
    let changed = false;
    item.account.history = item.account.history.map((entry) => {
      if (!historyIdSet.has(entry.id) || entry.archivedAt) return entry;
      changed = true;
      const archived = {
        ...entry,
        archivedAt,
        archivedBy: adminUserId,
        archiveReason
      };
      archivedEntries.push(historyWithAccountContext({ ...item.account, history: [archived] })[0]);
      return archived;
    });
    if (changed) {
      saveAccountWorkspace(state, item.account, item.userId);
    }
  }
  if (!archivedEntries.length) throw new Error("History records not found");

  const affectedUsers = Array.from(new Set(archivedEntries.map((entry) => entry.userId).filter(Boolean)));
  const auditEntry = recordAdminAudit(state, {
    eventType: "history-archive",
    actorUserId: adminUserId,
    targetUserId: affectedUsers.length === 1 ? affectedUsers[0] : undefined,
    summary: `Archived ${archivedEntries.length} team history record${archivedEntries.length === 1 ? "" : "s"}`,
    prompt: archiveReason,
    outputCount: archivedEntries.length,
    creditCost: 0,
    metadata: {
      historyIds: archivedEntries.map((entry) => entry.id),
      reason: archiveReason,
      affectedUsers
    }
  });

  return {
    archivedCount: archivedEntries.length,
    history: listAdminHistory(state, adminUserId),
    auditEntry
  };
}

function restoreAdminHistory(state: ServerState, request: AdminHistoryArchiveRequest | undefined, adminUserId?: string) {
  assertAdminUser(state, adminUserId);
  const historyIds = Array.from(new Set((request?.historyIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!historyIds.length) throw new Error("History ids are required");
  const historyIdSet = new Set(historyIds);
  const reason = request?.reason?.trim() || undefined;
  const restoredEntries: HistoryEntry[] = [];
  const accountEntries: Array<{ userId?: string; account: AccountWorkspace }> = [
    { account: accountFromState(state) },
    ...Object.entries(state.accounts).map(([userId, account]) => ({ userId, account }))
  ];

  for (const item of accountEntries) {
    let changed = false;
    item.account.history = item.account.history.map((entry) => {
      if (!historyIdSet.has(entry.id) || !entry.archivedAt) return entry;
      changed = true;
      const { archivedAt, archivedBy, archiveReason, ...restored } = entry;
      void archivedAt;
      void archivedBy;
      void archiveReason;
      restoredEntries.push(historyWithAccountContext({ ...item.account, history: [restored] })[0]);
      return restored;
    });
    if (changed) {
      saveAccountWorkspace(state, item.account, item.userId);
    }
  }
  if (!restoredEntries.length) throw new Error("Archived history records not found");

  const affectedUsers = Array.from(new Set(restoredEntries.map((entry) => entry.userId).filter(Boolean)));
  const auditEntry = recordAdminAudit(state, {
    eventType: "history-restore",
    actorUserId: adminUserId,
    targetUserId: affectedUsers.length === 1 ? affectedUsers[0] : undefined,
    summary: `Restored ${restoredEntries.length} team history record${restoredEntries.length === 1 ? "" : "s"}`,
    prompt: reason,
    outputCount: restoredEntries.length,
    creditCost: 0,
    metadata: {
      historyIds: restoredEntries.map((entry) => entry.id),
      reason,
      affectedUsers
    }
  });

  return {
    restoredCount: restoredEntries.length,
    history: listAdminHistory(state, adminUserId),
    auditEntry
  };
}

function deleteArchivedAdminHistory(state: ServerState, request: AdminHistoryArchiveRequest | undefined, adminUserId?: string) {
  assertAdminUser(state, adminUserId);
  const historyIds = Array.from(new Set((request?.historyIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (!historyIds.length) throw new Error("History ids are required");
  const historyIdSet = new Set(historyIds);
  const reason = request?.reason?.trim() || undefined;
  const deletedEntries: HistoryEntry[] = [];
  const accountEntries: Array<{ userId?: string; account: AccountWorkspace }> = [
    { account: accountFromState(state) },
    ...Object.entries(state.accounts).map(([userId, account]) => ({ userId, account }))
  ];

  for (const item of accountEntries) {
    const remainingHistory: HistoryEntry[] = [];
    let changed = false;
    for (const entry of item.account.history) {
      if (historyIdSet.has(entry.id)) {
        if (!entry.archivedAt) {
          throw new Error("Only archived history records can be permanently deleted");
        }
        changed = true;
        deletedEntries.push(historyWithAccountContext({ ...item.account, history: [entry] })[0]);
        continue;
      }
      remainingHistory.push(entry);
    }
    if (changed) {
      item.account.history = remainingHistory;
      saveAccountWorkspace(state, item.account, item.userId);
    }
  }
  if (!deletedEntries.length) throw new Error("Archived history records not found");

  const affectedUsers = Array.from(new Set(deletedEntries.map((entry) => entry.userId).filter(Boolean)));
  const auditEntry = recordAdminAudit(state, {
    eventType: "history-delete",
    actorUserId: adminUserId,
    targetUserId: affectedUsers.length === 1 ? affectedUsers[0] : undefined,
    summary: `Permanently deleted ${deletedEntries.length} archived team history record${deletedEntries.length === 1 ? "" : "s"}`,
    prompt: reason,
    outputCount: deletedEntries.length,
    creditCost: 0,
    metadata: {
      historyIds: deletedEntries.map((entry) => entry.id),
      reason,
      affectedUsers
    }
  });

  return {
    deletedCount: deletedEntries.length,
    history: listAdminHistory(state, adminUserId),
    auditEntry
  };
}

function promptTitleFrom(prompt: string) {
  const firstLine = prompt.split(/\r?\n/)[0]?.trim();
  if (!firstLine) return "Saved prompt";
  if (firstLine.length <= 42) return firstLine;
  const truncated = firstLine.slice(0, 42).replace(/\s+\S*$/, "").trim();
  return `${truncated || firstLine.slice(0, 39).trim()}...`;
}

function normalizePromptTags(tags?: string[]) {
  return Array.from(
    new Set(
      (tags?.length ? tags : ["designer"])
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function normalizeAssetTags(tags?: string[]) {
  return Array.from(new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean)));
}

function managePromptPresets(state: ServerState, request?: PromptPresetRequest, userId?: string): PromptPreset[] | PromptPreset {
  const account = getAccountWorkspace(state, userId);
  if (!request) return account.prompts;
  if (request.id && request.tags) {
    let updatedPrompt: PromptPreset | undefined;
    account.prompts = account.prompts.map((prompt) => {
      if (prompt.id !== request.id) return prompt;
      updatedPrompt = { ...prompt, tags: normalizePromptTags(request.tags) };
      return updatedPrompt;
    });
    if (!updatedPrompt) throw new Error("Prompt not found");
    saveAccountWorkspace(state, account, userId);
    return updatedPrompt;
  }
  if (request.id && !request.prompt) {
    account.prompts = account.prompts.filter((prompt) => prompt.id !== request.id || (prompt.source !== "designer" && prompt.userId !== account.profile.userId));
    saveAccountWorkspace(state, account, userId);
    return account.prompts;
  }
  const prompt = request.prompt?.trim();
  if (!prompt) throw new Error("Prompt is required");
  const preset: PromptPreset = {
    id: `prompt-${Date.now()}-${account.prompts.length + 1}`,
    title: request.title?.trim() || promptTitleFrom(prompt),
    prompt,
    tags: normalizePromptTags(request.tags),
    source: "designer",
    userId: account.profile.userId,
    designerName: account.profile.designerName,
    createdAt: new Date().toISOString()
  };
  account.prompts = [preset, ...account.prompts];
  saveAccountWorkspace(state, account, userId);
  return preset;
}

function manageAssets(state: ServerState, request?: AssetMetadataRequest, userId?: string): LibraryAsset[] | LibraryAsset {
  const account = getAccountWorkspace(state, userId);
  if (!request) return account.assets;
  if (!request.id) throw new Error("Asset id is required");
  let updatedAsset: LibraryAsset | undefined;
  account.assets = account.assets.map((asset) => {
    if (asset.id !== request.id) return asset;
    const nextMetadata = {
      ...asset.metadata,
      ...(request.folder !== undefined ? { folder: request.folder.trim() || "Unfiled" } : {})
    };
    updatedAsset = {
      ...asset,
      tags: request.tags ? normalizeAssetTags(request.tags) : asset.tags,
      metadata: nextMetadata
    };
    return updatedAsset;
  });
  if (!updatedAsset) throw new Error("Asset not found");
  saveAccountWorkspace(state, account, userId);
  return updatedAsset;
}

function totalCreditsUsed(state: ServerState) {
  return state.profile.creditUsed + Object.values(state.accounts).reduce((sum, account) => sum + account.profile.creditUsed, 0);
}

function isAdminUser(state: ServerState, userId?: string) {
  const account = getAccountWorkspace(state, userId);
  return account.profile.role === "admin" || Boolean(normalizeUserId(userId)?.includes("admin"));
}

function assertAdminUser(state: ServerState, userId?: string) {
  if (!isAdminUser(state, userId)) {
    throw new Error("Admin role required");
  }
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
    assertAdminUser(state, adminUserId);
    const targetUserId = normalizeUserId(request.targetUserId);
    if (!targetUserId) {
      throw new Error("Target user is required");
    }
    const delta = Number(request.delta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000) {
      throw new Error("Credit delta must be a non-zero integer between -10000 and 10000");
    }
    const account = getAdminManagedAccountWorkspace(state, targetUserId);
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
    assertAdminUser(state, adminUserId);
    const targetUserId = normalizeUserId(request.targetUserId);
    if (!targetUserId) {
      throw new Error("Target user is required");
    }
    const creditLimit = Number(request.creditLimit);
    if (!Number.isInteger(creditLimit) || creditLimit < 0 || creditLimit > 100_000) {
      throw new Error("Credit limit must be an integer between 0 and 100000");
    }
    const account = getAdminManagedAccountWorkspace(state, targetUserId);
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
    assertAdminUser(state, adminUserId);
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

export function configureOperationPricing(
  state: ServerState,
  request: Partial<OperationPricingRequest>,
  adminUserId?: string
): ModelDefinition | ApiError {
  try {
    assertAdminUser(state, adminUserId);
    const modelId = request.modelId?.trim();
    if (!modelId) {
      throw new Error("Model is required");
    }
    const model = state.models.find((item) => item.id === modelId);
    if (!model) {
      throw new Error("Model not found");
    }
    const operation = request.operation;
    if (!operation || !modelCapabilities.includes(operation as ModuleType)) {
      throw new Error("Operation is required");
    }
    if (!model.capability.some((capability) => capability === operation)) {
      throw new Error(`Model ${model.id} does not support ${operation}`);
    }
    const { cost, priceCents, currency } = normalizeModelPrice(request, model.operationPricing?.[operation] ?? model);
    const updated: ModelDefinition = {
      ...model,
      operationPricing: {
        ...model.operationPricing,
        [operation]: { cost, priceCents, currency }
      }
    };
    state.models = state.models.map((item) => (item.id === modelId ? updated : item));
    recordAdminAudit(state, {
      eventType: "operation-pricing",
      actorUserId: normalizeUserId(adminUserId),
      modelId,
      operation,
      creditCost: cost,
      priceCents,
      currency,
      summary: `Set ${modelId} ${operation} pricing to ${cost} credits${priceCents !== undefined ? ` / ${priceCents} ${currency}` : ""}`,
      metadata: { operation, priceCents, currency }
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
    assertAdminUser(state, adminUserId);
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
    assertAdminUser(state, adminUserId);
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

function latestAccountActivity(account: AccountWorkspace) {
  const activity = [...account.history.map((entry) => entry.createdAt), ...account.projects.map((project) => project.updatedAt)]
    .filter(Boolean)
    .sort();
  return activity[activity.length - 1];
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
    lastActivityAt: latestAccountActivity(account)
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

function mergeServerHistory(current: HistoryEntry[], incoming?: HistoryEntry[]) {
  if (!Array.isArray(incoming)) return current;
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function saveWorkspaceSnapshot(state: ServerState, snapshot: Partial<WorkspaceSnapshot>, userId?: string): WorkspaceSnapshot {
  const current = getAccountWorkspace(state, userId);
  const incomingProfile = snapshot.profile;
  const authenticatedUserId = normalizeUserId(userId);
  const account: AccountWorkspace = {
    profile: {
      ...current.profile,
      userId: authenticatedUserId ?? incomingProfile?.userId ?? current.profile.userId,
      designerName: incomingProfile?.designerName ?? current.profile.designerName,
      role: current.profile.role
    },
    projects: Array.isArray(snapshot.projects) ? snapshot.projects : current.projects,
    activeProjectId: Object.prototype.hasOwnProperty.call(snapshot, "activeProjectId") ? snapshot.activeProjectId : current.activeProjectId,
    history: mergeServerHistory(current.history, snapshot.history),
    assets: Array.isArray(snapshot.assets) ? snapshot.assets : current.assets,
    prompts: Array.isArray(snapshot.prompts) ? snapshot.prompts : current.prompts
  };
  saveAccountWorkspace(state, account, userId);
  return getWorkspaceSnapshot(state, userId);
}

function assertRequest(state: ServerState, request: GenerationRequest, requestId?: string, userId?: string) {
  const duplicateKey = scopedRequestId(requestId, userId);
  if (duplicateKey && state.submittedRequestIds.has(duplicateKey)) {
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
  const pricing = pricingForOperation(model, request.operation);
  const cost = Math.max(1, pricing.cost) * request.outputCount;
  const account = getAccountWorkspace(state, userId);
  if (account.profile.creditBalance < cost) {
    throw new Error("Not enough credits");
  }
  return { model, pricing, cost, account };
}

function historyReferenceAssets(account: AccountWorkspace, request: GenerationRequest): AssetInput[] {
  const project = account.projects.find((item) => item.id === request.projectId);
  if (!project) return [];
  const projectNodes = project.nodes;
  const requestedReferences = request.referenceNodeIds.length ? request.referenceNodeIds : [request.nodeId];
  const visited = new Set<string>();
  const references: AssetInput[] = [];

  function findReferenceNode(referenceId: string) {
    return projectNodes.find(
      (node) =>
        node.id === referenceId ||
        node.name === referenceId ||
        (typeof node.metadata.sourceFile === "string" && node.metadata.sourceFile === referenceId)
    );
  }

  function collect(referenceId: string) {
    const node = findReferenceNode(referenceId);
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    if (node.references.length && (node.type === "imageGroup" || node.kind === "referenceGroup")) {
      node.references.forEach(collect);
      return;
    }
    if (!node.source) return;
    references.push({
      name: node.name,
      source: node.source,
      width: node.width,
      height: node.height
    });
  }

  requestedReferences.forEach(collect);
  return references;
}

function runModel(state: ServerState, request: GenerationRequest, requestId?: string, userId?: string): GenerationResult {
  const { model, pricing, cost, account } = assertRequest(state, request, requestId, userId);
  const historyId = `history-${allHistory(state).length + 1}`;
  const projectName = account.projects.find((project) => project.id === request.projectId)?.name;
  const duplicateKey = scopedRequestId(requestId, userId);
  const createdAt = new Date().toISOString();
  const references = historyReferenceAssets(account, request);
  let result: GenerationResult;
  let providerPayload: ProviderPayload | undefined;

  try {
    result = runProviderModel(request, model, historyId, cost, state.providerSettings);
    providerPayload = buildProviderPayload(request, model, state.providerSettings[model.provider]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Provider execution failed";
    state.generationJobs = [
      {
        id: `job-${historyId}`,
        historyId,
        requestId: duplicateKey,
        userId: account.profile.userId,
        designerName: account.profile.designerName,
        projectId: request.projectId,
        projectName,
        nodeId: request.nodeId,
        modelId: request.modelId,
        operation: request.operation,
        status: "failed",
        prompt: request.prompt,
        outputCount: request.outputCount,
        creditCost: 0,
        referenceCount: request.referenceNodeIds.length,
        references,
        mask: request.mask,
        batchSettings: request.batchSettings,
        providerSettings: request.providerSettings,
        outputs: [],
        createdAt,
        updatedAt: createdAt,
        errorMessage
      },
      ...state.generationJobs
    ];
    throw error;
  }

  if (duplicateKey) {
    state.submittedRequestIds.add(duplicateKey);
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
    priceCents: pricing.priceCents,
    currency: pricing.priceCents === undefined ? undefined : pricing.currency ?? "CNY",
    userId: account.profile.userId,
    designerName: account.profile.designerName,
    operation: request.operation,
    referenceCount: request.referenceNodeIds.length,
    references,
    mask: request.mask,
    batchSettings: request.batchSettings,
    providerSettings: request.providerSettings,
    providerProgress: result.providerProgress,
    errorMessage: result.errorMessage,
    outputs: result.outputs,
    createdAt
  };
  account.history = [entry, ...account.history];
  state.generationJobs = [
    {
      id: `job-${historyId}`,
      historyId,
      requestId: duplicateKey,
      userId: account.profile.userId,
      designerName: account.profile.designerName,
      projectId: request.projectId,
      projectName,
      nodeId: request.nodeId,
      modelId: request.modelId,
      operation: request.operation,
      status: result.status,
      prompt: request.prompt,
      outputCount: request.outputCount,
      creditCost: cost,
      priceCents: pricing.priceCents === undefined ? undefined : pricing.priceCents * request.outputCount,
      currency: pricing.priceCents === undefined ? undefined : pricing.currency ?? "CNY",
      referenceCount: request.referenceNodeIds.length,
      references,
      mask: request.mask,
      batchSettings: request.batchSettings,
      providerSettings: request.providerSettings,
      providerPayload,
      providerProgress: result.providerProgress,
      outputs: result.outputs,
      createdAt,
      updatedAt: createdAt,
      errorMessage: result.errorMessage
    },
    ...state.generationJobs
  ];
  saveAccountWorkspace(state, account, userId);

  return result;
}

async function runModelAsync(
  state: ServerState,
  request: GenerationRequest,
  requestId?: string,
  userId?: string,
  liveProviderOptions?: LiveProviderExecutionOptions
): Promise<GenerationResult> {
  const { model, pricing, cost, account } = assertRequest(state, request, requestId, userId);
  const historyId = `history-${allHistory(state).length + 1}`;
  const projectName = account.projects.find((project) => project.id === request.projectId)?.name;
  const duplicateKey = scopedRequestId(requestId, userId);
  const createdAt = new Date().toISOString();
  const providerRuntimeSettings = state.providerSettings[model.provider];
  const providerPayload = buildProviderPayload(request, model, providerRuntimeSettings);
  const references = historyReferenceAssets(account, request);
  let latestProviderProgress: ProviderProgress | undefined;
  let result: GenerationResult;

  try {
    result =
      providerRuntimeSettings?.mode === "live-ready"
        ? await executeLiveProviderPayload(providerPayload, request, model, historyId, cost, {
            ...(liveProviderOptions ?? {
              fetchJson: async () => {
                throw new Error(`Live provider executor is not configured for ${model.provider}`);
              },
              resolveSecret: () => undefined
            }),
            onProgress: (progress) => {
              latestProviderProgress = progress;
              liveProviderOptions?.onProgress?.(progress);
            }
          })
        : runProviderModel(request, model, historyId, cost, state.providerSettings);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Provider execution failed";
    state.generationJobs = [
      {
        id: `job-${historyId}`,
        historyId,
        requestId: duplicateKey,
        userId: account.profile.userId,
        designerName: account.profile.designerName,
        projectId: request.projectId,
        projectName,
        nodeId: request.nodeId,
        modelId: request.modelId,
        operation: request.operation,
        status: "failed",
        prompt: request.prompt,
        outputCount: request.outputCount,
        creditCost: 0,
        referenceCount: request.referenceNodeIds.length,
        references,
        mask: request.mask,
        batchSettings: request.batchSettings,
        providerSettings: request.providerSettings,
        providerPayload,
        providerProgress: latestProviderProgress ? { ...latestProviderProgress, errorMessage } : undefined,
        outputs: [],
        createdAt,
        updatedAt: createdAt,
        errorMessage
      },
      ...state.generationJobs
    ];
    throw error;
  }

  if (duplicateKey) {
    state.submittedRequestIds.add(duplicateKey);
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
    priceCents: pricing.priceCents,
    currency: pricing.priceCents === undefined ? undefined : pricing.currency ?? "CNY",
    userId: account.profile.userId,
    designerName: account.profile.designerName,
    operation: request.operation,
    referenceCount: request.referenceNodeIds.length,
    references,
    mask: request.mask,
    batchSettings: request.batchSettings,
    providerSettings: request.providerSettings,
    providerProgress: result.providerProgress,
    errorMessage: result.errorMessage,
    outputs: result.outputs,
    createdAt
  };
  account.history = [entry, ...account.history];
  state.generationJobs = [
    {
      id: `job-${historyId}`,
      historyId,
      requestId: duplicateKey,
      userId: account.profile.userId,
      designerName: account.profile.designerName,
      projectId: request.projectId,
      projectName,
      nodeId: request.nodeId,
      modelId: request.modelId,
      operation: request.operation,
      status: result.status,
      prompt: request.prompt,
      outputCount: request.outputCount,
      creditCost: cost,
      priceCents: pricing.priceCents === undefined ? undefined : pricing.priceCents * request.outputCount,
      currency: pricing.priceCents === undefined ? undefined : pricing.currency ?? "CNY",
      referenceCount: request.referenceNodeIds.length,
      references,
      mask: request.mask,
      batchSettings: request.batchSettings,
      providerSettings: request.providerSettings,
      providerPayload,
      providerProgress: result.providerProgress,
      outputs: result.outputs,
      createdAt,
      updatedAt: createdAt,
      errorMessage: result.errorMessage
    },
    ...state.generationJobs
  ];
  saveAccountWorkspace(state, account, userId);

  return result;
}

export const apiRoutes = {
  "/api/models": (state: ServerState) => state.models,
  "/api/profile": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    getAccountWorkspace(state, userId).profile,
  "/api/history": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    getAccountWorkspace(state, userId).history,
  "/api/prompts": (state: ServerState, request?: PromptPresetRequest, _requestId?: string, userId?: string) =>
    managePromptPresets(state, request, userId),
  "/api/assets": (state: ServerState, request?: AssetMetadataRequest, _requestId?: string, userId?: string) =>
    manageAssets(state, request, userId),
  "/api/admin/history": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    listAdminHistory(state, userId),
  "/api/admin/history/archive": (state: ServerState, request?: AdminHistoryArchiveRequest, _requestId?: string, userId?: string) =>
    archiveAdminHistory(state, request, userId),
  "/api/admin/history/restore": (state: ServerState, request?: AdminHistoryArchiveRequest, _requestId?: string, userId?: string) =>
    restoreAdminHistory(state, request, userId),
  "/api/admin/history/delete": (state: ServerState, request?: AdminHistoryArchiveRequest, _requestId?: string, userId?: string) =>
    deleteArchivedAdminHistory(state, request, userId),
  "/api/admin/audit": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) => {
    assertAdminUser(state, userId);
    return allAdminAudit(state);
  },
  "/api/admin/usage": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string): AdminUsageSummary => {
    assertAdminUser(state, userId);
    const byModel = new Map<string, { modelId: string; count: number; credits: number; priceCents?: number; currency?: ModelDefinition["currency"] }>();
    const history = allHistory(state);
    const creditAdjustments = allAdminAudit(state)
      .filter((entry) => entry.eventType === "credit-adjustment" && entry.targetUserId && entry.creditDelta)
      .map((entry) => ({
        id: entry.id,
        actorUserId: entry.actorUserId,
        targetUserId: entry.targetUserId!,
        creditDelta: entry.creditDelta!,
        creditBalance: entry.creditBalance,
        summary: entry.summary,
        createdAt: entry.createdAt
      }));
    const totalCreditsAllocated = creditAdjustments.reduce((sum, entry) => sum + Math.max(entry.creditDelta, 0), 0);
    const totalCreditsRemoved = creditAdjustments.reduce((sum, entry) => sum + Math.abs(Math.min(entry.creditDelta, 0)), 0);
    let totalPriceCents = 0;
    let pricedEntries = 0;
    const currencies = new Set<ModelDefinition["currency"]>();
    for (const entry of history) {
      const model = state.models.find((item) => item.id === entry.modelId);
      const unitPriceCents = entry.priceCents ?? model?.priceCents;
      const entryPriceCents = unitPriceCents === undefined ? undefined : unitPriceCents * entry.outputCount;
      const currency = entry.currency ?? model?.currency ?? "CNY";
      const current = byModel.get(entry.modelId) ?? { modelId: entry.modelId, count: 0, credits: 0 };
      if (entryPriceCents !== undefined) {
        totalPriceCents += entryPriceCents;
        pricedEntries += 1;
        currencies.add(currency);
      }
      const nextPriceCents =
        current.priceCents === undefined && entryPriceCents === undefined ? undefined : (current.priceCents ?? 0) + (entryPriceCents ?? 0);
      byModel.set(entry.modelId, {
        modelId: entry.modelId,
        count: current.count + entry.outputCount,
        credits: current.credits + entry.creditCost,
        priceCents: nextPriceCents,
        currency: current.currency ?? (nextPriceCents === undefined ? undefined : currency)
      });
    }
    return {
      totalCreditsUsed: totalCreditsUsed(state),
      totalHistoryEntries: history.length,
      totalPriceCents: pricedEntries ? totalPriceCents : undefined,
      currency: currencies.size > 1 ? "mixed" : Array.from(currencies)[0],
      totalCreditsAllocated,
      totalCreditsRemoved,
      creditAdjustments,
      modelUsage: Array.from(byModel.values())
    };
  },
  "/api/admin/accounts": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    listAdminAccounts(state, userId),
  "/api/admin/jobs": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string) =>
    listGenerationJobs(state, userId),
  "/api/admin/providers": (state: ServerState, _request?: GenerationRequest, _requestId?: string, userId?: string): ProviderHealth[] => {
    assertAdminUser(state, userId);
    return getProviderHealth(state.models, state.providerSettings);
  },
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
  request?: GenerationRequest | PromptPresetRequest | AssetMetadataRequest | AdminHistoryArchiveRequest,
  requestId?: string,
  userId?: string,
  query?: ApiQuery
) {
  try {
    if (path === "/api/admin/history") {
      return listAdminHistory(state, userId, query);
    }
    if (path === "/api/prompts") {
      return managePromptPresets(state, request as PromptPresetRequest | undefined, userId);
    }
    if (path === "/api/assets") {
      return manageAssets(state, request as AssetMetadataRequest | undefined, userId);
    }
    const route = apiRoutes[path];
    if (
      path === "/api/models" ||
      path === "/api/profile" ||
      path === "/api/history" ||
      path === "/api/admin/audit" ||
      path === "/api/admin/usage" ||
      path === "/api/admin/accounts" ||
      path === "/api/admin/jobs" ||
      path === "/api/admin/providers"
    ) {
      return route(state, request as GenerationRequest, requestId, userId);
    }
    if (!request) {
      throw new Error("Request body is required");
    }
    return route(state, request as GenerationRequest & AdminHistoryArchiveRequest, requestId, userId);
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    } satisfies ApiError;
  }
}

export async function callApiAsync(
  state: ServerState,
  path: keyof typeof apiRoutes,
  request?: GenerationRequest,
  requestId?: string,
  userId?: string,
  liveProviderOptions?: LiveProviderExecutionOptions
) {
  try {
    if (!request) {
      throw new Error("Request body is required");
    }
    if (path === "/api/generations") {
      return await runModelAsync(state, { ...request, operation: "generate" }, requestId, userId, liveProviderOptions);
    }
    if (path === "/api/edits") {
      return await runModelAsync(state, { ...request, operation: "edit" }, requestId, userId, liveProviderOptions);
    }
    if (path === "/api/upscale") {
      return await runModelAsync(state, { ...request, operation: "upscale" }, requestId, userId, liveProviderOptions);
    }
    if (path === "/api/remove-bg") {
      return await runModelAsync(state, { ...request, operation: "removeBackground" }, requestId, userId, liveProviderOptions);
    }
    return callApi(state, path, request, requestId, userId);
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    } satisfies ApiError;
  }
}
