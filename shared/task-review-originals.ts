import { z } from "zod";

export const reviewOriginalReceipt = z.object({
  canCheckOriginalSize: z.literal(true).optional(),
  taskId: z.string().uuid(),
  originals: z.array(
    z.object({
      assetId: z.string().uuid(),
      resultIndex: z.number().int().nonnegative(),
      bytes: z.number().int().positive(),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      filename: z.string().regex(/^task-[0-9a-f-]+-[1-9]\d*-provider-original\.(png|jpg|webp|gif)$/i),
    }),
  ),
});

export type ReviewOriginal = z.infer<typeof reviewOriginalReceipt>["originals"][number];

export const reissueReceipt = z.union([
  z.object({
    quote: z.object({
      taskId: z.string().uuid(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      modelName: z.string(),
      credits: z.number().nonnegative(),
      estimatedRmb: z.number().nonnegative(),
      confirmation: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  }),
  z.object({
    task: z.object({
      id: z.string().uuid(),
      status: z.string(),
      output: z
        .string()
        .regex(/^\/api\/assets\/[0-9a-f-]{36}\/content$/i)
        .nullish(),
    }),
  }),
]);
export type ReissueReceipt = z.infer<typeof reissueReceipt>;
