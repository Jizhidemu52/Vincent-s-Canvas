import {useEffect,useState} from "react";
import {staticUiText as t} from "@/lib/static-ui-copy";
import {useUserStore} from "@/stores/use-user-store";
import {ModelRequestError} from "@/services/api/tryout-models";
import {readTryoutBindings,saveTryoutBinding,type TryoutBindings,type TryoutBinding,type BindingTier} from "@/services/api/tryout-bindings";

export function TryoutBindingsPanel(){
    const owner=useUserStore(s=>s.user?.role==="super_admin"?s.user.id:null);
    return owner?<BindingEditor key={owner} owner={owner}/>:null;
}

function BindingEditor({owner}:{owner:string}){
    const [session,setSession]=useState<AbortController|null>(null),[data,setData]=useState<TryoutBindings|null>(null);
    const [drafts,setDrafts]=useState<Partial<Record<BindingTier,string>>>({}),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
    useEffect(()=>{
        const controller=new AbortController();
        setSession(controller);setData(null);setDrafts({});setBusy(false);
        void readTryoutBindings(owner,controller.signal).then(result=>{if(!controller.signal.aborted)setData(result);}).catch(e=>{if(!controller.signal.aborted)setNotice(e.message);});
        return ()=>controller.abort();
    },[owner,refresh]);
    async function save(slot:TryoutBinding){
        if(!session||session.signal.aborted||busy||drafts[slot.tier]===undefined)return;
        setBusy(true);setNotice("");
        try{
            const {binding}=await saveTryoutBinding(owner,session.signal,slot,drafts[slot.tier]!);
            if(session.signal.aborted)return;
            setData(d=>d&&({...d,bindings:d.bindings.map(b=>b.tier===binding.tier?binding:b)}));
            setDrafts(d=>({...d,[slot.tier]:undefined}));setNotice(t("已保存，新绑定只影响之后提交的任务。"));
        }catch(e){
            if(session.signal.aborted)return;
            setNotice(e instanceof Error?e.message:t("保存失败，请刷新核对"));
            if(e instanceof ModelRequestError&&e.status===409)setRefresh(n=>n+1);
        }finally{if(!session.signal.aborted)setBusy(false);}
    }
    return <section aria-label={t("试款模型绑定")} className="wb-surface space-y-4 p-5">
        <p>{t("快速试款和高清精修分别配置。更换绑定不会重新生成已受理的任务。")}</p>
        {(["quick","hd"] as const).map(tier=>{
            const slot=data?.bindings.find(b=>b.tier===tier);
            if(!data||!slot)return null;
            const label=tier==="quick"?t("快速试款模型"):t("高清试款模型");
            return <div key={tier} className="flex flex-wrap items-center gap-3">
                <label htmlFor={"tryout-binding-"+tier}>{label}</label>
                <select id={"tryout-binding-"+tier} className="rounded border bg-[var(--background)] p-2" disabled={busy} value={drafts[tier]??slot.modelConfigId??""} onChange={e=>setDrafts(d=>({...d,[tier]:e.target.value}))}>
                    <option value="">{tier==="quick"?t("沿用画布改图默认模型"):t("不启用高清")}</option>
                    {slot.modelConfigId&&!data.models.some(m=>m.id===slot.modelConfigId)&&<option value={slot.modelConfigId} disabled>{t("已绑定模型不可用（请更换）")}</option>}
                    {data.models.map(m=><option key={m.id} value={m.id}>{m.name} · {m.provider} · {m.modelId}</option>)}
                </select>
                <button type="button" className="wb-button px-3 py-2 disabled:opacity-50" disabled={busy||(drafts[tier]??slot.modelConfigId??"")===(slot.modelConfigId??"")} onClick={()=>void save(slot)}>{tier==="quick"?t("保存快速档"):t("保存高清档")}</button>
            </div>;
        })}
        {!data&&!notice&&<p>{t("正在读取试款配置…")}</p>}
        <p role="status">{notice}</p>
        <button type="button" disabled={busy} onClick={()=>{setNotice("");setRefresh(n=>n+1);}}>{t("重新读取试款配置")}</button>
    </section>;
}
