import {useEffect,useRef,useState} from "react";
import {modelIdentities,modelFramings,type ModelPreset} from "../../../../../shared/model-match";
import {useUiText} from "@/lib/i18n";
import {useUserStore} from "@/stores/use-user-store";
import {framingLabels,modelRequest,uploadPortrait} from "@/services/api/tryout-models";
import {usePortraitOrders} from "./use-portrait-orders";
import "./model-presets-panel.css";
import {CompanyPortraits} from "./company-portraits";
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
    const groups=modelIdentities.map((m,index)=>({m,index,first:rows.find(r=>r.identity===m.identity)}))
        .sort((a,b)=>(a.first?.sortOrder??a.index)-(b.first?.sortOrder??b.index)||a.index-b.index);
    return <section aria-label={t("模特库管理")} className="portrait-library"><header className="portrait-library-intro"><h2>{t("模特库管理")}</h2>
        <p>{t("替换先存为待审核图。确认发布前，员工继续使用原图；下架后不能用于新的上身任务。")}</p></header>
        {notice?<p role="status">{notice}</p>:null}
        {generator.controls}
        <CompanyPortraits owner={owner}/>
        {groups.map(({m,first},position)=><section key={m.identity} className="portrait-identity">
            <header><div className="portrait-title"><span aria-hidden="true">{String(position+1).padStart(2,"0")}</span><h3>{first?.name&&first.name!==m.name?first.name:t(m.name)}</h3></div></header>
            {first?<details className="portrait-settings"><summary>{t("编辑名称与顺序")}</summary><form key={first.name+":"+first.sortOrder} onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void run(m.identity,async(id,s)=>{await modelRequest(base+"/identities/"+m.identity,id,s,"PATCH",{name:form.get("name"),sortOrder:Number(form.get("order"))});});}}>
                <label>{t("显示名称")} <input name="name" maxLength={80} required defaultValue={first.name}/></label><label>{t("顺序")} <input name="order" type="number" required min={0} max={999} defaultValue={first.sortOrder}/></label><button disabled={!!busy}>{t("保存名称与顺序")}</button>
            </form></details>:null}<div className="portrait-frames">
            {modelFramings.map(frame=>{const slot=rows.find(p=>p.identity===m.identity&&p.framing===frame),key=m.identity+"/"+frame;
                const status=!slot?"尚无图片":slot.draftAssetId&&slot.status==="published"?"已发布 · 替换待审核":slot.draftAssetId?"待审核":slot.status==="published"?"已发布":"已下架";
                return <fieldset disabled={!!busy} key={key} className="portrait-frame"><legend>{t(framingLabels[frame])}</legend>
                    <div className="portrait-preview">{slot?<img alt={t("审核预览")} src={base+"/"+slot.id+"/thumb?v="+(slot.draftAssetId??slot.assetId)}/>:<span aria-hidden="true">—</span>}</div>
                    <div className="portrait-state" data-state={slot?.draftAssetId?"draft":slot?.status??"empty"}>{t(status)}</div>
                    <div className="portrait-actions"><label className="portrait-upload">{t("上传待审核图")}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{const f=e.target.files?.[0];e.target.value="";if(f)void run(key,async(id,s)=>{const assetId=await uploadPortrait(f,id,s);await modelRequest(base+"/"+key+"/draft",id,s,"PUT",{assetId});});}}/></label>
                    {generator.slot(m.identity,frame)}
                    {slot&&(slot.draftAssetId||slot.status!=="published")?<button className="portrait-publish" type="button" onClick={()=>void run(key,async(id,s)=>{await modelRequest(base+"/"+slot.id+"/publish",id,s,"POST",{expectedAssetId:slot.draftAssetId??slot.assetId});})}>{t("确认发布此图")}</button>:null}
                    {slot?.status==="published"?<button className="portrait-hide" type="button" onClick={()=>void run(key,async(id,s)=>{await modelRequest(base+"/"+slot.id+"/hide",id,s,"POST",{expectedAssetId:slot.assetId});})}>{t("下架当前图")}</button>:null}</div>
                </fieldset>;})}</div></section>)}
    </section>;
}
