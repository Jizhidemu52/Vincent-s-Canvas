import { z } from "zod";

export const KIT_MAX=6;
const id=z.string().trim().min(1).max(200);
const name=z.string().trim().min(1).max(80);
const color=z.object({id,name,hex:z.string().regex(/^#[0-9a-f]{6}$/i),library:name.optional(),code:name.optional()}).strict();
const material=z.object({id,name,presetId:z.string().uuid().optional(),assetId:z.string().uuid().optional()}).strict()
    .refine(entry=>Boolean(entry.presetId)!==Boolean(entry.assetId),"材质只能有一个来源");
const unique=(entries:{id:string}[])=>new Set(entries.map(entry=>entry.id)).size===entries.length;
export const tryoutKitSchema=z.object({
    version:z.literal(1),colors:z.array(color).max(KIT_MAX).refine(unique),materials:z.array(material).max(KIT_MAX).refine(unique),
}).strict();
export type TryoutKit=z.infer<typeof tryoutKitSchema>;
export function editKit<T extends {id:string}>(entries:readonly T[],item:T|null,replaceId?:string):T[] {
    const index=replaceId===undefined?-1:entries.findIndex(entry=>entry.id===replaceId);
    if(replaceId!==undefined && index<0) throw new Error("企划项已变化，请重新选择");
    if(item===null)return entries.filter((_,i)=>i!==index);
    if(entries.some((entry,i)=>i!==index&&entry.id===item.id))throw new Error("企划中已有这一项");
    if(index>=0)return entries.map((entry,i)=>i===index?item:entry);
    if(entries.length>=KIT_MAX)throw new Error("企划已满，请选择要替换的一项");
    return [...entries,item];
}
