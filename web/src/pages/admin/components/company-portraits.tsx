import {useEffect,useState} from "react";
import {modelRequest} from "@/services/api/tryout-models";
import {useUiText} from "@/lib/i18n";
import {usePresetUpload} from "./use-preset-upload";
type Entry={id:string;name:string;description:string;status:"published"|"hidden"};
const blank:Entry={id:"",name:"",description:"",status:"published"};
export function CompanyPortraits({owner}:{owner:string}){
    const t=useUiText(),picture=usePresetUpload(owner,"portrait"),[rows,list]=useState<Entry[]>([]),[draft,edit]=useState(blank),[busy,lock]=useState(false),[notice,tell]=useState(""),[rev,reload]=useState(0);
    useEffect(()=>{const c=new AbortController();void modelRequest<{models:Entry[]}>("/api/admin/model-presets/company",owner,c.signal).then(v=>{if(!c.signal.aborted)list(v.models??[]);}).catch(e=>{if(!c.signal.aborted)tell(e.message);});return ()=>c.abort();},[owner,rev]);
    const select=(row:Entry)=>{picture.reset();edit(row);tell("");};
    return <details className="rounded-xl border p-4"><summary>{t("上传或管理公司模特")}</summary><form className="mt-3 grid gap-3" aria-label={t("公司模特")} onSubmit={async e=>{
        e.preventDefault();const id=draft.id||picture.assetId;if(!id||busy||picture.busy)return;lock(true);
        try{const saved=await modelRequest<Entry>("/api/admin/model-presets/company/"+id,owner,new AbortController().signal,"PUT",{name:draft.name,description:draft.description,status:draft.status});select(saved);reload(v=>v+1);tell(t("公司模特已保存"));}
        catch(err){tell(err instanceof Error?err.message:t("保存未获确认，请刷新核对"));}finally{lock(false);}
    }}><fieldset disabled={busy} className="grid gap-3"><label>{t("公司模特预设")} <select value={draft.id} onChange={e=>select(rows.find(r=>r.id===e.target.value)??blank)}><option value="">{t("新增公司模特")}</option>{rows.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
        {!draft.id&&<label>{t("上传模特图")} <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];e.target.value="";if(f)void picture.upload(f,copy=>edit(d=>({...d,name:d.name===draft.name?copy.name:d.name,description:d.description===draft.description?copy.description:d.description})));}}/></label>}
        {(picture.photo||draft.id)&&<img alt={t("模特预览")} className="h-32 object-contain" src={picture.photo||"/api/admin/model-presets/"+draft.id+"/thumb"}/>}
        <label className="grid">{t("模特名称")} <input className="rounded border p-2" required maxLength={80} value={draft.name} onChange={e=>edit({...draft,name:e.target.value})}/></label>
        <label className="grid">{t("模特描述")} <textarea className="rounded border p-2" required maxLength={600} value={draft.description} onChange={e=>edit({...draft,description:e.target.value})}/></label>
        <label><input type="checkbox" checked={draft.status==="published"} onChange={e=>edit({...draft,status:e.target.checked?"published":"hidden"})}/> {t("员工可见")}</label>
        <small>{t("仅上传有权用于公司试款的图片。上传后使用视觉模型识别名称与描述，保存后对设计师生效。")}</small>
        <button disabled={picture.busy||!draft.id&&!picture.assetId} type="submit">{t("保存公司模特")}</button>
    </fieldset>{(picture.message||notice)&&<p role="status">{t(picture.message||notice)}</p>}</form></details>;
}
