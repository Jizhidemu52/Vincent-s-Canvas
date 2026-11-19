import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ConversationEvent, ConversationMessage, ConversationSnapshot, ImageTurn, ImageVersion, SettingsSnapshot } from "../../shared/image-conversation-contracts";
import type { PublicSettingsSnapshot } from "../../shared/image-conversation-public";
import * as Public from "../../shared/image-conversation-public-schemas";
import * as Internal from "../../shared/image-conversation-schemas";
import { toPublicImageConversationData } from "../src/image-conversation-public";
import { resolveEffectiveImageParameters } from "../src/image-output-policy";

function fixture() {
  const modelConfigId = randomUUID(), conversationId = randomUUID(), versionId = randomUUID(), turnId = randomUUID();
  const createdAt = "2026-11-19T02:00:00.000Z";
  const settings = resolveEffectiveImageParameters({ action: "generate_new", intent: { purpose: "standard", complexity: "medium" },
    binding: { modelConfigId, provider: "fixture-channel", providerProtocol: "apimart", apiModelId: "gpt-image-2.6-flare", enabled: true },
    priceSnapshot: { modelId: modelConfigId, quantity: 1, totalCredits: 5, totalRmb: 1.25, priceVersion: 7, configurationVersion: 3 } });
  const version: ImageVersion = { id: versionId, conversationId, rootVersionId: versionId, parentVersionId: null, versionNo: 1, imageNo: 1,
    label: "图 1 · V1", assetId: randomUUID(), source: "generated", turnId, outputIndex: 0,
    requestedState: { schemaVersion: 1, goals: ["保留针织纹理"], constraints: [] }, observation: null, acceptance: "unreviewed",
    parameters: settings, actualDimensions: { width: 2048, height: 2048 }, createdAt };
  const turn: ImageTurn = { id: turnId, conversationId, clientRequestId: "fixture-request", acceptedRevision: 1,
    inputActiveVersionId: null, baseVersionId: null, outputVersionId: null, replyToTurnId: null, intent: "generate_new",
    state: "queued", plannerStatus: "succeeded", taskId: randomUUID(), autoActivate: true, settingsSnapshot: settings,
    assistant: { kind: "status", text: "图片任务已创建", canCancel: true }, lastError: null, createdAt, updatedAt: createdAt };
  const snapshot: ConversationSnapshot = { id: conversationId, title: "针织设计", entrypoint: "standalone", projectUuid: null,
    canvasExternalId: null, activeVersionId: versionId, stateRevision: 1, createdAt, updatedAt: createdAt,
    activeVersion: version, pendingTurn: turn, latestEventSeq: 1, contextSummary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] }, contextSummaryThroughSeq: 0 };
  const message: ConversationMessage = { id: randomUUID(), conversationId, turnId, seq: 1, role: "user", kind: "text",
    text: "请保留原文中的 APIMart Flare 和 gpt-image-2.6-flare 字样。", attachments: [], createdAt };
  const envelope = { conversationId, seq: 1, turnId, createdAt };
  const summary = { id: snapshot.id, title: snapshot.title, entrypoint: snapshot.entrypoint, projectUuid: snapshot.projectUuid,
    canvasExternalId: snapshot.canvasExternalId, activeVersionId: snapshot.activeVersionId, stateRevision: snapshot.stateRevision,
    createdAt, updatedAt: createdAt };
  const events: ConversationEvent[] = [
    { ...envelope, type: "conversation.created", payload: { stateRevision: 1, conversation: summary } },
    ...Internal.turnEventTypeSchema.options.map(type => ({ ...envelope, type, payload: { stateRevision: 1, turn } })),
    { ...envelope, type: "task.progress", payload: { stateRevision: 1, turnId, taskId: turn.taskId!, phase: "queued", progress: null } },
    { ...envelope, type: "version.created", payload: { stateRevision: 1, version } },
    { ...envelope, type: "active.changed", payload: { stateRevision: 1, activeVersionId: versionId, reason: "generation_completed" } },
    { ...envelope, type: "message.created", payload: { stateRevision: 1, message } },
    { ...envelope, type: "context_summary.updated", payload: { stateRevision: 1, contextSummary: snapshot.contextSummary, contextSummaryThroughSeq: 0 } },
    { ...envelope, type: "settings.resolved", payload: { stateRevision: 1, turnId, settingsSnapshot: settings } },
  ];
  return { modelConfigId, settings, version, turn, snapshot, message, events };
}

function freeze(value: unknown) {
  if (value === null || typeof value !== "object") return;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
}

