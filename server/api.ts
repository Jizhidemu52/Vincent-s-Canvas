import {
  createInitialWorkspace,
  type GenerationRequest,
  type GenerationResult,
  type HistoryEntry,
  type ModelDefinition,
  type Profile
} from "../src/domain/workspace";

export interface ServerState {
  profile: Profile;
  models: ModelDefinition[];
  history: HistoryEntry[];
  submittedRequestIds: Set<string>;
}

export interface ApiError {
  status: "failed";
  errorMessage: string;
}

export function createServerState(profile: Partial<Profile> = {}): ServerState {
  const workspace = createInitialWorkspace(profile);
  return {
    profile: workspace.profile,
    models: workspace.modelRegistry,
    history: [],
    submittedRequestIds: new Set()
  };
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
    if (path === "/api/models" || path === "/api/profile" || path === "/api/history") {
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
