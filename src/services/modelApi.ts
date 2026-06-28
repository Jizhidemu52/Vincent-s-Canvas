import type {
  AssetInput,
  GenerationRequest,
  GenerationResult,
  HistoryEntry,
  ModelDefinition,
  OperationType,
  Profile,
  PromptPreset,
  Workspace
} from "../domain/workspace";
import { getWorkflowApiPathForOperation } from "../domain/workspace";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface BackendSnapshot {
  profile?: Profile;
  history?: HistoryEntry[];
  models?: ModelDefinition[];
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
  provider: ModelDefinition["provider"];
  group: ModelDefinition["group"];
  capability: ModelDefinition["capability"];
  cost: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
}

export interface ProviderSettingsRequest {
  provider: ModelDefinition["provider"];
  mode: "mock" | "live-ready";
  endpointUrl?: string;
  secretName?: string;
  secretValue?: string;
}

export interface ProviderHealth {
  provider: ModelDefinition["provider"];
  status: "healthy" | "degraded";
  modelCount: number;
  keyLocation: "server";
  mode: "mock" | "live-ready";
  endpointUrl?: string;
  secretConfigured: boolean;
  adapterId: string;
  requiredSecrets: string[];
  configuredSecrets: string[];
  missingSecrets: string[];
  supportedOperations: OperationType[];
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

export interface AdminGenerationJob {
  id: string;
  historyId?: string;
  requestId?: string;
  userId: string;
  designerName?: string;
  projectId: string;
  projectName?: string;
  nodeId: string;
  modelId: string;
  operation: OperationType;
  status: GenerationResult["status"];
  prompt: string;
  outputCount: number;
  creditCost: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
  referenceCount: number;
  mask?: GenerationRequest["mask"];
  batchSettings?: GenerationRequest["batchSettings"];
  providerSettings?: GenerationRequest["providerSettings"];
  providerPayload?: {
    provider: ModelDefinition["provider"];
    adapterId: string;
    endpointUrl?: string;
    secretNames: string[];
    body: Record<string, unknown>;
  };
  providerProgress?: GenerationResult["providerProgress"];
  outputs?: AssetInput[];
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export type AdminHistoryEntry = HistoryEntry;

export interface AdminAuditEntry {
  id: string;
  eventType?: "generation" | "credit-adjustment" | "credit-limit" | "model-pricing" | "model-registry" | "provider-settings";
  actorUserId?: string;
  userId?: string;
  targetUserId?: string;
  designerName?: string;
  projectId?: string;
  projectName?: string;
  nodeId?: string;
  modelId?: string;
  provider?: ModelDefinition["provider"];
  prompt?: string;
  operation?: OperationType;
  outputCount?: number;
  creditCost?: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
  creditDelta?: number;
  creditBalance?: number;
  creditLimit?: number;
  referenceCount?: number;
  summary?: string;
  createdAt: string;
}

export type WorkspaceSnapshot = Pick<
  Workspace,
  "profile" | "projects" | "activeProjectId" | "history" | "assets" | "prompts" | "modelRegistry"
>;

type WorkspaceSaveSnapshot = Omit<WorkspaceSnapshot, "modelRegistry">;

function userHeaders(userId?: string): Record<string, string> {
  return userId ? { "x-user-id": userId } : {};
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { errorMessage?: string };
  if (!response.ok || payload.errorMessage) {
    throw new Error(payload.errorMessage ?? `API request failed with ${response.status}`);
  }
  return payload;
}

export async function submitGenerationRequest(request: GenerationRequest, userId?: string): Promise<GenerationResult> {
  const response = await fetch(`${API_BASE_URL}${getWorkflowApiPathForOperation(request.operation)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `${request.projectId}:${request.nodeId}:${request.operation}:${Date.now()}`,
      ...userHeaders(userId)
    },
    body: JSON.stringify(request)
  });
  return readJson<GenerationResult>(response);
}

export async function fetchBackendSnapshot(userId?: string): Promise<BackendSnapshot> {
  const init = { headers: userHeaders(userId) };
  const [profile, history, models] = await Promise.all([
    fetch(`${API_BASE_URL}/api/profile`, init).then((response) => readJson<Profile>(response)),
    fetch(`${API_BASE_URL}/api/history`, init).then((response) => readJson<HistoryEntry[]>(response)),
    fetch(`${API_BASE_URL}/api/models`).then((response) => readJson<ModelDefinition[]>(response))
  ]);
  return { profile, history, models };
}

export async function fetchWorkspaceSnapshot(userId?: string): Promise<WorkspaceSnapshot> {
  const response = await fetch(`${API_BASE_URL}/api/workspace`, { headers: userHeaders(userId) });
  return readJson<WorkspaceSnapshot>(response);
}

export async function saveWorkspaceSnapshot(workspace: Workspace, userId?: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSaveSnapshot = {
    profile: workspace.profile,
    projects: workspace.projects,
    activeProjectId: workspace.activeProjectId,
    history: workspace.history,
    assets: workspace.assets,
    prompts: workspace.prompts
  };
  const response = await fetch(`${API_BASE_URL}/api/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(userId) },
    body: JSON.stringify(snapshot)
  });
  return readJson<WorkspaceSnapshot>(response);
}

