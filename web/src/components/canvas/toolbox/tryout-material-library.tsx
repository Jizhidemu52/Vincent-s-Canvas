import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {canvasThemes} from "@/lib/canvas-theme";
import {createClientUuid} from "@/lib/client-uuid";
import {useUiText} from "@/lib/i18n";
import {uploadServerAsset} from "@/services/api/server-assets";
import {modelRequest} from "@/services/api/tryout-models";
import {prewarmTryoutSource} from "@/lib/tryout/prewarm";
import {useUserStore} from "@/stores/use-user-store";
import {useThemeStore} from "@/stores/use-theme-store";
import type {KitMaterial} from "./tryout-swatch";
import {KIT_MAX} from "../../../../../shared/tryout-kit";
import {FabricSample} from "./tryout-fabric-sample";

type Preset={id:string;name:string;description:string;thumbAssetId:string|null};
type Mine={id:string;name:string;description:string;useColor:boolean};
type Catalog={mine:Mine[];presets:Preset[]};
export default function TryoutMaterialLibrary({materials,onEdit,onClose,notice}:{materials:KitMaterial[];onEdit:(entry:KitMaterial,id?:string)=>void;onClose:()=>void;notice:string}){
    const t=useUiText(),theme=canvasThemes[useThemeStore(s=>s.theme)],owner=useUserStore(s=>s.user?.id);
    const ref=useRef<HTMLDialogElement>(null),file=useRef<HTMLInputElement>(null),session=useRef<AbortController|null>(null);
    const [catalog,setCatalog]=useState<Catalog>(),[chosen,select]=useState<KitMaterial>(),[error,setError]=useState(""),[busy,setBusy]=useState(false),[revision,refresh]=useState(0);
    const [query,search]=useState("");
    const [analysis,say]=useState<{id:string;message:string}>();
    const [draft,setDraft]=useState<Pick<Mine,"id"|"name"|"description">>();
    const mine=catalog?.mine.find(m=>m.id===chosen?.assetId),preset=catalog?.presets.find(p=>p.id===chosen?.presetId);
    const form=mine&&draft?.id===mine.id?draft:mine;
    const dirty=!!(mine&&form&&(mine.name!==form.name||mine.description!==form.description));
    const load=()=>refresh(i=>i+1);
    useEffect(()=>{ref.current?.showModal();},[]);
    useEffect(()=>{const c=new AbortController();session.current=c;return ()=>c.abort();},[owner]);
    useEffect(()=>{
        const c=new AbortController();
        setError("");void fetch("/api/materials",{credentials:"same-origin",cache:"no-store",signal:c.signal}).then(async r=>{
            if(!r.ok)throw new Error(t("材质库暂不可用"));const data:Catalog=await r.json();if(!c.signal.aborted)setCatalog(data);
        }).catch(e=>{if(!c.signal.aborted)setError(e.message);});
        return ()=>c.abort();
    },[owner,revision,t]);
    const change=async(action:(owner:string,signal:AbortSignal)=>Promise<void>)=>{
        const guard=session.current;if(!guard||guard.signal.aborted||!owner||busy)return;
        setBusy(true);setError("");
        try{await action(owner,guard.signal);if(!guard.signal.aborted)load();}
        catch(e){if(!guard.signal.aborted)setError(e instanceof Error?e.message:t("材质变更未获确认，请刷新材质库核对"));}
        finally{if(!guard.signal.aborted)setBusy(false);}
    };
    const modify=async(method:"PATCH"|"DELETE",id:string,ownerId:string,signal:AbortSignal,data?:unknown)=>{
        const res=await fetch("/api/materials/mine/"+encodeURIComponent(id),{credentials:"same-origin",method,headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":ownerId},body:data?JSON.stringify(data):undefined,signal});
        if(!res.ok)throw new Error(t("材质变更失败，请刷新核对"));
    };
    return createPortal(<dialog ref={ref} aria-label={t("材质库")} onCancel={e=>{e.preventDefault();onClose();}} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}
        className="fixed inset-0 m-auto max-h-[min(660px,calc(100dvh-48px))] w-[min(760px,calc(100vw-32px))] overflow-y-auto rounded-[18px] border p-[18px] backdrop:bg-black/30" style={{background:theme.toolbar.panel,color:theme.node.text,borderColor:theme.toolbar.border}}>
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3"><strong>{t("材质库")}</strong><input aria-label={t("搜材质名")} placeholder={t("搜材质名")} value={query} onChange={e=>search(e.target.value)} className="h-8 rounded-[9px] border px-2"/><button type="button" onClick={onClose}>{t("关闭")}</button></header>
        <fieldset disabled={busy}><legend>{t("预设材质")}</legend><div className="my-2 grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-[10px]">{catalog?.presets.filter(p=>p.name.includes(query.trim())).map(p=><button type="button" key={p.id} aria-label={p.name} aria-pressed={chosen?.id===p.id} onClick={()=>select({id:p.id,presetId:p.id,name:p.name})} className="overflow-hidden rounded-[10px] border text-left text-xs aria-pressed:outline"><div className="h-[60px]"><FabricSample presetId={p.id} photo={p.thumbAssetId?"/api/materials/presets/"+p.id+"/thumb?v="+p.thumbAssetId:undefined}/></div><span className="block px-1.5 pt-1">{p.name}</span><small className="block px-1.5 pb-1">{t("预设")}</small></button>)}<button type="button" className="min-h-[104px] rounded-[10px] border border-dashed text-xs" onClick={()=>file.current?.click()}><span className="block text-xl">＋</span>{t("上传我的面料图")}</button></div>
            {preset?<p className="mb-3 text-sm">{preset.description}</p>:null}
            <h3>{t("我的材质")}</h3>
            <p className="my-1 text-xs">{t("上传后自动识别面料名称和特征，试款时直接复用。")}</p>
            <div className="my-2 grid grid-cols-3 gap-2">{catalog?.mine.map(m=><button type="button" key={m.id} aria-pressed={chosen?.id===m.id} className="truncate rounded border border-current/20 p-1 aria-pressed:outline" onClick={()=>select({id:m.id,assetId:m.id,name:m.name})}><img className="mx-auto size-10 object-cover" alt="" src={"/api/assets/"+m.id+"/thumb?w=256"}/>{m.name}</button>)}</div>
            {mine&&form?<div className="mb-2 grid gap-2 text-sm">
                <label>{t("材质名称")}<input className="block w-full rounded border px-2 py-1" maxLength={80} value={form.name} onChange={e=>setDraft({...form,name:e.target.value})}/></label>
                <label>{t("材质描述")}<textarea className="block w-full rounded border px-2 py-1" maxLength={600} rows={2} value={form.description} onChange={e=>setDraft({...form,description:e.target.value})}/></label>
                {dirty?<button type="button" disabled={!form.name.trim()} onClick={()=>void change(async(id,signal)=>{
                    const data={name:form.name.trim(),description:form.description.trim()};await modify("PATCH",mine.id,id,signal,data);
                    if(!signal.aborted){setCatalog(old=>old&&({...old,mine:old.mine.map(m=>m.id===mine.id?{...m,...data}:m)}));setDraft(undefined);}
                })}>{t("保存修改")}</button>:null}
            </div>:null}
            {mine?<div className="flex justify-between"><label><input type="checkbox" checked={mine.useColor} onChange={e=>{const value=e.target.checked;setCatalog(old=>old&&({...old,mine:old.mine.map(m=>m.id===mine.id?{...m,useColor:value}:m)}));void change(async(id,signal)=>{try{await modify("PATCH",mine.id,id,signal,{useColor:value});}catch(err){if(!signal.aborted)load();throw err;}});}}/> {t("连颜色一起用")}</label><button onClick={()=>void change(async(id,signal)=>{await modify("DELETE",mine.id,id,signal);select(undefined);})}>{t("移出我的材质")}</button></div>:null}
            <input ref={file} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{
                const f=e.target.files?.[0];e.target.value="";if(!f)return;
                if(!["image/png","image/jpeg","image/webp"].includes(f.type)||f.size>10*1024*1024){setError(t("请选择 10 MiB 以内的 PNG、JPG 或 WebP"));return;}
                void change(async(id,signal)=>{
                    say(undefined);
                    const name=f.name.replace(/\.[^.]+$/,"").trim().slice(0,80)||t("面料小样");
                    const assetId=await uploadServerAsset(f,{source:"material-library",uploadName:name,useColor:false},{expectedOwnerId:id,clientReferenceId:"material:"+createClientUuid(),signal});
                    if(signal.aborted)return;
                    select({id:assetId,assetId,name});say({id:assetId,message:t("图片已上传，正在识别面料特征…")});
                    void prewarmTryoutSource(assetId,id,()=>!signal.aborted);
                    const result=await modelRequest<{status:string}>("/api/materials/mine/"+assetId+"/analyze",id,signal,"POST",{}).catch(()=>null);
                    if(!signal.aborted)say(result?.status==="ready"?undefined:{id:assetId,message:t("图片已保留，未取得自动描述。可手填，也可直接按图试款。")});
                });
            }}/>
        </fieldset>
        {analysis&&analysis.id===chosen?.assetId?<p role="status">{analysis.message}</p>:null}
        {!catalog&&!error?<p role="status">{t("正在读取材质库")}</p>:null}
        {error||notice?<p role="status">{error||notice} <button type="button" onClick={load}>{t("刷新")}</button></p>:null}
        <fieldset disabled={!chosen||busy||dirty||(!mine&&!preset)} className="mt-2 border-t border-current/10 pt-2 disabled:opacity-50"><legend>{t("放入企划材质")}</legend>
            <div className="flex flex-wrap gap-2">{materials.map(m=><button type="button" key={m.id} onClick={()=>chosen&&onEdit({...chosen,name:mine?.name??chosen.name},m.id)}>{t("替换")+" "+m.name}</button>)}
                <button disabled={materials.length>=KIT_MAX} type="button" onClick={()=>chosen&&onEdit({...chosen,name:mine?.name??chosen.name})}>{t("加为新的")}</button></div>
        </fieldset>
    </dialog>,document.body);
}
