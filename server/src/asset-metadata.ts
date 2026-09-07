import { z } from "zod";

// Editing descriptive fields must never overwrite file contents or generation provenance.
export const assetMetadataSchema = z.object({
    title: z.string().trim().min(1).max(255),
    tags: z.array(z.string().trim().min(1).max(80)).max(20),
    source: z.string().trim().max(120),
    note: z.string().trim().max(2000),
}).strict();
