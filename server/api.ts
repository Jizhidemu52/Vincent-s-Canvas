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

export interface ServerState {
  profile: Profile;
  models: ModelDefinition[];
  history: HistoryEntry[];
  projects: Project[];
  activeProjectId?: string;
  assets: LibraryAsset[];
  prompts: PromptPreset[];
  submittedRequestIds: Set<string>;
}

export type WorkspaceSnapshot = Pick<
  Workspace,
  "profile" | "projects" | "activeProjectId" | "history" | "assets" | "prompts" | "modelRegistry"
>;

export interface ApiError {
  status: "failed";
  errorMessage: string;
}

export interface AdminUsageSummary {
  totalCreditsUsed: number;
  totalHistoryEntries: number;
  modelUsage: Array<{ modelId: string; count: number; credits: number }>;
}

export interface ProviderHealth {
  provider: string;
  status: "healthy" | "degraded";
  modelCount: number;
  keyLocation: "server";
}

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
    submittedRequestIds: new Set()
  };
}

export function getWorkspaceSnapshot(state: ServerState): WorkspaceSnapshot {
  return {
    profile: state.profile,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    history: state.history,
    assets: state.assets,
    prompts: state.prompts,
    modelRegistry: state.models
  };
}

export function saveWorkspaceSnapshot(state: ServerState, snapshot: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  state.profile = snapshot.profile ?? state.profile;
  state.projects = Array.isArray(snapshot.projects) ? snapshot.projects : state.projects;
  if (Object.prototype.hasOwnProperty.call(snapshot, "activeProjectId")) {
    state.activeProjectId = snapshot.activeProjectId;
  }
  state.history = Array.isArray(snapshot.history) ? snapshot.history : state.history;
  state.assets = Array.isArray(snapshot.assets) ? snapshot.assets : state.assets;
  state.prompts = Array.isArray(snapshot.prompts) ? snapshot.prompts : state.prompts;
  state.models = Array.isArray(snapshot.modelRegistry) && snapshot.modelRegistry.length ? snapshot.modelRegistry : state.models;
  return getWorkspaceSnapshot(state);
}

function assertRequest(state: ServerState, request: GenerationRequest, requestId?: string) {
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
  if (state.profile.creditBalance < cost) {
    throw new Error("Not enough credits");
  }
  return { model, cost };
}

function runMockModel(state: ServerState, request: GenerationRequest, requestId?: string): GenerationResult {
  const { model, cost } = assertRequest(state, request, requestId);
  if (requestId) {
    state.submittedRequestIds.add(requestId);
  }
  state.profile = {
    ...state.profile,
    creditBalance: state.profile.creditBalance - cost,
    creditUsed: state.profile.creditUsed + cost,
    credits: state.profile.creditBalance - cost
  };

  const historyId = `history-${state.history.length + 1}`;
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
  state.history = [entry, ...state.history];

  return {
    status: "succeeded",
    creditCost: cost,
    historyId,
    outputs: Array.from({ length: request.outputCount }, (_, index) => ({
      name: `${model.name} output ${index + 1}.jpg`,
      source: `mock://${request.operation}/${request.nodeId}/${index + 1}`,
      width: request.operation === "upscale" ? 2048 : 1024,
      height: request.operation === "upscale" ? 2048 : 1024
    }))
  };
}

export const apiRoutes = {
  "/api/models": (state: ServerState) => state.models,
  "/api/profile": (state: ServerState) => state.profile,
  "/api/history": (state: ServerState) => state.history,
  "/api/admin/audit": (state: ServerState) => state.history,
  "/api/admin/usage": (state: ServerState): AdminUsageSummary => {
    const byModel = new Map<string, { modelId: string; count: number; credits: number }>();
    for (const entry of state.history) {
      const current = byModel.get(entry.modelId) ?? { modelId: entry.modelId, count: 0, credits: 0 };
      byModel.set(entry.modelId, {
        modelId: entry.modelId,
        count: current.count + entry.outputCount,
        credits: current.credits + entry.creditCost
      });
    }
    return {
      totalCreditsUsed: state.profile.creditUsed,
      totalHistoryEntries: state.history.length,
      modelUsage: Array.from(byModel.values())
    };
  },
  "/api/admin/providers": (state: ServerState): ProviderHealth[] => {
    const counts = new Map<string, number>();
    for (const model of state.models) {
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([provider, modelCount]) => ({
      provider,
      status: "healthy",
      modelCount,
      keyLocation: "server"
    }));
  },
  "/api/generations": (state: ServerState, request: GenerationRequest, requestId?: string) =>
    runMockModel(state, { ...request, operation: "generate" }, requestId),
  "/api/edits": (state: ServerState, request: GenerationRequest, requestId?: string) =>
    runMockModel(state, { ...request, operation: "edit" }, requestId),
  "/api/upscale": (state: ServerState, request: GenerationRequest, requestId?: string) =>
    runMockModel(state, { ...request, operation: "upscale" }, requestId),
  "/api/remove-bg": (state: ServerState, request: GenerationRequest, requestId?: string) =>
    runMockModel(state, { ...request, operation: "removeBackground" }, requestId)
};

export function callApi(
  state: ServerState,
  path: keyof typeof apiRoutes,
  request?: GenerationRequest,
  requestId?: string
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
      return route(state, request as GenerationRequest, requestId);
    }
    if (!request) {
      throw new Error("Request body is required");
    }
    return route(state, request, requestId);
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown server error"
    } satisfies ApiError;
  }
}
