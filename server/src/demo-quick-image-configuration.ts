import { createHash } from "node:crypto";
import type { AdminQuickImageConfiguration, QuickImageConfigurationInput, QuickImageEligibleModel } from "../../shared/quick-image-configuration";
import { isQuickImageAction, quickImageModelId, type QuickImageAction } from "../../shared/quick-image-tools";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { isQuickImageEligibleModel, quickImageActions, quickImageConfigurationUpdateSchema, validateQuickImageConfiguration } from "./quick-image-configuration";
import { prepareQuickImageTask, QUICK_IMAGE_SNAPSHOT, quickImageDefaultParameters, quickImageDefaultPrompts, quickImageOutputParameters, type QuickImageInput, type QuickImageSnapshot } from "./quick-image-tools";
import { ToolConfigurationError } from "./tool-configuration";

type Actor = { id: string; role: string } | null;
function admin(actor: Actor) {
  if (!actor) throw new ToolConfigurationError("UNAUTHENTICATED", "请先登录", 401);
  if (actor.role !== "super_admin") throw new ToolConfigurationError("FORBIDDEN", "权限不足", 403);
  return actor;
}

/** In-process demo compatibility only. The demo HTTP server's admin-deny gate stays closed. */
export class DemoQuickImageConfigurationStore {
  private readonly saved = new Map<QuickImageAction, AdminQuickImageConfiguration>();
  private readonly audits: Array<{ action: QuickImageAction; actorId: string; configurationVersion: number; promptHash: string }> = [];
  constructor(private readonly models: Array<Record<string, unknown>>, private readonly providers: Array<Record<string, unknown>>) {}

  private model(id: string) {
    const model = this.models.find(value => value.id === id), provider = model && this.providers.find(value => value.id === model.providerId);
    if (!model || model.enabled !== true || provider?.enabled !== true) throw new ToolConfigurationError("MODEL_DISABLED", "模型或 Provider 不存在或未启用");
    return { id: String(model.id), name: String(model.name || model.modelId), modelId: String(model.modelId), protocol: String(provider.protocol),
      providerName: String(provider.name || ""), capabilities: Array.isArray(model.capabilities) ? model.capabilities as string[] : [],
      enabled: true, providerEnabled: true, workflowConfigId: model.workflowConfigId };
  }

  read(action: QuickImageAction): AdminQuickImageConfiguration {
    const saved = this.saved.get(action);
    if (saved) return { ...structuredClone(saved), parameters: quickImageOutputParameters(action, saved.modelId ?? "", saved.parameters) };
    const model = this.models.find(value => value.modelId === quickImageModelId(action) && value.providerId === MARK_IMAGE_PROVIDER_ID);
    return { action, modelConfigId: model ? String(model.id) : null, modelId: model ? String(model.modelId) : null, modelName: model ? String(model.name || model.modelId) : null,
      prompt: quickImageDefaultPrompts[action], parameters: { ...quickImageDefaultParameters[action] }, configurationVersion: 0, isDefault: true };
  }

  catalog(actor: Actor) {
    admin(actor);
    const models: QuickImageEligibleModel[] = this.models.flatMap(value => {
      try {
        const model = this.model(String(value.id));
        return isQuickImageEligibleModel(model) ? [{ id: model.id, name: model.name, modelId: model.modelId, providerName: model.providerName, protocol: model.protocol, capabilities: model.capabilities }] : [];
      } catch { return []; }
    });
    return { configurations: quickImageActions.map(action => this.read(action)), models };
  }

  save(action: QuickImageAction, raw: unknown, actor: Actor) {
    const identity = admin(actor), { expectedVersion, ...value } = quickImageConfigurationUpdateSchema.parse(raw);
    const current = this.read(action);
    if (current.configurationVersion !== expectedVersion) throw new ToolConfigurationError("QUICK_IMAGE_CONFIGURATION_CONFLICT", "配置已被其他管理员修改，请刷新后重试", 409);
    const model = this.model(value.modelConfigId), input = validateQuickImageConfiguration(action, value, model);
    const configuration: AdminQuickImageConfiguration = { ...input, action, modelId: model.modelId, modelName: model.name, configurationVersion: expectedVersion + 1, isDefault: false };
    this.saved.set(action, structuredClone(configuration));
    this.audits.push({ action, actorId: identity.id, configurationVersion: configuration.configurationVersion, promptHash: createHash("sha256").update(configuration.prompt).digest("hex") });
    return { configuration };
  }

  prepare<T extends QuickImageInput>(input: T, draft?: { configuration: QuickImageConfigurationInput; actor: Actor }): T & { [QUICK_IMAGE_SNAPSHOT]?: QuickImageSnapshot } {
    const action = input.parameters?.quickImageAction;
    if (!isQuickImageAction(action)) return prepareQuickImageTask(input);
    if (input[QUICK_IMAGE_SNAPSHOT] && !draft) return input;
    if (draft) admin(draft.actor);
    const configuration = draft ? { ...draft.configuration, configurationVersion: 0 } : this.read(action);
    if (!configuration.modelConfigId) throw new ToolConfigurationError("MODEL_DISABLED", "管理员尚未配置一键工具的可用模型");
    const model = this.model(configuration.modelConfigId);
    const value = validateQuickImageConfiguration(action, { modelConfigId: configuration.modelConfigId, prompt: configuration.prompt, parameters: configuration.parameters }, model);
    const snapshot: QuickImageSnapshot = Object.freeze({ ...value, action, modelId: model.modelId, parameters: Object.freeze({ ...value.parameters }),
      configurationVersion: configuration.configurationVersion, ...(draft ? { adminTest: true } : {}) });
    return prepareQuickImageTask(input, snapshot);
  }
}
