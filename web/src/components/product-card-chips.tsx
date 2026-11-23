import {useEffect,useRef,useState} from "react";
import type {ProductCard,ProductCardItem} from "../../../shared/product-card";
import {useUserStore} from "@/stores/use-user-store";
import {readMediaSource,readUploadedMedia,serverMediaId} from "@/services/canvas-media-links";
import {useUiText} from "@/lib/i18n";

const audiences={women:"女装",men:"男装",kids:"童装",unisex:"通用",unknown:"人群未知"};
const positions={head:"头部",neck:"颈部",upper:"上身",lower:"下身",full:"全身",hand:"手部",foot:"脚部",shoulder:"肩背",none:"不穿戴"};
type View={status:"pending"|"ready"|"unavailable";card?:ProductCard};
export default function ProductCardChips({source,inline=false,onPickPart}:{source:string;inline?:boolean;onPickPart?:(part:string)=>void}){
    const t=useUiText(),owner=useUserStore(s=>s.user?.id),marker=useRef<HTMLDivElement>(null);
    const [card,setCard]=useState<ProductCard|null>(null),[draft,setDraft]=useState<ProductCardItem|null>(null),[saving,setSaving]=useState(false),[note,setNote]=useState("");
    const endpoint=useRef(""),sequence=useRef(0);
    useEffect(()=>{
        const controller=new AbortController(),generation=++sequence.current;
        let timer=0,started=false;
        const current=()=>sequence.current===generation&&!controller.signal.aborted&&useUserStore.getState().user?.id===owner;
        endpoint.current="";setCard(null);setDraft(null);setSaving(false);setNote("");
        async function start(){
            if(!owner||started||!current())return;started=true;
            try{
                let id=/^[0-9a-f-]{36}$/i.test(source)?source:serverMediaId(source)||(source.startsWith("image:")?serverMediaId(await readMediaSource(source)||await readUploadedMedia(owner,source)||""):"");
                if(!id&&source.startsWith("image:")&&current()){
                    const {ensureCloudMedia}=await import("@/services/canvas-cloud-media");
                    if(current())id=serverMediaId(await ensureCloudMedia(owner,{url:"",storageKey:source},{source:"product-card"}));
                }
                if(!id||!current())return;
                const url="/api/assets/"+id+"/product-card";endpoint.current=url;
                const read=async(method:"POST"|"GET")=>{
                    const r=await fetch(url,{method,credentials:"same-origin",signal:controller.signal,headers:{"X-Canvas-Owner-Id":owner},cache:"no-store"});
                    if(!r.ok)throw new Error("产品卡暂不可用");
                    return await r.json() as View;
                };
                function observe(view:View,attempt:number){
                    if(!current())return;
                    if(view.status==="ready"&&view.card?.version===2&&view.card.items.length){setCard(view.card);return;}
                    if(attempt>=9||view.status==="unavailable")return;
                    timer=window.setTimeout(()=>{if(current())void read("GET").then(r=>observe(r,attempt+1)).catch(()=>{});},Math.min(8000,1000*2**attempt));
                }
                observe(await read("POST").catch(()=>({status:"pending" as const})),0);
            }catch{}
        }
        const watcher=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){watcher.disconnect();void start();}});
        if(marker.current)watcher.observe(marker.current.closest("[data-node-id]")??marker.current);
        return ()=>{watcher.disconnect();controller.abort();window.clearTimeout(timer);};
    },[source,owner]);
    const selected=Math.max(0,card?.items.findIndex(i=>i.primary)??0),item=card?.items[selected];
    const save=async(next:ProductCard)=>{
        const url=endpoint.current,generation=sequence.current;
        if(!url||!owner||saving||useUserStore.getState().user?.id!==owner)return;
        const current=()=>generation===sequence.current&&useUserStore.getState().user?.id===owner;
        setSaving(true);setNote("");
        try{
            const r=await fetch(url,{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify(next)});
            if(!r.ok)throw new Error("保存失败");
            const result=await r.json() as View;
            if(!result.card)throw new Error("缺少回执");
            if(current()){setCard(result.card);setDraft(null);}
        }catch{if(current())setNote(t("未能确认保存，请重新打开核对"));}
        finally{if(current())setSaving(false);}
    };
    const applyDraft=()=>{if(card&&draft&&draft.category.trim()&&draft.parts.every(p=>p.trim()))void save({...card,items:card.items.map((v,i)=>i===selected?draft:v)});};
    return <><div ref={marker} aria-hidden className="pointer-events-none absolute inset-0"/>{card&&item?<div aria-label={t("产品卡")} className={(inline?"relative rounded-md bg-white/95 px-2 py-1 text-neutral-900 shadow":"pointer-events-auto relative mt-1 min-w-0 break-words text-left")+" z-[1] w-fit max-w-full text-xs"} onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(draft&&e.key==="Enter"&&e.target instanceof HTMLInputElement&&!e.nativeEvent.isComposing){e.preventDefault();applyDraft();}}}>
        {card.items.length>1?<div className="flex flex-wrap gap-1">{card.items.map((v,i)=><button type="button" key={i} disabled={saving} aria-pressed={i===selected} onClick={()=>void save({...card,items:card.items.map((v,j)=>({...v,primary:j===i}))})}>{v.category}</button>)}</div>:null}
        {onPickPart&&!draft?<div aria-label={t("改动部位")} className="flex flex-wrap gap-1">{item.parts.map((part,i)=><button key={i} type="button" className="rounded-md border px-2 py-1" onClick={()=>onPickPart(part)}>{part}</button>)}</div>:null}
        {draft?<div className="grid gap-1">
            <input aria-label={t("品类")} required maxLength={20} value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value})}/>
            <select aria-label={t("人群")} value={draft.audience} onChange={e=>setDraft({...draft,audience:e.target.value as ProductCardItem["audience"]})}>{Object.entries(audiences).map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select>
            <select aria-label={t("穿戴位置")} value={draft.wearPosition} onChange={e=>setDraft({...draft,wearPosition:e.target.value as ProductCardItem["wearPosition"]})}>{Object.entries(positions).map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select>
            <input aria-label={t("材质")} maxLength={30} value={draft.material} onChange={e=>setDraft({...draft,material:e.target.value})}/>
            {draft.parts.map((part,i)=><input key={i} aria-label={t("部位")+" "+(i+1)} required maxLength={10} value={part} onChange={e=>setDraft({...draft,parts:draft.parts.map((v,j)=>i===j?e.target.value:v),colors:draft.colors.map(c=>c.part===part?{...c,part:e.target.value}:c)})}/>)}
            <div className="flex gap-2"><button disabled={saving||!draft.category.trim()||draft.parts.some(p=>!p.trim())} type="button" onClick={applyDraft}>{t("保存标签")}</button><button disabled={saving} type="button" onClick={()=>setDraft(null)}>{t("取消")}</button></div>
        </div>:<button type="button" onClick={()=>setDraft({...item})} aria-label={t("修改产品标签")}>{[item.category,t(audiences[item.audience]),item.material].filter(Boolean).join(" · ")} ✎</button>}
        {note?<span role="status">{note}</span>:null}
    </div>:null}</>;
}
