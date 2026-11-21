import { z } from "zod";

export const reviewOriginalReceipt = z.object({
    taskId: z.string().uuid(),
    originals: z.array(z.object({
        assetId: z.string().uuid(), resultIndex: z.number().int().nonnegative(), bytes: z.number().int().positive(),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), filename: z.string().regex(/^task-[0-9a-f-]+-[1-9]\d*-provider-original\.(png|jpg|webp|gif)$/i),
    })),
});

export type ReviewOriginal = z.infer<typeof reviewOriginalReceipt>["originals"][number];