export async function savePromptPresetRemote(
  request: { title?: string; prompt: string; tags?: string[] },
  userId?: string
): Promise<PromptPreset> {
  const response = await fetch(`${API_BASE_URL}/api/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(userId) },
    body: JSON.stringify(request)
  });
  return readJson<PromptPreset>(response);
}

export async function deletePromptPresetRemote(promptId: string, userId?: string): Promise<PromptPreset[]> {
  const response = await fetch(`${API_BASE_URL}/api/prompts/${encodeURIComponent(promptId)}`, {
    method: "DELETE",
    headers: userHeaders(userId)
  });
  return readJson<PromptPreset[]>(response);
}

export async function updatePromptPresetTagsRemote(promptId: string, tags: string[], userId?: string): Promise<PromptPreset> {
  const response = await fetch(`${API_BASE_URL}/api/prompts/${encodeURIComponent(promptId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...userHeaders(userId) },
    body: JSON.stringify({ tags })
  });
  return readJson<PromptPreset>(response);
}

export async function adjustDesignerCredits(request: CreditAdjustmentRequest, adminUserId?: string): Promise<Profile> {
  const response = await fetch(`${API_BASE_URL}/api/admin/credits`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(adminUserId) },
    body: JSON.stringify(request)
  });
  return readJson<Profile>(response);
}

export async function setDesignerCreditLimit(request: CreditLimitRequest, adminUserId?: string): Promise<Profile> {
  const response = await fetch(`${API_BASE_URL}/api/admin/credit-limit`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(adminUserId) },
    body: JSON.stringify(request)
  });
  return readJson<Profile>(response);
}

export async function configureAdminModelPricing(request: ModelPricingRequest, adminUserId?: string): Promise<ModelDefinition> {
  const response = await fetch(`${API_BASE_URL}/api/admin/model-pricing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(adminUserId) },
    body: JSON.stringify(request)
  });
  return readJson<ModelDefinition>(response);
}

export async function configureAdminModelRegistry(request: ModelRegistryRequest, adminUserId?: string): Promise<ModelDefinition> {
  const response = await fetch(`${API_BASE_URL}/api/admin/models`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(adminUserId) },
    body: JSON.stringify(request)
  });
  return readJson<ModelDefinition>(response);
}

export async function configureAdminProviderSettings(request: ProviderSettingsRequest, adminUserId?: string): Promise<ProviderHealth> {
  const response = await fetch(`${API_BASE_URL}/api/admin/provider-settings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...userHeaders(adminUserId) },
    body: JSON.stringify(request)
  });
  return readJson<ProviderHealth>(response);
}

export async function fetchProviderHealth(adminUserId?: string): Promise<ProviderHealth[]> {
  const response = await fetch(`${API_BASE_URL}/api/admin/providers`, { headers: userHeaders(adminUserId) });
  return readJson<ProviderHealth[]>(response);
}

export async function fetchAdminAccounts(adminUserId?: string): Promise<AdminAccountSummary[]> {
  const response = await fetch(`${API_BASE_URL}/api/admin/accounts`, { headers: userHeaders(adminUserId) });
  return readJson<AdminAccountSummary[]>(response);
}

export async function fetchAdminUsage(adminUserId?: string): Promise<AdminUsageSummary> {
  const response = await fetch(`${API_BASE_URL}/api/admin/usage`, { headers: userHeaders(adminUserId) });
  return readJson<AdminUsageSummary>(response);
}

export async function fetchAdminJobs(adminUserId?: string): Promise<AdminGenerationJob[]> {
  const response = await fetch(`${API_BASE_URL}/api/admin/jobs`, { headers: userHeaders(adminUserId) });
  return readJson<AdminGenerationJob[]>(response);
}

export async function fetchAdminHistory(adminUserId?: string, filterUserId?: string): Promise<AdminHistoryEntry[]> {
  const query = filterUserId ? `?${new URLSearchParams({ userId: filterUserId }).toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/api/admin/history${query}`, { headers: userHeaders(adminUserId) });
  return readJson<AdminHistoryEntry[]>(response);
}

export async function fetchAdminAudit(adminUserId?: string): Promise<AdminAuditEntry[]> {
  const response = await fetch(`${API_BASE_URL}/api/admin/audit`, { headers: userHeaders(adminUserId) });
  return readJson<AdminAuditEntry[]>(response);
}
