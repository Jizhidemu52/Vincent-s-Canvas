/** Business-only analytics. No arbitrary DOM text, keystrokes, credentials or media bytes. */
export const USAGE_MAX_EVENT_AGE_MS = 7 * 86_400_000;
export const USAGE_MAX_EVENT_FUTURE_MS = 5 * 60_000;
export const USAGE_ACTIONS = ["visit", "click", "change", "submit", "export", "drop", "download", "open", "close", "gap"] as const;
export type UsageAction = typeof USAGE_ACTIONS[number];
export const USAGE_CONTROLS = ["navigation", "model", "size", "resolution", "quality", "reference-upload", "submit", "export", "tab", "mask", "settings", "template", "download", "copy-prompt", "favorite", "search-filter", "canvas-tool", "local-tool", "dialog", "history", "reset", "undo", "redo", "delete-selection", "paste", "zoom", "drag", "collection-gap"] as const;
export type UsageControlKey = typeof USAGE_CONTROLS[number] | `fallback:${string}:${string}` | `canvas-tool.${string}`;
export const USAGE_FALLBACK_CONTROL_PATTERN = /^fallback:(?:button|a|input|select|textarea|switch|checkbox|radio|tab|menuitem|slider|option|img|div|span):\d{1,4}(?:[.]\d{1,4}){0,11}$/;
export const USAGE_CANVAS_CONTROL_PATTERN = /^canvas-tool\.(?:select|pan|upload|text|config|group|more|generate|image|video|audio|batch|background|info|delete|clear|assets|retry|saveAsset|download|edit|editText|generateImage|decreaseFont|increaseFont|uploadImage|uploadVideo|uploadAudio|manualEdit|crop|split|upscale|superResolve|angle|viewImage|copyPrompt|reversePrompt|compare|designTemplate|restoreGeneration|freeResize|maskEdit|customize|duplicate|rename)$/;
export type UsageParameters = {
  modelConfigId?: string;
  resolution?: "0.5K" | "1K" | "2K" | "4K" | "720P" | "1080P";
  aspectRatio?: string;
  size?: string;
  quality?: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
  referenceCount?: number;
  enabled?: boolean;
  count?: number;
  droppedEventCount?: number;
  n?: number; width?: number; height?: number; duration?: number; steps?: number; seed?: number;
  strength?: number; guidanceScale?: number; creativity?: number; redrawStrength?: number;
  cutWidth?: number; redrawWidth?: number; blurAmount?: number;
  watermark?: boolean; googleSearch?: boolean; googleImageSearch?: boolean; officialFallback?: boolean; nsfw_check?: boolean;
  background?: "auto" | "transparent" | "opaque";
  output_format?: "png" | "jpeg" | "webp"; output_compression?: number;
  moderation?: "auto" | "low";
  midjourneySpeed?: "relax" | "fast" | "turbo"; midjourneyQuality?: number;
  stylize?: number; chaos?: number; weird?: number; stop?: number; tile?: boolean; raw?: boolean;
};
export type UsageClientEvent = {
  eventId: string;
  occurredAt: string;
  boardKey: string;
  action: UsageAction;
  controlKey?: UsageControlKey;
  parameters?: UsageParameters;
};
export type UsageEventsRequest = { events: UsageClientEvent[] };
export type UsageEventsResult = { accepted: number; duplicates: number };
export type UsageEnvelope<T> = { code: 0; data: T; msg: string };
export type UsageFilters = { userIds?: string[]; search?: string; from?: string; to?: string; modelConfigId?: string; boardKey?: string };
export type UsagePagination = { page: number; pageSize: number; total: number };
export type UsageSummary = { visits: number; interactions: number; generationRequests: number; chatRequests: number; succeeded: number; failed: number; pending: number; totalRmbCost: number; generatedImages: number };
export type UsageBucket = { key: string; label: string; count: number };
export type UsageBreakdowns = { boards: UsageBucket[]; models: UsageBucket[]; controls: UsageBucket[]; daily: Array<{ day: string } & UsageSummary> };
export type UsageCoverage = { collectionStartedAt: string | null; historicalTasksAvailable: true; historicalClicksAvailable: false; historicalChatAvailable: false; droppedEventCount?: number; notes: string[] };
export type UsagePerson = { userId: string; displayName: string; departmentName: string | null; summary: UsageSummary; lastActivityAt: string | null };
export type UsagePeopleResult = { people: UsagePerson[]; pagination: UsagePagination; summary: UsageSummary; breakdowns: UsageBreakdowns; coverage: UsageCoverage };
export type UsageRecord = {
  id: string; kind: "visit" | "interaction" | "generation" | "chat" | "gap";
  userId: string; displayName: string; boardKey: string | null; boardLabel: string;
  action: string; controlKey: string | null; controlLabel: string | null;
  modelConfigId: string | null; modelName: string | null;
  status: string; occurredAt: string; updatedAt: string;
  totalRmbCost: number; generatedImages: number;
  prompt: string | null; promptRedacted: boolean; parameters: UsageParameters;
};
export type UsagePersonResult = { person: UsagePerson; summary: UsageSummary; breakdowns: UsageBreakdowns; records: UsageRecord[]; pagination: UsagePagination; coverage: UsageCoverage };
export type UsageMeResult = { boards: UsageBucket[]; controls: UsageBucket[]; coverage: UsageCoverage };
export type UsageAnalysisPreviewRequest = UsageFilters & { includePromptSamples?: boolean };
export type UsageAnalysisPreview = { previewId: string; previewHash: string; expiresAt: string; content: string; estimatedCharacters: number; includesPromptSamples: boolean; sampleCount: number; warnings: string[] };
export type UsageAnalyzeRequest = { previewId: string; previewHash: string; modelConfigId: string; confirm: true };
export type UsageAnalysisResult = { analysisId: string; modelConfigId: string; content: string; createdAt: string };
export type UsageAnalysisModelsResult = { models: Array<{ id: string; name: string; description?: string }> };
/** Routes return UsageEnvelope<T>; errors use {code:string,msg:string}. */
export const USAGE_API = {
  events: "/api/usage/events", me: "/api/usage/me",
  people: "/api/admin/usage/people", person: (id: string) => `/api/admin/usage/people/${encodeURIComponent(id)}`,
  export: "/api/admin/usage/export", analysisPreview: "/api/admin/usage/analysis-preview", analyze: "/api/admin/usage/analyze", analysisModels: "/api/admin/usage/analysis-models",
} as const;
/** People/detail GET: from inclusive,to exclusive,modelConfigId,boardKey,search,page=1,pageSize=50.
 * Search matches employee display name/account across the full population; daily groups use Asia/Shanghai. */
/** POST export: UsageFilters; omitted userIds = all, [] invalid. Streaming application/x-ndjson:
 * {type:"manifest",filters,coverage,exportedAt}, {type:"record",record:UsageRecord}..., {type:"complete",recordCount}.
 * No silent cap. A missing complete line means interrupted/failed export.
 */