describe("public image conversation model privacy", () => {
  test("all nested snapshots, turns, pages and settings use opaque identities without changing internal audit data", () => {
    const current = fixture();
    const response = { code: "OK", msg: "", data: { snapshot: current.snapshot, turnDetails: { turn: current.turn, stateRevision: 1 },
      versions: { items: [current.version], nextCursor: null }, settings: [current.settings] } };
    const before = JSON.stringify(response);
    freeze(response);
    const projected = toPublicImageConversationData(response);
    expect(JSON.stringify(response)).toBe(before);
    expect(JSON.stringify(projected)).not.toMatch(/Flare|APIMart/i);
    expect(projected.data.settings[0]).toEqual({ ...current.settings, policyVersion: "image-auto-v1",
      effective: { ...current.settings.effective, model: current.modelConfigId } });
    expect(projected.data.settings[0]).not.toBe(current.settings);
    expect(projected.data.settings[0]!.estimate).toEqual(current.settings.estimate);
    expect(projected.data.settings[0]!.sourceMap).toEqual(current.settings.sourceMap);
    expect(Public.conversationSnapshotSchema.safeParse(projected.data.snapshot).success).toBe(true);
    expect(Public.turnDetailsSchema.safeParse(projected.data.turnDetails).success).toBe(true);
    expect(Public.versionPageSchema.safeParse(projected.data.versions).success).toBe(true);
    expect(Internal.settingsSnapshotSchema.safeParse(current.settings).success).toBe(true);
    expect(Internal.settingsSnapshotSchema.safeParse(projected.data.settings[0]).success).toBe(false);
    expect(toPublicImageConversationData(projected)).toEqual(projected);
  });

  test("JSON and SSE share the same projection and all sixteen strict event types remain valid", () => {
    const current = fixture();
    expect(current.events).toHaveLength(16);
    for (const event of current.events) {
      expect(Internal.conversationEventSchema.safeParse(event).success).toBe(true);
      const projected = toPublicImageConversationData(event);
      const json = JSON.parse(JSON.stringify(toPublicImageConversationData({ code: "OK", data: event, msg: "" }))).data;
      const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(projected)}\n\n`;
      const data = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
      expect(data).toEqual(json);
      expect(Public.conversationEventSchema.safeParse(data).success).toBe(true);
      expect(Public.conversationEventSchema.safeParse({ ...data, secret: "unrecognized" }).success).toBe(false);
    }
    const settingsEvent = current.events.find(event => event.type === "settings.resolved")!;
    expect(Public.conversationEventSchema.safeParse(settingsEvent).success).toBe(false);
  });

  test("fixed error envelopes and status texts are redacted while user text, titles and requirements are untouched", () => {
    const current = fixture(), text = "对话图片角色必须绑定已启用的 APIMart Flare 生图与编辑模型";
    const lastError = { code: "MODEL_CAPABILITY_MISMATCH" as const, message: text, retryable: false };
    const turn = { ...current.turn, lastError, assistant: { kind: "status" as const, text, canCancel: false } };
    const data = { snapshot: { ...current.snapshot, title: current.message.text, pendingTurn: turn,
      contextSummary: { ...current.snapshot.contextSummary, text: current.message.text! } },
    messages: [current.message, { ...current.message, kind: "status" as const },
      { ...current.message, role: "assistant" as const, kind: "status" as const, text },
      { ...current.message, role: "assistant" as const, text: current.message.text }],
    error: { code: "OUTPUT_SETTINGS_INVALID", data: { fields: [{ path: "effective.model", message: "gpt-image-2.6-flare 尚未配置" }] }, msg: text } };
    const projected = toPublicImageConversationData(data);
    expect(projected.snapshot.pendingTurn.lastError?.message).toBe("对话图片角色必须绑定已启用的 图像服务 生图与编辑模型");
    expect(projected.snapshot.pendingTurn.assistant.text).not.toMatch(/APIMart|Flare/i);
    expect(projected.error.msg).not.toMatch(/APIMart|Flare/i);
    expect(projected.error.data.fields[0]!.message).toBe("图像服务 尚未配置");
    expect(projected.messages[0]!.text).toBe(current.message.text);
    expect(projected.messages[1]!.text).toBe(current.message.text);
    expect(projected.messages[2]!.text).not.toMatch(/APIMart|Flare/i);
    expect(projected.messages[3]!.text).toBe(current.message.text);
    expect(projected.snapshot.title).toBe(current.message.text);
    expect(projected.snapshot.contextSummary.text).toBe(current.message.text!);
    expect(turn.lastError.message).toBe(text);
  });
});

const invalidSettings: Array<{ name: string; edit: (value: PublicSettingsSnapshot) => unknown }> = [
  { name: "internal model literal", edit: value => ({ ...value, effective: { ...value.effective, model: "gpt-image-2.6-flare" } }) },
  { name: "arbitrary model display name", edit: value => ({ ...value, effective: { ...value.effective, model: "Image model" } }) },
  { name: "different opaque model ID", edit: value => ({ ...value, effective: { ...value.effective, model: randomUUID() } }) },
  { name: "internal policy version", edit: value => ({ ...value, policyVersion: "flare-auto-v1" }) },
  { name: "unrecognized policy version", edit: value => ({ ...value, policyVersion: "image-auto-v2" }) },
  { name: "unknown settings field", edit: value => ({ ...value, rawModel: "secret" }) },
  { name: "unknown effective field", edit: value => ({ ...value, effective: { ...value.effective, provider: "secret" } }) },
  { name: "transparent JPEG", edit: value => ({ ...value, effective: { ...value.effective, background: "transparent", output_format: "jpeg" } }) },
  { name: "size mode mismatch", edit: value => ({ ...value, intent: { ...value.intent, sizeMode: "preserve_aspect" } }) },
  { name: "resolution application mismatch", edit: value => ({ ...value, resolutionApplied: false }) },
  { name: "missing required resolution", edit: value => ({ ...value, effective: { ...value.effective, resolution: undefined } }) },
  { name: "invalid exact pixel dimensions", edit: value => ({ ...value, intent: { ...value.intent, sizeMode: "exact_pixels" }, resolutionApplied: false, effective: { ...value.effective, size: "123x456" } }) },
  { name: "auto quality without max reserve", edit: value => ({ ...value, effective: { ...value.effective, quality: "auto" }, estimate: { ...value.estimate, reservationQuality: "low" } }) },
  { name: "mismatched actual provider receipts", edit: value => ({ ...value, estimate: { ...value.estimate, providerActualRmb: "1" },
    actual: { quality: "high", dimensions: { width: 2048, height: 2048 }, outputFormat: "png", mimeType: "image/png", providerActualRmb: "2", usage: null } }) },
];

describe("public conversation schemas retain internal business constraints", () => {
  test.each(invalidSettings)("rejects $name", ({ edit }) => {
    const settings = toPublicImageConversationData(fixture().settings);
    expect(Public.settingsSnapshotSchema.safeParse(settings).success).toBe(true);
    expect(Public.settingsSnapshotSchema.safeParse(edit(settings)).success).toBe(false);
  });

  test("version lineage, upload/generated boundaries, turn fences and pending states remain strict", () => {
    const current = toPublicImageConversationData(fixture());
    expect(Public.imageVersionSchema.safeParse({ ...current.version, rootVersionId: randomUUID() }).success).toBe(false);
    expect(Public.imageVersionSchema.safeParse({ ...current.version, source: "upload" }).success).toBe(false);
    expect(Public.imageVersionSchema.safeParse({ ...current.version, parameters: null }).success).toBe(false);
    expect(Public.imageVersionSchema.safeParse({ ...current.version, parentVersionId: current.version.id }).success).toBe(false);
    expect(Public.imageTurnSchema.safeParse({ ...current.turn, state: "detached", autoActivate: true }).success).toBe(false);
    expect(Public.imageTurnSchema.safeParse({ ...current.turn, intent: "discuss" }).success).toBe(false);
    expect(Public.imageTurnSchema.safeParse({ ...current.turn, lastError: { code: "UPSTREAM_OUTCOME_UNKNOWN", message: "待核查", retryable: true } }).success).toBe(false);
    expect(Public.conversationSnapshotSchema.safeParse({ ...current.snapshot, pendingTurn: { ...current.turn, state: "completed" } }).success).toBe(false);
    expect(Public.versionPageSchema.safeParse({ items: Array.from({ length: 101 }, () => current.version), nextCursor: null }).success).toBe(false);
  });

  test("valid explicit pixels and normalized cost receipts retain audit fields exactly", () => {
    const current = fixture();
    const settings: SettingsSnapshot = { ...current.settings, intent: { ...current.settings.intent, sizeMode: "exact_pixels" },
      resolutionApplied: false, effective: { ...current.settings.effective, size: "1024x1024", quality: "auto" },
      estimate: { ...current.settings.estimate, reservationQuality: "max", providerActualRmb: "1.20" },
      actual: { quality: null, dimensions: { width: 1024, height: 1024 }, outputFormat: "png", mimeType: "image/png", providerActualRmb: "1.2", usage: { inputTokens: 31, outputTokens: 47, totalTokens: 78 } } };
    const projected = toPublicImageConversationData(settings);
    expect(Internal.settingsSnapshotSchema.safeParse(settings).success).toBe(true);
    expect(Public.settingsSnapshotSchema.safeParse(projected).success).toBe(true);
    expect(projected.actual).toEqual(settings.actual);
    expect(projected.estimate).toEqual(settings.estimate);
  });
});
