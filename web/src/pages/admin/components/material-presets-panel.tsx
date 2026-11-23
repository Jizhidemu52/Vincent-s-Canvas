import {useEffect,useRef,useState} from "react";
import {usePresetUpload} from "./use-preset-upload";
import {FabricSample} from "@/components/canvas/toolbox/tryout-fabric-sample";
import {useUiText} from "@/lib/i18n";
import {useUserStore} from "@/stores/use-user-store";

type Draft={name:string;description:string;thumbAssetId:string|null;status:"published"|"hidden";sortOrder:number};
type Preset=Draft&{id:string};
const blank:Draft={name:"",description:"",thumbAssetId:null,status:"published",sortOrder:0};
export default function MaterialPresetsPanel(){
    const t=useUiText(),actor=useUserStore(s=>s.user),owner=actor?.role==="super_admin"?actor.id:undefined;
    const [items,list]=useState<Preset[]>([]),[id,select]=useState(""),[draft,edit]=useState<Draft>(blank),[notice,tell]=useState(""),[busy,lock]=useState(false),[rev,reload]=useState(0);
    const picture=usePresetUpload(owner,"fabric"),life=useRef<AbortController|null>(null);
    useEffect(()=>{const c=new AbortController();life.current=c;edit(blank);select("");list([]);return ()=>c.abort();},[owner]);
    useEffect(()=>{
        if(!owner)return;
        const c=new AbortController();
        void fetch("/api/admin/material-presets",{credentials:"same-origin",cache:"no-store",headers:{"X-Canvas-Owner-Id":owner},signal:c.signal}).then(async r=>{
            if(!r.ok)throw new Error(t("读取预设材质失败"));const data=await r.json();if(!c.signal.aborted)list(data.presets);
        }).catch(e=>{if(!c.signal.aborted)tell(e.message);});return ()=>c.abort();
    },[owner,rev,t]);
    const choose=(p?:Preset)=>{picture.reset();select(p?.id??"");edit(p?{name:p.name,description:p.description,status:p.status,sortOrder:p.sortOrder,thumbAssetId:p.thumbAssetId}:blank);tell("");};
    if(!owner)return null;
    return <section aria-label={t("材质库管理")} className="max-w-3xl space-y-4">
        <h2 className="text-xl font-semibold">{t("材质库管理")}</h2>
        <p>{t("纯文字材质按描述试款；有面料图时，同时参考图片和描述，保留产品原配色。")}</p>
        <label className="grid gap-1">{t("选择预设材质")}<select value={id} disabled={busy} className="rounded border bg-card p-2" onChange={e=>choose(items.find(i=>i.id===e.target.value))}><option value="">{t("新增预设")}</option>{items.map(p=><option key={p.id} value={p.id}>{p.name}{p.status==="hidden"?" · "+t("已隐藏"):""}</option>)}</select></label>
        <form onSubmit={async e=>{
            e.preventDefault();if(busy||useUserStore.getState().user?.id!==owner)return;lock(true);tell("");
            try{
                const signal=life.current!.signal;
                if(picture.busy||picture.photo&&!picture.assetId)return;
                const thumbAssetId=picture.assetId||draft.thumbAssetId;
                signal.throwIfAborted();
                const res=await fetch("/api/admin/material-presets"+(id?"/"+id:""),{method:id?"PATCH":"POST",credentials:"same-origin",signal,headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify({...draft,thumbAssetId})});
                const payload=await res.json();if(!res.ok)throw new Error(payload.message||t("保存未获确认，请刷新核对"));
                if(useUserStore.getState().user?.id!==owner)return;choose(payload.preset);tell(t("材质已保存"));reload(v=>v+1);
            }catch(err){if(useUserStore.getState().user?.id===owner){tell(err instanceof Error?err.message:t("保存未获确认，请刷新核对"));reload(v=>v+1);}}finally{lock(false);}
        }}>
            <fieldset disabled={busy} className="grid gap-3">
                <label className="grid gap-1">{t("材质名称")}<input required maxLength={80} className="rounded border bg-card p-2" value={draft.name} onChange={e=>edit({...draft,name:e.target.value})}/></label>
                <label className="grid gap-1">{t("材质描述")}<textarea required maxLength={600} className="min-h-20 rounded border bg-card p-2" value={draft.description} onChange={e=>edit({...draft,description:e.target.value})}/></label>
                <label className="grid gap-1">{t("上传材质示意图")}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{
                    const f=e.currentTarget.files?.[0];e.currentTarget.value="";if(!f)return;
                    void picture.upload(f,copy=>edit(current=>({...current,name:current.name===draft.name?copy.name:current.name,description:current.description===draft.description?copy.description:current.description})));
                }}/></label>
                {(picture.photo||id)&&<div className="size-24 overflow-hidden rounded border" aria-label={t("材质示意预览")}><FabricSample presetId={id} photo={picture.photo||(draft.thumbAssetId?"/api/admin/material-presets/"+id+"/thumb?v="+draft.thumbAssetId:undefined)}/></div>}
                {picture.photo&&<button type="button" onClick={picture.reset}>{t("取消本次选图")}</button>}
                {picture.message&&<p role="status">{t(picture.message)}</p>}
                <small>{t("PNG、JPG、WebP，最多 10 MiB。保存后，员工只在已发布的材质中看到示意图。")}</small>
                <div className="flex flex-wrap items-end gap-4"><label className="grid">{t("排序")}<input className="w-24 rounded border bg-card p-2" type="number" min="-10000" max="10000" required value={draft.sortOrder} onChange={e=>edit({...draft,sortOrder:Number(e.target.value)})}/></label>
                <label><input type="checkbox" checked={draft.status==="published"} onChange={e=>edit({...draft,status:e.target.checked?"published":"hidden"})}/> {t("员工可见")}</label>
                <button type="submit" disabled={picture.busy||!!picture.photo&&!picture.assetId} className="rounded bg-primary px-3 py-2 text-primary-foreground">{t("保存材质")}</button></div>
            </fieldset>
        </form>
        {notice?<p role="status">{notice}</p>:null}
    </section>;
}
