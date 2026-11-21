import {modelRequest} from "./tryout-models";

export type BindingTier="quick"|"hd";
export type TryoutBinding={tier:BindingTier;modelConfigId:string|null;revision:number};
export type TryoutBindings={bindings:TryoutBinding[];models:{id:string;name:string;provider:string;modelId:string}[]};
const endpoint="/api/admin/tryout-bindings";
export const readTryoutBindings=(owner:string,signal:AbortSignal)=>modelRequest<TryoutBindings>(endpoint,owner,signal);
export const saveTryoutBinding=(owner:string,signal:AbortSignal,slot:TryoutBinding,id:string)=>modelRequest<{binding:TryoutBinding}>(endpoint+"/"+slot.tier,owner,signal,"PUT",{modelConfigId:id||null,revision:slot.revision});
