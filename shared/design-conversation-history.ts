import { z } from "zod";
import { isoDateTimeSchema, paginationQuerySchema, submitTurnRequestSchema, uuidSchema } from "./image-conversation-schemas";
import { imageTurnSchema, imageVersionSchema } from "./image-conversation-public-schemas";

export const designExecutionIdSchema = z.string().regex(/^design-image-[a-f0-9]{64}$/);
export const designExecutionHistoryQuerySchema = paginationQuerySchema.extend({ canvasExternalId: z.string().min(1).max(200) });
export const designExecutionHistoryRecordSchema = z.strictObject({
  id: designExecutionIdSchema, conversationId: uuidSchema, canvasExternalId: z.string().min(1).max(200),
  title: z.string().max(200).nullable(), createdAt: isoDateTimeSchema, initialAssetId: uuidSchema.nullable(),
  turnRequest: submitTurnRequestSchema.nullable(), turn: imageTurnSchema.nullable(), outputVersion: imageVersionSchema.nullable(),
}).superRefine((value, context) => {
  if (Boolean(value.turn) !== Boolean(value.turnRequest)
    || value.turn && (value.turn.conversationId !== value.conversationId || value.turn.clientRequestId !== `${value.id}:turn`
      || value.turnRequest?.clientRequestId !== value.turn.clientRequestId)
    || value.outputVersion && (!value.turn || value.outputVersion.conversationId !== value.conversationId || value.outputVersion.turnId !== value.turn.id
      || value.outputVersion.id !== value.turn.outputVersionId || value.outputVersion.source !== "generated")) {
    context.addIssue({ code: "custom", message: "设计执行记录与原请求不一致" });
  }
});
export const designExecutionHistoryPageSchema = z.strictObject({ items: z.array(designExecutionHistoryRecordSchema).max(100), nextCursor: z.string().max(4096).nullable() });
export type DesignExecutionHistoryRecord = z.infer<typeof designExecutionHistoryRecordSchema>;
