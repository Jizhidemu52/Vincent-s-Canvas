import {useEffect,useRef,useState} from "react";
import {useUserStore} from "@/stores/use-user-store";
import {useUiText} from "@/lib/i18n";
import {audienceLabels,modelRequest,uploadPortrait} from "@/services/api/tryout-models";
import {prewarmTryoutSource} from "@/lib/tryout/prewarm";
import type {ModelAudience,ModelDefault,ModelPreset,PersonalModel,ModelSelection} from "../../../../../shared/model-match";
import type {DropColor,WearChip} from "./tryout-swatch";

const path="/api/tryout/models";
const auto:WearChip={name:"自动配模特",model:{auto:true}};
type Catalog={mine:PersonalModel[];presets:ModelPreset[];preference:ModelDefault};
export function TryoutModels({nodeId,writable,onDrop}:{nodeId?:string;writable:{current:boolean};onDrop:DropColor}){
    const t=useUiText(),owner=useUserStore(s=>s.user?.id);
    const [open,setOpen]=useState(false),[catalog,setCatalog]=useState<Catalog>(),[revision,reload]=useState(0);
    const [chosen,choose]=useState<WearChip>(auto),[audience,setAudience]=useState<ModelAudience>("women"),[notice,tell]=useState(""),[busy,lock]=useState(false);
    const lifetime=useRef<AbortController|null>(null),upload=useRef<HTMLInputElement>(null),drag=useRef<{x:number;y:number}|undefined>(undefined),suppressClick=useRef(false),pending=useRef(false);
    useEffect(()=>{const c=new AbortController();lifetime.current=c;setCatalog(undefined);choose(auto);tell("");lock(false);return ()=>c.abort();},[owner]);
    useEffect(()=>{if(!owner||!open)return;const c=new AbortController();
        void modelRequest<Catalog>(path,owner,c.signal).then(data=>{if(!c.signal.aborted)setCatalog(data);}).catch(e=>{if(!c.signal.aborted)tell(e.message);});return ()=>c.abort();
    },[open,owner,revision]);
    const mutate=async(action:(owner:string,signal:AbortSignal)=>Promise<unknown>)=>{
        const c=lifetime.current;if(!owner||!c||c.signal.aborted||busy)return;
        lock(true);tell("");try{await action(owner,c.signal);}catch(e){if(!c.signal.aborted)tell(e instanceof Error?e.message:t("请刷新核对"));}
        finally{if(!c.signal.aborted){lock(false);reload(i=>i+1);}}
    };
    const wear=async(id:string,chip:WearChip)=>{if(!writable.current||pending.current)return;pending.current=true;try{await onDrop(id,chip,"",Date.now());}finally{pending.current=false;}};
    const tile=(name:string,model:ModelSelection,img:string,asset:string,preset?:string)=>{
        const chip={name,model},key=JSON.stringify(model);
        const warm=()=>void prewarmTryoutSource(asset,owner,()=>!!lifetime.current&&!lifetime.current.signal.aborted,preset);
        return <button key={key} type="button" aria-pressed={JSON.stringify(chosen.model)===key} className="touch-none select-none truncate rounded border border-current/15 p-1 aria-pressed:outline" onFocus={warm} onPointerEnter={warm}
            onPointerDown={e=>{if(!e.isPrimary||e.button!==0)return;suppressClick.current=false;drag.current={x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);}}
            onPointerCancel={()=>{drag.current=undefined;suppressClick.current=true;}}
            onPointerUp={e=>{const start=drag.current;drag.current=undefined;if(!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)<6)return;suppressClick.current=true;
                const target=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>("[data-node-id]");if(target?.dataset.nodeId&&target.querySelector("img[data-canvas-image-resolution]"))void wear(target.dataset.nodeId,chip);}}
            onClick={()=>{if(!suppressClick.current)choose(chip);suppressClick.current=false;}}><img alt="" draggable={false} className="mx-auto h-12 w-full object-contain" src={img}/>{t(name)}</button>;
    };
    const mineId="assetId" in chosen.model?chosen.model.assetId:null;
    const defaults=catalog?.preference,isDefault=mineId?defaults?.assetId===mineId:"presetIdentity" in chosen.model&&defaults?.presetIdentity===chosen.model.presetIdentity;
    return <section aria-label={t("模特上身")} className="mb-3 border-t border-current/10 pt-2">
        <div className="flex items-center justify-between"><strong>{t("模特上身")}</strong><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{t(open?"收起模特库":"选择模特")}</button></div>
        {open?<fieldset disabled={busy} className="my-2 grid gap-2"><button type="button" aria-pressed={"auto" in chosen.model} onClick={()=>choose(auto)}>{t("按产品自动配模特")}</button>
            <div className="grid grid-cols-2 gap-1">{catalog?.presets.filter((p,i,a)=>a.findIndex(x=>x.identity===p.identity)===i).map(p=>tile(p.name,{presetIdentity:p.identity},path+"/presets/"+p.id+"/thumb",p.assetId,p.id))}</div>
            <strong>{t("我的模特")}</strong><div className="grid grid-cols-2 gap-1">{catalog?.mine.map(m=>tile(m.name,{assetId:m.id},"/api/assets/"+m.id+"/thumb?w=256",m.id))}</div>
            <label>{t("上传人群")} <select value={audience} onChange={e=>setAudience(e.target.value as ModelAudience)}>{Object.entries(audienceLabels).map(([v,n])=><option key={v} value={v}>{t(n)}</option>)}</select></label>
            <input ref={upload} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];e.target.value="";if(f)void mutate(async(id,s)=>{const assetId=await uploadPortrait(f,id,s,audience);if(!s.aborted){choose({name:f.name,model:{assetId}});void prewarmTryoutSource(assetId,id,()=>!s.aborted);}});}}/>
            <button type="button" onClick={()=>upload.current?.click()}>{t("上传个人模特")}</button>
            {!("auto" in chosen.model)?<button type="button" onClick={()=>void mutate((id,s)=>modelRequest(path+"/default",id,s,"PUT",isDefault?{}:chosen.model))}>{t(isDefault?"取消我的默认":"设为我的默认")}</button>:null}
            {mineId?<button type="button" onClick={()=>void mutate(async(id,s)=>{await modelRequest(path+"/mine/"+mineId,id,s,"DELETE");if(!s.aborted)choose(auto);})}>{t("移出我的模特库")}</button>:null}
        </fieldset>:null}
        <button type="button" disabled={!nodeId||!writable.current} className="mt-2 min-h-9 w-full rounded border border-current/20 disabled:opacity-50" onClick={()=>{if(nodeId)void wear(nodeId,chosen);}}>{t("上身 1 张")} · {t(chosen.name)}</button>
        {notice?<p role="status">{notice}</p>:null}
    </section>;
}
