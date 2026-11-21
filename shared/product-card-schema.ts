import {z} from "zod";
import type {ProductCard} from "./product-card";

const word=(max:number)=>z.string().trim().min(1).max(max);
const item=z.strictObject({
    category:word(20),audience:z.enum(["women","men","kids","unisex","unknown"]),material:z.string().trim().max(30),
    parts:z.array(word(10)).max(8),colors:z.array(z.strictObject({name:word(16),hex:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),part:word(10).optional(),primary:z.boolean().optional()})).max(8),
    pattern:z.string().trim().max(40),wearPosition:z.enum(["head","neck","upper","lower","full","hand","foot","shoulder","none"]),primary:z.boolean(),
});
export const productCardSchema=z.strictObject({version:z.literal(2),view:z.enum(["flat","hanging","on-model","mannequin","sketch","fabric","other"]),items:z.array(item).min(1).max(4),background:z.string().trim().max(60)}) satisfies z.ZodType<ProductCard>;
