import type { TurnError } from "../../shared/image-conversation-contracts";
import { ImageAgentPlanningError } from "../../shared/image-agent-iteration";
import { CanvasImagePromptLanguageError } from "../../shared/image-prompt-invariants";
import { BillingError } from "./billing";
import type { AppConfig } from "./config";
import type { Cache, Database } from "./db";
import { buildImageConversationContext, ImageConversationContextError } from "./image-conversation-context";
import { ImageConversationEvents } from "./image-conversation-events";
import { prepareConversationImage, readConversationActor, resolveConversationRestore } from "./image-conversation-execution";
import { ImageConversationPlannerError, prepareImageConversationPlanner } from "./image-conversation-planner";
import { projectPendingImageConversationTasks } from "./image-conversation-projector";
import { ImageConversationError } from "./image-conversation-store";
import { ImageConversationSummaryFenceError, refreshImageConversationSummary } from "./image-conversation-summary";
import { startImageConversationWorker, type ImageConversationWorkerDependencies } from "./image-conversation-worker";
import { ImageOutputPolicyError } from "./image-output-policy";
import { ModuleDisabledError } from "./module-flags";
import type { ObjectStorage } from "./object-storage";
import { PromptOptimizationError } from "./prompt-safety";
import type { ProviderChatImageAccess } from "./provider-chat-images";
import { publishEnqueuedTask } from "./tasks";
import { ToolConfigurationError } from "./tool-configuration";
import { resolveConversationPlannerBinding } from "./image-conversation-planner-model";

export function classifyImageConversationError(error: unknown): TurnError | undefined {
  if (error instanceof CanvasImagePromptLanguageError || error instanceof ImageAgentPlanningError) return {
    code: "PLAN_INVALID", message: error.message, retryable: false,
  };
  if (error instanceof ImageConversationPlannerError) return {
    code: error.dispatchOutcome === "unknown" ? "PLANNER_OUTCOME_UNKNOWN"
      : ["INSUFFICIENT_CREDIT", "INSUFFICIENT_CREDITS"].includes(error.code) ? "INSUFFICIENT_CREDITS" : "PLANNER_FAILED",
    message: error.message, retryable: false,
  };
  if (error instanceof ImageOutputPolicyError) return {
    code: error.code === "PRICE_UNAVAILABLE" ? "OUTPUT_SETTINGS_INVALID" : error.code, message: error.message, retryable: false,
  };
  if (error instanceof ImageConversationContextError) return {
    code: error.code === "ASSET_NOT_READY" ? "ASSET_NOT_READY" : "PLAN_INVALID", message: error.message, retryable: false,
  };
  if (error instanceof ImageConversationSummaryFenceError) return { code: "PLAN_INVALID", message: error.message, retryable: false };
  if (error instanceof ImageConversationError) return {
    code: error.code === "ASSET_NOT_READY" ? "ASSET_NOT_READY" : error.code === "MODEL_BINDING_UNAVAILABLE" ? "MODEL_BINDING_UNAVAILABLE"
      : error.code === "MODEL_CAPABILITY_MISMATCH" ? "MODEL_CAPABILITY_MISMATCH" : "PLAN_INVALID", message: error.message, retryable: false,
  };
  if (error instanceof ToolConfigurationError || error instanceof ModuleDisabledError || error instanceof PromptOptimizationError) return {
    code: "MODEL_BINDING_UNAVAILABLE", message: error.message, retryable: false,
  };
  if (error instanceof BillingError) return { code: "INSUFFICIENT_CREDITS", message: error.message, retryable: false };
  return undefined;
}

export function createImageConversationRuntime(db: Database, cache: Cache, config: AppConfig, options: {
  storage: ObjectStorage; providerImages: ProviderChatImageAccess; creditsEnabled: (client?: Pick<Database, "query">) => Promise<boolean>;
}) {
  const events = new ImageConversationEvents();
  const wake = (id: string) => events.wake(id);
  const executionOptions = { storage: options.storage, creditsEnabled: options.creditsEnabled, maxInflightTasks: config.USER_MAX_INFLIGHT_TASKS,
    maxPausedTasks: config.PAUSED_TASK_LIMIT_PER_USER,
    outputLimits: config.IMAGE_CONVERSATION_OUTPUT_LIMITS };
  const dependencies: ImageConversationWorkerDependencies = {
    preparePlanner: async (execution, updateManifest) => {
      const actor = await readConversationActor(db, execution.conversation.owner_user_id);
      await refreshImageConversationSummary(db, execution);
      const context = await buildImageConversationContext(db, execution, { storage: options.storage });
      const validate = async (prepared: typeof context) => { await prepared.validate(); await readConversationActor(db, actor.id); };
      const binding = await resolveConversationPlannerBinding(db, execution.conversation.entrypoint);
      const planner = await prepareImageConversationPlanner(db, config, { actor, requestId: `ic:${execution.turn.id}:planner:1`,
        execution: binding, input: context.input, context: context.context, providerImages: options.providerImages, validateContext: () => validate(context),
        lookupHistory: async lookup => {
          const next = await buildImageConversationContext(db, execution, { storage: options.storage, lookup });
          await updateManifest(next.manifest);
          return { ...next, validate: () => validate(next) };
        } });
      return { manifest: context.manifest, run: () => planner.run() };
    },
    prepareImage: execution => prepareConversationImage(db, execution, executionOptions),
    resolveRestore: execution => resolveConversationRestore(db, execution, executionOptions),
    publishTask: task => publishEnqueuedTask(cache, task), wake, classifyError: classifyImageConversationError,
  };
  const worker = startImageConversationWorker(db, dependencies, {
    projectTasks: () => projectPendingImageConversationTasks(db, { storage: options.storage, wake,
      onError: (_error, taskId) => console.error(JSON.stringify({ event: "image_conversation.projection_deferred", taskId })) }),
    onError: error => console.error(JSON.stringify({ event: "image_conversation.background_failed", name: error instanceof Error ? error.name : "UnknownError" })),
  });
  return { events, wake: worker.wake, async stop() { events.close(); await worker.stop(); } };
}
