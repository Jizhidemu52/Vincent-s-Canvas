import { z } from "zod";
const uuid=z.string().uuid();
const label=z.string().trim().min(1).max(80);
const hex=z.string().regex(/^#[a-f0-9]{6}$/i).transform(s=>s.toUpperCase());
const common={requestId:uuid,canvasId:z.string().trim().min(1).max(200),nodeId:z.string().trim().min(1).max(200),tier:z.enum(["quick","hd"])};
export const tryoutSubmission=z.discriminatedUnion("kind",[
    z.object({...common,kind:z.literal("color"),sourceAssetId:uuid,color:z.object({name:label,hex,library:label.optional(),code:label.optional()}).strict(),part:label.optional(),fallbackHex:hex.optional()}).strict(),
    z.object({...common,kind:z.literal("material"),sourceAssetId:uuid,material:z.union([z.object({presetId:uuid}).strict(),z.object({assetId:uuid,useColor:z.boolean().default(false)}).strict()]),part:label.optional(),fallbackHex:hex.optional()}).strict(),
    z.object({...common,kind:z.literal("wear"),model:z.object({assetId:uuid}).strict(),productAssetIds:z.array(uuid).min(1).max(4).refine(ids=>new Set(ids).size===ids.length)}).strict(),
]);
export type TryoutSubmission=z.output<typeof tryoutSubmission>;
export type TryoutSubmissionInput=z.input<typeof tryoutSubmission>;
export const refineTryout=z.object({kind:z.literal("refine"),canvasId:common.canvasId,nodeId:common.nodeId,sourceTaskId:uuid}).strict();
