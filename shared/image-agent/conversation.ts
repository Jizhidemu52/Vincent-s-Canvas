import type { EditPlan, GenerateNewPlan, ImageVersion, RequestedState, VersionSelector } from "../image-conversation-contracts";
import { requestedStateSchema } from "../image-conversation-schemas";
import { compileImageAgentPrompt } from "./compile";
import { resolveImageAgentBase } from "./focus";
import { resolveImageAgentWorkNote } from "./work-note";

export function resolveConversationVersion(versions: readonly ImageVersion[], activeVersionId: string | null, selector: VersionSelector): ImageVersion {
  if (selector.kind !== "version" && !activeVersionId) throw new Error("当前还没有作品，请先提供要修改的图片。");
  const images = versions.map(version => ({ ...version, kind: version.source, parentId: version.parentVersionId ?? undefined, workId: version.rootVersionId }));
  const selected = resolveImageAgentBase(images, { focusId: activeVersionId ?? undefined }, selector.kind === "version" ? selector.versionId : selector.kind === "current" ? "focus" : selector.kind);
  if (!selected) throw new Error("无法解析本轮图片版本，不会自动替换底图。");
  const root = versions.find(version => version.id === selected.rootVersionId);
  if (!root || root.parentVersionId !== null || root.rootVersionId !== root.id || root.versionNo !== 1) throw new Error("作品根版本关系异常。");
  return versions.find(version => version.id === selected.id)!;
}

export function deriveConversationRequestedState(plan: EditPlan | GenerateNewPlan, source: RequestedState | null, turnId: string, userText: string): RequestedState {
  if (plan.action === "generate_new") return requestedStateSchema.parse({ ...plan.requestedState,
    constraints: plan.requestedState.constraints.map(constraint => ({ ...constraint, source: "confirmed_plan", sourceTurnId: turnId })),
  });
  const previous = source ?? { schemaVersion: 1, goals: [], constraints: [] };
  const constraints = new Map(previous.constraints.map(constraint => [constraint.key, constraint]));
  for (const key of plan.revoke) {
    if (!constraints.has(key)) throw new Error("待撤销要求不属于当前版本，请重新澄清。");
    constraints.delete(key);
  }
  const retained = [...constraints.values()].map(item => item.text);
  resolveImageAgentWorkNote({ summary: "", keep: retained }, "", plan.preserve, userText);
  for (const change of plan.changes) {
    if (change.kind === "remove") constraints.delete(change.target);
    else constraints.set(change.target, { key: change.target,
      text: change.kind === "relative" ? `保留来源版本中本轮调整后的${change.target}，后续不得再次执行相对增减。` : `${change.target}：${change.instruction}`,
      source: "confirmed_plan", sourceTurnId: turnId });
  }
  for (const text of plan.preserve) if (![...constraints.values()].some(item => item.text === text)) {
    constraints.set(`preserve:${text}`, { key: `preserve:${text}`, text, source: "confirmed_plan", sourceTurnId: turnId });
  }
  return requestedStateSchema.parse({ schemaVersion: 1, goals: previous.goals, constraints: [...constraints.values()] });
}

export function compileConversationImagePrompt(input: {
  plan: EditPlan | GenerateNewPlan; versions: readonly ImageVersion[]; base: ImageVersion | null;
  sourceState: RequestedState | null; sourceStateVersion: ImageVersion | null; turnId: string; userText: string;
}) {
  const { plan, base } = input;
  const byId = new Map(input.versions.map(version => [version.id, version]));
  const references = plan.references.map(reference => {
    const version = byId.get(reference.versionId);
    if (!version || version.id === base?.id) throw new Error("参考图必须属于当前会话，且不能与底图重复。");
    return { ...reference, version };
  });
  if (new Set(references.map(reference => reference.versionId)).size !== references.length) throw new Error("参考图不能重复。");
  if (plan.action === "edit" && !base) throw new Error("编辑操作缺少底图。");
  const sources = [...(base ? [base] : []), ...references.map(reference => reference.version)];
  if (plan.action === "edit" && plan.stateSource === "active" && input.sourceStateVersion && input.sourceStateVersion.id !== base?.id && !sources.some(version => version.id === input.sourceStateVersion!.id)) sources.push(input.sourceStateVersion);
  if (sources.length > 5) throw new Error("底图与参考图合计最多五张，尚未提交生成。");
  const state = deriveConversationRequestedState(plan, input.sourceState, input.turnId, input.userText);
  const referenceText = references.map(reference => `${reference.version.label}仅作${reference.role}参考：${reference.instruction}`).join("\n");
  const sourceStateText = input.sourceStateVersion && input.sourceStateVersion.id !== base?.id
    ? `设计状态来源为${input.sourceStateVersion.label}，仅继承下面仍有效的要求，不以该参考图替换实际底图。` : "";
  const currentChange = plan.action === "edit" ? plan.changes.map(change => `${change.target}：${change.instruction}`).join("\n") : plan.description;
  const changedKeys = new Set(plan.action === "edit" ? plan.changes.map(change => change.target) : []);
  const keep = state.constraints.filter(constraint => !changedKeys.has(constraint.key)).map(constraint => constraint.text);
  const compiled = compileImageAgentPrompt({ prompt: [currentChange, referenceText, sourceStateText].filter(Boolean).join("\n\n"), keep,
    images: sources.map(version => ({ id: version.id, label: version.label })), baseImageId: base?.id, userPrompt: input.userText });
  return { prompt: compiled.prompt, sources, requestedState: state };
}
