import {createWorkspaceStorage} from "@/lib/workspace-storage";
import {tryoutKitSchema,type TryoutKit} from "../../../../shared/tryout-kit";

const storage=createWorkspaceStorage("app_state"),key="last-tryout-kit-v1";
let last:TryoutKit|undefined,revision=0,writes=Promise.resolve();
export async function readLastTryoutKit(){
    const start=revision;
    if(!storage.isCurrent())return;
    const saved=tryoutKitSchema.safeParse(await storage.getItem(key).catch(()=>null));
    if(storage.isCurrent()&&start===revision&&saved.success)last=saved.data;
}
export function inheritTryoutKit(){
    return storage.isCurrent() && last ? {tryoutKit:structuredClone(last)} : {};
}
export function rememberTryoutKit(kit:TryoutKit|undefined){
    if(!storage.isCurrent())return;
    last=kit;revision++;
    writes=writes.then(async()=>{if(!storage.isCurrent())return;if(kit)await storage.setItem(key,kit);else await storage.removeItem(key);}).catch(()=>undefined);
}
