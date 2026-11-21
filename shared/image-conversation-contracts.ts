/** Entity ID; JSON Schema format: uuid. Request keys are NOT entity IDs. */
export type UUID = string;
/** Opaque, case-sensitive text, 1..160 characters. URL-encode in lookup paths. */
export type RequestKey = string;
/** Finite integer in [0, 9_000_000_000_000_000]; never send bigint in JSON. */
export type SafeInteger = number;
/** RFC 3339 UTC timestamp. */
export type ISODateTime = string;
/** Opaque server cursor, bound to owner, resource, filter and ordering. */
export type Cursor = string;
/** Nonnegative RMB amount as a decimal string, up to 8 fractional places. */
export type DecimalMoney = string;

export type ConversationEntrypoint = "standalone" | "canvas";
export type TurnState =
  | "accepted" | "planning" | "queued" | "generating" | "uncertain"
  | "completed" | "failed" | "cancelled" | "detached";
export type PlannerStatus = "not_started" | "in_flight" | "succeeded" | "failed" | "unknown";
export type TurnIntent = "discuss" | "clarify" | "restore" | "edit" | "generate_new";
export type AttachmentPurpose = "auto" | "reference" | "new_base";
export type FixedFlareQuality = "low" | "medium" | "high" | "xhigh" | "max";
export type FlareQuality = FixedFlareQuality | "auto";
export type FlareResolution = "1k" | "2k" | "4k";
export type FlareComplexity = "low" | "medium" | "high";
export type StaticOutputFormat = "png" | "jpeg" | "webp";
export type FlareBackground = "transparent" | "opaque" | "auto";
export type AspectRatio =
  | "1:1" | "3:2" | "2:3" | "4:3" | "3:4" | "5:4" | "4:5"
  | "16:9" | "9:16" | "2:1" | "1:2" | "21:9" | "9:21" | "3:1" | "1:3";
/** Runtime validation additionally requires integer digits and Flare pixel limits. */
export type ExactPixelSize = `${number}x${number}`;
export type FlareSize = AspectRatio | ExactPixelSize | "auto";
export type SizeMode = "preserve_aspect" | "aspect_ratio" | "exact_pixels" | "provider_auto";
export type OutputPurpose = "draft" | "standard" | "detail" | "final";

export interface OutputPreferences {
  /** Product auto policy; it does NOT automatically forward quality:"auto". */
  mode: "auto" | "manual";
  /** An explicitly supplied field is a user preference, in either mode. */
  quality?: FlareQuality;
  resolution?: FlareResolution;
  /** Omitted edit size preserves first-image ratio + resolution, not exact pixels. */
  size?: FlareSize;
  background?: FlareBackground;
  outputFormat?: StaticOutputFormat;
}

export interface TurnAttachment {
  assetId: UUID;
  purpose?: AttachmentPurpose; // default auto
}

export interface CreateConversationRequest {
  clientRequestId: RequestKey;
  title?: string; // 1..200 characters
  entrypoint: ConversationEntrypoint;
  /** Required for canvas; absent for standalone. Not a projects.id UUID. */
  canvasExternalId?: string;
  /** Existing projects.id; ownership and binding are validated by the service. */
  projectUuid?: UUID;
  /** Existing, owned, ready, non-deleted image asset; root V1 becomes active. */
  initialAssetId?: UUID;
}

export interface SubmitTurnRequest {
  clientRequestId: RequestKey;
  expectedStateRevision: SafeInteger;
  text: string; // 1..10,000 characters; must contain non-whitespace content
  attachments?: TurnAttachment[]; // at most 16; model input budgets are separate
  replyToTurnId?: UUID;
  reuseInputFromTurnId?: UUID;
  /** Omission is normalized to { mode: "auto" } before hashing/resolution. */
  outputPreferences?: OutputPreferences;
}

export interface CancelTurnRequest {
  expectedStateRevision: SafeInteger;
}

export interface PaginationQuery {
  cursor?: Cursor;
  limit?: number; // integer 1..100, default 30
}

export interface VersionListQuery extends PaginationQuery {
  rootVersionId?: UUID;
}

export interface EventSubscriptionQuery {
  afterSeq?: SafeInteger; // default 0; Last-Event-ID header takes precedence
}

