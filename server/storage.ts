import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServerState, type AccountWorkspace, type ServerState } from "./api";
import type { HistoryEntry, LibraryAsset, ModelDefinition, Profile, Project, PromptPreset } from "../src/domain/workspace";

interface PersistedServerState {
  version: 1;
  profile: Profile;
  models: ModelDefinition[];
  history: HistoryEntry[];
  projects: Project[];
  activeProjectId?: string;
  assets: LibraryAsset[];
  prompts: PromptPreset[];
  accounts?: Record<string, AccountWorkspace>;
  submittedRequestIds: string[];
}

function serializeServerState(state: ServerState): PersistedServerState {
  return {
    version: 1,
    profile: state.profile,
    models: state.models,
    history: state.history,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    assets: state.assets,
    prompts: state.prompts,
    accounts: state.accounts,
    submittedRequestIds: Array.from(state.submittedRequestIds)
  };
}

function hydrateServerState(data: PersistedServerState): ServerState {
  const fallback = createServerState(data.profile);
  return {
    profile: data.profile,
    models: data.models?.length ? data.models : fallback.models,
    history: Array.isArray(data.history) ? data.history : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    activeProjectId: data.activeProjectId,
    assets: Array.isArray(data.assets) ? data.assets : [],
    prompts: Array.isArray(data.prompts) && data.prompts.length ? data.prompts : fallback.prompts,
    accounts: data.accounts ?? {},
    submittedRequestIds: new Set(data.submittedRequestIds ?? [])
  };
}

export function loadServerState(filePath: string, fallback: ServerState = createServerState()): ServerState {
  try {
    const text = readFileSync(filePath, "utf8");
    return hydrateServerState(JSON.parse(text) as PersistedServerState);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export function saveServerState(filePath: string, state: ServerState) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(serializeServerState(state), null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}
