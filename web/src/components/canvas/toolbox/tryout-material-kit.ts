import {useEffect,useState} from "react";
import type {TryoutKit} from "../../../../../shared/tryout-kit";
import {useCanvasGraphField} from "@/stores/canvas/canvas-graph-store";
import {useUserStore} from "@/stores/use-user-store";
import {modelRequest} from "@/services/api/tryout-models";

export const sampleIds=["01","02","03","04","05","06"].map(s=>"60000000-0000-4000-8000-0000000000"+s);
export type MaterialPreset={id:string;name:string;description:string;thumbAssetId:string|null};
const colors=[["海军蓝","#1F2F55"],["雾蓝","#8FA6BF"],["酒红","#7A1F2B"],["驼色","#C19A6B"],["燕麦","#D8CDB8"],["墨绿","#24463A"]].map(([name,hex])=>({name,hex,id:hex}));
export function useWorkbenchKit(){
    const [stored,setKit]=useCanvasGraphField("tryoutKit"),owner=useUserStore(s=>s.user?.id);
    const [catalog,setCatalog]=useState<{owner:string;presets:MaterialPreset[];error?:string}>(),[revision,retry]=useState(0);
    useEffect(()=>{if(!owner)return;const c=new AbortController();
        void modelRequest<{presets:MaterialPreset[]}>("/api/materials",owner,c.signal).then(data=>{if(!c.signal.aborted)setCatalog({owner,presets:data.presets});}).catch(e=>{if(!c.signal.aborted)setCatalog({owner,presets:[],error:e.message});});
        return ()=>c.abort();},[owner,revision]);
    const live=catalog?.owner===owner?catalog:undefined;
    const defaults=sampleIds.slice(0,4).flatMap(id=>{const p=live?.presets.find(r=>r.id===id);return p?[{id,presetId:id,name:p.name}]:[];});
    const kit:TryoutKit=stored??{version:1,colors,materials:defaults};
    return {kit,setKit,defaults,canEdit:Boolean(stored||(live&&!live.error)),presets:live?.presets??[],loading:!live,error:live?.error,retry:()=>retry(v=>v+1)};
}
export type WorkbenchKit=ReturnType<typeof useWorkbenchKit>;