export interface ContextSummary {
  schemaVersion: 1;
  /** Compressed conversation history; never an assertion of visual correctness. */
  text: string;
  goals: string[];
  unresolvedQuestions: string[];
}

export interface RequestedConstraint {
  key: string;
  text: string;
  source: "user" | "confirmed_plan";
  sourceTurnId: UUID | null;
}

export interface RequestedState {
  schemaVersion: 1;
  goals: string[];
  /** Current desired state after applying this turn once; not replayable deltas. */
  constraints: RequestedConstraint[];
}

export interface PixelDimensions {
  width: number; // positive integer; actual decoded values, not a request label
  height: number;
}

export interface ImageObservation {
  source: "user" | "vision_check";
  checkedAt: ISODateTime;
  notes: string[];
  confidence?: number; // [0,1], only when the checker supplies it
  verifierModelConfigId?: UUID;
}

export type ParameterSource = "explicit_user" | "inherited" | "planner_intent" | "policy" | "admin_binding";

export interface ParameterSourceMap {
  model: "admin_binding";
  quality: ParameterSource;
  resolution?: ParameterSource;
  size?: ParameterSource;
  complexity: ParameterSource;
  background?: ParameterSource;
  output_format: ParameterSource;
  n: "policy";
}

export interface OutputPolicyIntent {
  purpose: OutputPurpose;
  complexity: FlareComplexity;
  sizeMode: SizeMode;
}

/** Auditable, resolved parameters. No credentials or temporary asset URLs. */
export interface EffectiveImageParameters {
  /** Existing server model_configs.id; selected only by administrator binding. */
  modelConfigId: UUID;
  model: "gpt-image-2.6-flare";
  n: 1;
  quality: FlareQuality;
  complexity: FlareComplexity;
  /** May be absent for exact_pixels, because the upstream ignores it. */
  resolution?: FlareResolution;
  /** Absent with preserve_aspect; literal auto only with provider_auto. */
  size?: FlareSize;
  background?: FlareBackground;
  output_format: StaticOutputFormat;
  // No output_compression for PNG. MVP does not expose compression at all.
}

export interface PriceEstimate {
  /** Existing internal billing configuration; not supplier token cost. */
  internalCredits: number;
  internalRmb: DecimalMoney;
  providerEstimatedRmb: DecimalMoney | null;
  providerActualRmb: DecimalMoney | null;
  /** Describes separately identifiable internal/provider sources; no fixed price. */
  priceSource: string;
  priceVersion: string;
  /** Must be max when effective.quality is auto. */
  reservationQuality: FixedFlareQuality;
}

export interface ProviderUsage {
  inputTokens?: SafeInteger;
  outputTokens?: SafeInteger;
  totalTokens?: SafeInteger;
}

export interface GenerationActual {
  /** Null if the provider does not report the actual selected quality. */
  quality: FixedFlareQuality | null;
  dimensions: PixelDimensions;
  outputFormat: StaticOutputFormat;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  providerActualRmb: DecimalMoney | null;
  usage: ProviderUsage | null;
}

export interface SettingsSnapshot {
  policyVersion: string;
  sourceMap: ParameterSourceMap;
  requested: OutputPreferences;
  intent: OutputPolicyIntent;
  effective: EffectiveImageParameters;
  /** false for exact_pixels even if the legacy adapter adds resolution:"1k". */
  resolutionApplied: boolean;
  estimate: PriceEstimate;
  /** Filled from provider receipts + decoded files, never copied from requests. */
  actual: GenerationActual | null;
}

export interface ImageVersion {
  id: UUID;
  conversationId: UUID;
  rootVersionId: UUID;
  parentVersionId: UUID | null;
  versionNo: SafeInteger; // >=1; monotonic within root, not parent.versionNo+1
  imageNo: SafeInteger; // >=1; monotonic across the whole conversation
  label: string;
  assetId: UUID;
  source: "upload" | "generated";
  turnId: UUID | null;
  outputIndex: 0;
  requestedState: RequestedState;
  observation: ImageObservation | null;
  acceptance: "unreviewed" | "accepted" | "rejected";
  /** null for an upload; frozen generation settings for generated versions. */
  parameters: SettingsSnapshot | null;
  actualDimensions: PixelDimensions | null;
  createdAt: ISODateTime;
}

