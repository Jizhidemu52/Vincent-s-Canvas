import { z } from "zod";
import type * as Public from "./image-conversation-public";
import * as Internal from "./image-conversation-schemas";

export {
  assistantStatusSchema, cancellationResultSchema, conversationMessageSchema, conversationPageSchema,
  conversationSummarySchema, messagePageSchema, turnSubmissionResultSchema,
} from "./image-conversation-schemas";

function checkInternal(schema: z.ZodType, value: unknown, context: z.RefinementCtx) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
}

const internalEffective = (value: Public.PublicEffectiveImageParameters) => ({ ...value, model: "gpt-image-2.6-flare" as const });
const internalSettings = (value: Public.PublicSettingsSnapshot | null) => value === null ? null
  : { ...value, policyVersion: "flare-auto-v1", effective: internalEffective(value.effective) };
const internalVersion = (value: Public.PublicImageVersion | null) => value === null ? null
  : { ...value, parameters: internalSettings(value.parameters) };
const internalTurn = (value: Public.PublicImageTurn | null) => value === null ? null
  : { ...value, settingsSnapshot: internalSettings(value.settingsSnapshot) };

export const effectiveImageParametersSchema = z.strictObject({ ...Internal.effectiveImageParametersSchema.shape, model: Internal.uuidSchema })
  .superRefine((value, context) => {
    if (value.model !== value.modelConfigId) context.addIssue({ code: "custom", path: ["model"], message: "公开模型标识必须与模型配置编号一致" });
    checkInternal(Internal.effectiveImageParametersSchema, internalEffective(value), context);
  }) satisfies z.ZodType<Public.PublicEffectiveImageParameters>;

export const settingsSnapshotSchema = z.strictObject({ ...Internal.settingsSnapshotSchema.shape,
  effective: effectiveImageParametersSchema, policyVersion: z.literal("image-auto-v1"),
}).superRefine((value, context) => checkInternal(Internal.settingsSnapshotSchema, internalSettings(value), context)) satisfies z.ZodType<Public.PublicSettingsSnapshot>;

export const imageVersionSchema = z.strictObject({ ...Internal.imageVersionSchema.shape, parameters: settingsSnapshotSchema.nullable() })
  .superRefine((value, context) => checkInternal(Internal.imageVersionSchema, internalVersion(value), context)) satisfies z.ZodType<Public.PublicImageVersion>;

export const imageTurnSchema = z.strictObject({ ...Internal.imageTurnSchema.shape, settingsSnapshot: settingsSnapshotSchema.nullable() })
  .superRefine((value, context) => checkInternal(Internal.imageTurnSchema, internalTurn(value), context)) satisfies z.ZodType<Public.PublicImageTurn>;

export const conversationSnapshotSchema = z.strictObject({ ...Internal.conversationSnapshotSchema.shape,
  activeVersion: imageVersionSchema.nullable(), pendingTurn: imageTurnSchema.nullable(),
}).superRefine((value, context) => checkInternal(Internal.conversationSnapshotSchema,
  { ...value, activeVersion: internalVersion(value.activeVersion), pendingTurn: internalTurn(value.pendingTurn) }, context)) satisfies z.ZodType<Public.PublicConversationSnapshot>;

export const turnDetailsSchema = z.strictObject({ ...Internal.turnDetailsSchema.shape, turn: imageTurnSchema }) satisfies z.ZodType<Public.PublicTurnDetails>;
export const versionPageSchema = z.strictObject({ ...Internal.versionPageSchema.shape, items: z.array(imageVersionSchema).max(100) }) satisfies z.ZodType<Public.PublicVersionPage>;

const eventEnvelopeFields = { conversationId: Internal.uuidSchema, seq: Internal.positiveSequenceSchema, turnId: Internal.uuidSchema.nullable(), createdAt: Internal.isoDateTimeSchema };
export const turnEventPayloadSchema = z.strictObject({ ...Internal.turnEventPayloadSchema.shape, turn: imageTurnSchema });
export const versionCreatedEventPayloadSchema = z.strictObject({ ...Internal.versionCreatedEventPayloadSchema.shape, version: imageVersionSchema });
export const settingsResolvedEventPayloadSchema = z.strictObject({ ...Internal.settingsResolvedEventPayloadSchema.shape, settingsSnapshot: settingsSnapshotSchema });
export const conversationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("conversation.created"), payload: Internal.conversationCreatedEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: Internal.turnEventTypeSchema, payload: turnEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("task.progress"), payload: Internal.taskProgressEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("version.created"), payload: versionCreatedEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("active.changed"), payload: Internal.activeChangedEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("message.created"), payload: Internal.messageCreatedEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("context_summary.updated"), payload: Internal.contextSummaryUpdatedEventPayloadSchema }),
  z.strictObject({ ...eventEnvelopeFields, type: z.literal("settings.resolved"), payload: settingsResolvedEventPayloadSchema }),
]) satisfies z.ZodType<Public.PublicConversationEvent>;
