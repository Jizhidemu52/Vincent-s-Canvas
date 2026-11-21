import { z } from "zod";
import {TRYOUT_BATCH_MAX} from "./tryout-limits";
export {TRYOUT_BATCH_MAX};
const uuid=z.string().uuid();
const label=z.string().trim().min(1).max(80);
const hex=z.string().regex(/^#[a-f0-9]{6}$/i).transform(s=>s.toUpperCase());
const common={requestId:uuid,canvasId:z.string().trim().min(1).max(200),nodeId:z.string().trim().min(1).max(200),tier:z.enum(["quick","hd"])};
export const tryoutSubmission=z.discriminatedUnion("kind",[
    z.object({...common,kind:z.literal("color"),sourceAssetId:uuid,color:z.object({name:label,hex,library:label.optional(),code:label.optional()}).strict(),part:label.optional(),fallbackHex:hex.optional()}).strict(),
    z.object({...common,kind:z.literal("material"),sourceAssetId:uuid,material:z.union([z.object({presetId:uuid}).strict(),z.object({assetId:uuid,useColor:z.boolean().default(false)}).strict()]),part:label.optional(),fallbackHex:hex.optional()}).strict(),
    z.object({...common,kind:z.literal("wear"),model:z.union([z.strictObject({assetId:uuid}),z.strictObject({presetId:uuid}),z.strictObject({presetIdentity:z.enum(["white-woman","white-man","white-girl","white-boy"])}),z.strictObject({auto:z.literal(true)})]),productAssetIds:z.array(uuid).min(1).max(4).refine(ids=>new Set(ids).size===ids.length)}).strict(),
]);
export type TryoutSubmission=z.output<typeof tryoutSubmission>;
export type TryoutSubmissionInput=z.input<typeof tryoutSubmission>;
export const refineTryout=z.object({kind:z.literal("refine"),canvasId:common.canvasId,nodeId:common.nodeId,sourceTaskId:uuid}).strict();
export const tryoutBatch=z.strictObject({items:z.array(tryoutSubmission).min(1).max(TRYOUT_BATCH_MAX)}).refine(({items})=>
    items.every(i=>i.tier==="quick"&&i.canvasId===items[0].canvasId)&&new Set(items.map(i=>i.nodeId)).size===items.length&&new Set(items.map(i=>i.requestId)).size===items.length,
    "同批快速试款必须来自同一张画布，每项使用独立节点和操作编号");