export interface ConversationMessage {
  id: UUID;
  conversationId: UUID;
  turnId: UUID | null;
  seq: SafeInteger; // >=1
  role: "user" | "assistant";
  kind: "text" | "image" | "status";
  text: string | null;
  /** Version IDs in this conversation; never arbitrary URLs. */
  attachments: UUID[];
  createdAt: ISODateTime;
}

export type TurnErrorCode =
  | "PLANNER_FAILED" | "PLANNER_OUTCOME_UNKNOWN" | "PLAN_INVALID"
  | "ASSET_NOT_READY" | "OUTPUT_SETTINGS_INVALID" | "MODEL_CAPABILITY_MISMATCH"
  | "MODEL_BINDING_UNAVAILABLE" | "INSUFFICIENT_CREDITS"
  | "UPSTREAM_FAILED" | "UPSTREAM_OUTCOME_UNKNOWN" | "RESULT_ARCHIVE_FAILED";

export interface TurnError {
  code: TurnErrorCode;
  message: string;
  /** UI hint for an explicit new request; never authorizes automatic paid retry.
   * false for unknown image/planner receipts. A separately worded new user
   * message is still allowed after a failed planner turn. */
  retryable: boolean;
}

export interface AssistantStatus {
  kind: "status" | "reply" | "question";
  text: string;
  canCancel: boolean;
}

