import { z } from "zod";
import { promptInputSchema } from "./prompt-contracts";

export const taskBaseSchema = z.object({
  requestId: z.string().min(8).max(200),
  projectId: z.string().min(1).max(200),
  operationType: z.string().min(1).max(80),
  toolKey: z.string().min(1).max(100).optional(),
  modelConfigId: z.string().uuid().nullish(),
  prompt: z.string().max(20_000).default(""),
  promptInput: promptInputSchema.optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  priority: z.enum(["normal", "priority", "urgent"]).default("normal"),
});

export const taskSubmissionSchema = taskBaseSchema.extend({
  sourceUrls: z.array(z.string().max(2_000)).max(50).default([]),
});
export const batchSubmissionSchema = taskBaseSchema.extend({
  items: z.array(z.object({ sourceUrls: z.array(z.string().max(2_000)).min(1).max(20) })).min(1).max(100, "每批最多提交 100 个独立任务"),
});
export const taskStatusSchema = z.enum(["waiting", "processing", "paused", "success", "failed", "cancelled"]);
export const taskResponseSchema = z.object({
  task: z.object({
    id: z.string().uuid(), requestId: z.string().min(8).max(200), status: taskStatusSchema,
    resultUrls: z.array(z.string()).optional(), failureReason: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();
export type TaskSubmission = z.infer<typeof taskSubmissionSchema>;
