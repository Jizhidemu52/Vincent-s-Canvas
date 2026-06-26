import type { GenerationRequest, GenerationResult, HistoryEntry, ModelDefinition, Profile } from "../domain/workspace";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface BackendSnapshot {
  profile?: Profile;
  history?: HistoryEntry[];
  models?: ModelDefinition[];
}

function endpointForOperation(operation: GenerationRequest["operation"]) {
  if (operation === "edit") return "/api/edits";
  if (operation === "upscale") return "/api/upscale";
  if (operation === "removeBackground") return "/api/remove-bg";
  return "/api/generations";
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { errorMessage?: string };
  if (!response.ok || payload.errorMessage) {
    throw new Error(payload.errorMessage ?? `API request failed with ${response.status}`);
  }
  return payload;
}

export async function submitGenerationRequest(request: GenerationRequest): Promise<GenerationResult> {
  const response = await fetch(`${API_BASE_URL}${endpointForOperation(request.operation)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": `${request.projectId}:${request.nodeId}:${request.operation}:${Date.now()}`
    },
    body: JSON.stringify(request)
  });
  return readJson<GenerationResult>(response);
}

export async function fetchBackendSnapshot(): Promise<BackendSnapshot> {
  const [profile, history, models] = await Promise.all([
    fetch(`${API_BASE_URL}/api/profile`).then((response) => readJson<Profile>(response)),
    fetch(`${API_BASE_URL}/api/history`).then((response) => readJson<HistoryEntry[]>(response)),
    fetch(`${API_BASE_URL}/api/models`).then((response) => readJson<ModelDefinition[]>(response))
  ]);
  return { profile, history, models };
}