export interface ImageTurn {
  id: UUID;
  conversationId: UUID;
  clientRequestId: RequestKey;
  acceptedRevision: SafeInteger;
  inputActiveVersionId: UUID | null;
  baseVersionId: UUID | null;
  outputVersionId: UUID | null;
  replyToTurnId: UUID | null;
  intent: TurnIntent | null;
  state: TurnState;
  plannerStatus: PlannerStatus;
  taskId: UUID | null;
  autoActivate: boolean;
  settingsSnapshot: SettingsSnapshot | null;
  assistant: AssistantStatus;
  lastError: TurnError | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ConversationSummary {
  id: UUID;
  title: string | null;
  entrypoint: ConversationEntrypoint;
  projectUuid: UUID | null;
  canvasExternalId: string | null;
  activeVersionId: UUID | null;
  stateRevision: SafeInteger;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ConversationSnapshot extends ConversationSummary {
  activeVersion: ImageVersion | null;
  /** accepted/planning/queued/generating/uncertain only; detached is history. */
  pendingTurn: ImageTurn | null;
  latestEventSeq: SafeInteger;
  contextSummary: ContextSummary;
  contextSummaryThroughSeq: SafeInteger;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: Cursor | null;
}

export interface MessagePage {
  items: ConversationMessage[];
  nextCursor: Cursor | null;
}

export interface VersionPage {
  items: ImageVersion[];
  nextCursor: Cursor | null;
}

export interface TurnPage {
  items: ImageTurn[];
  nextCursor: Cursor | null;
}

export interface TurnSubmissionResult {
  turnId: UUID;
  stateRevision: SafeInteger;
  state: TurnState;
  assistant: AssistantStatus;
}

export interface TurnDetails {
  turn: ImageTurn;
  stateRevision: SafeInteger;
}

export type CancellationDisposition =
  | "cancelled_before_submission" | "detached_task_continues" | "already_terminal";

export interface CancellationResult extends TurnSubmissionResult {
  disposition: CancellationDisposition;
}

export type ApiErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "ACCOUNT_NOT_READY" | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT" | "CONVERSATION_REVISION_CONFLICT" | "TURN_IN_PROGRESS" | "TURN_ATTACHMENT_LIMIT"
  | "ASSET_NOT_READY" | "OUTPUT_SETTINGS_INVALID" | "MODEL_CAPABILITY_MISMATCH"
  | "MODEL_BINDING_UNAVAILABLE" | "UPSTREAM_OUTCOME_UNKNOWN"
  | "INSUFFICIENT_CREDITS" | "PRICE_UNAVAILABLE" | "RATE_LIMITED"
  | "EVENT_CURSOR_EXPIRED" | "INTERNAL_ERROR" | "SERVICE_UNAVAILABLE" | "PLANNER_BINDING_UNAVAILABLE";

export interface FieldViolation {
  path: string;
  message: string;
}

export interface ErrorDetails {
  currentStateRevision?: SafeInteger;
  pendingTurnId?: UUID;
  latestEventSeq?: SafeInteger;
  earliestAvailableEventSeq?: SafeInteger;
  snapshotUrl?: string;
  retryAfterSeconds?: number;
  fields?: FieldViolation[];
}

export interface ApiSuccess<T> {
  code: "OK";
  data: T;
  msg: string;
}

export interface ApiError {
  code: ApiErrorCode;
  data: ErrorDetails | null;
  msg: string;
}

export type CreateConversationResponse = ApiSuccess<ConversationSnapshot>;
export type ListConversationsResponse = ApiSuccess<ConversationPage>;
export type GetConversationResponse = ApiSuccess<ConversationSnapshot>;
export type SubmitTurnResponse = ApiSuccess<TurnSubmissionResult>;
export type GetTurnResponse = ApiSuccess<TurnDetails>;
export type ListTurnsResponse = ApiSuccess<TurnPage>;
export type ListMessagesResponse = ApiSuccess<MessagePage>;
export type ListVersionsResponse = ApiSuccess<VersionPage>;
export type CancelTurnResponse = ApiSuccess<CancellationResult>;

export type ConversationEventType =
  | "conversation.created" | "turn.accepted" | "turn.updated" | "plan.ready"
  | "task.queued" | "task.progress" | "version.created" | "active.changed"
  | "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.detached"
  | "turn.uncertain" | "message.created" | "context_summary.updated" | "settings.resolved";

export interface EventEnvelope<TType extends ConversationEventType, TPayload> {
  conversationId: UUID;
  seq: SafeInteger; // >=1; same value as SSE id (decimal text)
  turnId: UUID | null;
  type: TType; // same value as SSE event field
  createdAt: ISODateTime;
  payload: TPayload;
}

export interface ConversationCreatedEventPayload {
  stateRevision: SafeInteger;
  conversation: ConversationSummary;
}

export interface TurnEventPayload {
  stateRevision: SafeInteger;
  turn: ImageTurn;
}

export interface TaskProgressEventPayload {
  stateRevision: SafeInteger;
  turnId: UUID;
  taskId: UUID;
  phase: "queued" | "generating" | "saving" | "reconciling";
  progress: number | null; // percent [0,100]; null when unknown
}

export interface VersionCreatedEventPayload {
  stateRevision: SafeInteger;
  version: ImageVersion;
}

export interface ActiveChangedEventPayload {
  stateRevision: SafeInteger;
  activeVersionId: UUID | null;
  reason: "initial_upload" | "generation_completed" | "restore";
}

export interface MessageCreatedEventPayload {
  stateRevision: SafeInteger;
  message: ConversationMessage;
}

export interface ContextSummaryUpdatedEventPayload {
  stateRevision: SafeInteger;
  contextSummary: ContextSummary;
  contextSummaryThroughSeq: SafeInteger;
}

export interface SettingsResolvedEventPayload {
  stateRevision: SafeInteger;
  turnId: UUID;
  settingsSnapshot: SettingsSnapshot;
}

export type TurnEventType =
  | "turn.accepted" | "turn.updated" | "plan.ready" | "task.queued"
  | "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.detached" | "turn.uncertain";

export type ConversationEvent =
  | EventEnvelope<"conversation.created", ConversationCreatedEventPayload>
  | EventEnvelope<TurnEventType, TurnEventPayload>
  | EventEnvelope<"task.progress", TaskProgressEventPayload>
  | EventEnvelope<"version.created", VersionCreatedEventPayload>
  | EventEnvelope<"active.changed", ActiveChangedEventPayload>
  | EventEnvelope<"message.created", MessageCreatedEventPayload>
  | EventEnvelope<"context_summary.updated", ContextSummaryUpdatedEventPayload>
  | EventEnvelope<"settings.resolved", SettingsResolvedEventPayload>;

/** Product-selected planning model; server configuration supplies the real API
 * identity. A display name is not a verified provider request identifier. */
export interface PlannerModelBinding {
  displayName: "GPT-6.2 Sol";
  modelConfigId: UUID;
  /** Read only from the trusted existing model_configs binding. */
  provider: string;
  /** Read from that binding; never derive this value from displayName. */
  apiModelId: string;
  /** Required gates, not a claim that a provider's capabilities were verified. */
  requiredCapabilities: { vision: true; structuredOutput: true };
}

/** Internal role bindings; public requests cannot select or replace models.
 * Validate planner vision + structured-output support and both trusted
 * configuration identities before dispatch. Do not silently substitute. */
export interface ModelRoleBindings {
  planner: PlannerModelBinding;
  imageEdit: {
    modelConfigId: UUID;
    /** Trusted provider binding must resolve to the existing APIMart channel. */
    provider: string;
    apiModelId: "gpt-image-2.6-flare";
  };
}

export interface AcceptedTurnInput extends Omit<SubmitTurnRequest, "attachments" | "replyToTurnId" | "outputPreferences"> {
  schemaVersion: 1;
  attachments: Array<{ assetId: UUID; purpose: AttachmentPurpose }>;
  replyToTurnId: UUID | null;
  outputPreferences: OutputPreferences;
}

export type VersionSelector =
  | { kind: "current" | "original" | "previous" }
  | { kind: "version"; versionId: UUID };

export interface ChangeDelta {
  kind: "set" | "add" | "remove" | "relative";
  target: string;
  instruction: string;
}

export interface ReferenceRole {
  versionId: UUID;
  role: "identity" | "style" | "composition" | "text" | "color" | "other";
  instruction: string;
}

/** Only values explicitly expressed in this turn's natural language. */
export type ExplicitOutputPreferences = Omit<OutputPreferences, "mode">;

export interface PlannerOutputIntent {
  purpose: OutputPurpose;
  complexity: FlareComplexity;

  explicitPreferences?: ExplicitOutputPreferences;
  sizeMode?: SizeMode;
}

export interface DiscussPlan {
  action: "discuss";
  assistantText: string;
}

export interface ClarifyPlan {
  action: "clarify";
  assistantText: string;
  question: string;
  choices?: string[];
}

export interface RestorePlan {
  action: "restore";
  assistantText: string;
  target: VersionSelector;
}

export interface EditPlan {
  action: "edit";
  assistantText: string;
  base: VersionSelector;
  /** active enables edit-on-original while retaining current design intent. */
  stateSource: "base" | "active";
  changes: ChangeDelta[];
  preserve: string[];
  /** Stable constraint keys, not a command to erase pixels outside this turn. */
  revoke: string[];
  references: ReferenceRole[];
  outputIntent: PlannerOutputIntent;
}

export interface GenerateNewPlan {
  action: "generate_new";
  assistantText: string;
  description: string;
  requestedState: RequestedState;
  references: ReferenceRole[];
  outputIntent: PlannerOutputIntent;
}

export type PlannerPlan = DiscussPlan | ClarifyPlan | RestorePlan | EditPlan | GenerateNewPlan;

export interface ContextImageEntry {
  versionId: UUID;
  assetId: UUID;
  role: "base" | "current" | "original" | "previous" | "reference";
  /** A directory mention is not proof that the planner saw the actual pixels. */
  previewed: boolean;
}

export interface ContextManifest {
  schemaVersion: 1;
  summaryThroughSeq: SafeInteger;
  messageSeqs: SafeInteger[];
  inputActiveVersionId: UUID | null;
  baseVersionId: UUID | null;
  sourceStateVersionId: UUID | null;
  images: ContextImageEntry[];
  /** Asset-to-version registration is explicit; uploading alone does not adopt. */
  attachments: Array<{ assetId: UUID; versionId: UUID; purpose: AttachmentPurpose }>;
  omittedHistory: boolean;
  policyVersion: string;
}

export interface PlannerDispatchFence {
  plannerRequestId: RequestKey;
  plannerDispatchStartedAt: ISODateTime;
  leaseToken: UUID;
  leaseExpiresAt: ISODateTime;
  executionEpoch: SafeInteger;
}

export interface ImageTaskBinding {
  taskId: UUID;
  /** Must equal ic:{turnId}:image:1; existing tasks.request_id is TEXT. */
  taskRequestId: RequestKey;
  imageModelConfigId: UUID;
  imageModelId: "gpt-image-2.6-flare";
  /** Existing tasks.project_id is a canvas external string, not projectUuid. */
  canvasExternalId: string | null;
}
