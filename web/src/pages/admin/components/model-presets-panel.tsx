import {useEffect,useRef,useState} from "react";
import {modelIdentities,modelFramings,type ModelPreset} from "../../../../../shared/model-match";
import {useUiText} from "@/lib/i18n";
import {useUserStore} from "@/stores/use-user-store";
import {framingLabels,modelRequest,uploadPortrait} from "@/services/api/tryout-models";
import {usePortraitOrders} from "./use-portrait-orders";
const base="/api/admin/model-presets";
type Slot=ModelPreset&{status:"published"|"draft"|"hidden";draftAssetId:string|null;sortOrder:number};
export default function ModelPresetsPanel(){
    const owner=useUserStore(s=>s.user?.role==="super_admin"?s.user.id:null);
    return owner?<AdminPortraitLibrary key={owner} owner={owner}/>:null;
}
function AdminPortraitLibrary({owner}:{owner:string}){
    const t=useUiText(),[catalogReady,ready]=useState(false);
    const [rows,setRows]=useState<Slot[]>([]),[revision,reload]=useState(0),[busy,setBusy]=useState(""),[notice,tell]=useState("");
    const life=useRef<AbortController|null>(null);
    const generator=usePortraitOrders(owner,rows,()=>reload(v=>v+1),catalogReady);
    useEffect(()=>{const c=new AbortController();life.current=c;setRows([]);setBusy("");tell("");return ()=>c.abort();},[owner]);
    useEffect(()=>{const c=new AbortController();ready(false);void modelRequest<{presets:Slot[]}>(base,owner,c.signal).then(r=>{if(!c.signal.aborted){setRows(r.presets);ready(true);}}).catch(e=>{if(!c.signal.aborted)tell(e.message);});return ()=>c.abort();},[owner,revision]);
    const run=async(key:string,f:(id:string,s:AbortSignal)=>Promise<void>)=>{
        const c=life.current;if(!owner||busy||!c||c.signal.aborted)return;setBusy(key);tell("");
        try{await f(owner,c.signal);}catch(e){if(!c.signal.aborted)tell(e instanceof Error?e.message:t("保存未获确认，请刷新核对"));}
        finally{if(!c.signal.aborted){setBusy("");reload(v=>v+1);}}
    };
    if(!owner)return null;
    return <section aria-label={t("模特库管理")} className="max-w-4xl space-y-4"><h2 className="text-xl font-semibold">{t("模特库管理")}</h2>
        <p>{t("替换先存为待审核图。确认发布前，员工继续使用原图；下架后不能用于新的上身任务。")}</p>
        {notice?<p role="status">{notice}</p>:null}
        {generator.controls}
        {modelIdentities.map(m=>{const first=rows.find(r=>r.identity===m.identity);return <section key={m.identity}><h3 className="mb-2 font-semibold">{t(m.name)}</h3>
            {first?<form key={first.name+":"+first.sortOrder} className="mb-2 flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void run(m.identity,async(id,s)=>{await modelRequest(base+"/identities/"+m.identity,id,s,"PATCH",{name:form.get("name"),sortOrder:Number(form.get("order"))});});}}>
                <label>{t("显示名称")} <input name="name" maxLength={80} required defaultValue={first.name}/></label><label>{t("顺序")} <input className="w-14" name="order" type="number" required min={0} max={999} defaultValue={first.sortOrder}/></label><button disabled={!!busy}>{t("保存名称与顺序")}</button>
            </form>:null}<div className="grid gap-2 sm:grid-cols-3">
            {modelFramings.map(frame=>{const slot=rows.find(p=>p.identity===m.identity&&p.framing===frame),key=m.identity+"/"+frame;
                return <fieldset disabled={!!busy} key={key} className="grid gap-2 rounded border p-3"><legend>{t(framingLabels[frame])}</legend>
                    {generator.slot(m.identity,frame)}
                    {slot?<img className="h-24 w-full object-contain" alt={t("审核预览")} src={base+"/"+slot.id+"/thumb?v="+(slot.draftAssetId??slot.assetId)}/>:null}
                    <span>{t(!slot?"尚无图片":slot.draftAssetId&&slot.status==="published"?"已发布 · 替换待审核":slot.draftAssetId?"待审核":slot.status==="published"?"已发布":"已下架")}</span>
                    <label>{t("上传待审核图")}<input type="file" className="block w-full" accept="image/jpeg,image/png,image/webp" onChange={e=>{const f=e.target.files?.[0];e.target.value="";if(f)void run(key,async(id,s)=>{const assetId=await uploadPortrait(f,id,s);await modelRequest(base+"/"+key+"/draft",id,s,"PUT",{assetId});});}}/></label>
                    {slot&&(slot.draftAssetId||slot.status!=="published")?<button type="button" onClick={()=>void run(key,async(id,s)=>{await modelRequest(base+"/"+slot.id+"/publish",id,s,"POST",{expectedAssetId:slot.draftAssetId??slot.assetId});})}>{t("确认发布此图")}</button>:null}
                    {slot?.status==="published"?<button type="button" onClick={()=>void run(key,async(id,s)=>{await modelRequest(base+"/"+slot.id+"/hide",id,s,"POST",{expectedAssetId:slot.assetId});})}>{t("下架当前图")}</button>:null}
                </fieldset>;})}</div></section>;})}
    </section>;
}
