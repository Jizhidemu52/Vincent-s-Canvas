import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { historyEntryKey, type HistoryEntry } from "../../../shared/history-removal";
import { removeHistoryEntries } from "@/services/api/generation-task-history";
import { useUiText } from "@/lib/i18n";

type Row = HistoryEntry & { title: string; disabled?: boolean; content: ReactNode };
export function RemovableHistoryList({ rows, ownerId, onRemoved, disabled=false, localOnly=false }: { rows: Row[]; ownerId: string; onRemoved:(removed:HistoryEntry[])=>void|Promise<void>; disabled?: boolean; localOnly?:boolean }) {
    const t=useUiText(), [batch,setBatch]=useState(false),[checked,check]=useState<string[]>([]),[menu,setMenu]=useState(""),[targets,setTargets]=useState<HistoryEntry[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
    const dialog=useRef<HTMLDialogElement>(null),controller=useRef<AbortController|null>(null);
    useEffect(()=>()=>controller.current?.abort(),[]);
    useEffect(()=>{ if(targets.length) dialog.current?.showModal(); else dialog.current?.close(); },[targets]);
    const chosen=rows.filter(row=>!row.disabled&&checked.includes(historyEntryKey(row)));
    const ask=(items:Row[])=>{setMenu("");setError("");setTargets(items.map(({id,kind})=>({id,kind})));};
    const close=()=>{if(!controller.current){setTargets([]);setError("");}};
    const submit=async()=>{
        if(controller.current||disabled)return;
        const c=new AbortController();controller.current=c;setBusy(true);setError("");
        try { if(!localOnly)await removeHistoryEntries(targets,ownerId,c.signal);await onRemoved(targets);if(!c.signal.aborted){setTargets([]);check([]);setBatch(false);} }
        catch(reason){if(!c.signal.aborted)setError(reason instanceof Error?reason.message:"未能确认移除结果，请刷新历史核对");}
        finally{controller.current=null;if(!c.signal.aborted)setBusy(false);}
    };
    const button="rounded px-2 py-1 text-xs hover:bg-muted focus-visible:outline disabled:opacity-40";
    const label=t(localOnly?"从本机历史移除":"从我的历史移除");
    return <>{rows.length>0&&<div className="flex flex-wrap items-center justify-end gap-1">
        {batch&&<button type="button" className={button} disabled={disabled||!chosen.length} onClick={()=>ask(chosen)}>{t("移除所选")} ({chosen.length})</button>}
        <button type="button" className={button} disabled={disabled} onClick={()=>{setBatch(!batch);check([]);setMenu("");}}>{t(batch?"退出批量管理":"批量管理")}</button>
    </div>}{rows.map(row=>{const key=historyEntryKey(row);return <div key={key} role="group" aria-label={row.title} className="relative flex min-w-0 items-center gap-1">
        {batch&&<input type="checkbox" aria-label={t("选择记录")+"："+row.title} disabled={disabled||row.disabled||(!checked.includes(key)&&chosen.length>=100)} checked={checked.includes(key)} onChange={e=>check(e.target.checked?[...checked,key]:checked.filter(k=>k!==key))}/>}
        <div className="min-w-0 flex-1">{row.content}</div>
        <button type="button" aria-label={t("更多操作")} aria-description={row.title} aria-expanded={menu===key} className={button} disabled={disabled} onClick={()=>setMenu(menu===key?"":key)}><MoreHorizontal size={16}/></button>
        {menu===key&&<div className="absolute right-1 top-full z-20 rounded border border-border bg-background p-1 text-foreground shadow" onKeyDown={e=>{if(e.key==="Escape")setMenu("");}}>
            <button type="button" className={button} disabled={disabled||row.disabled} onClick={()=>ask([row])}>{label}</button>
            {row.disabled&&<p className="px-2 text-xs text-muted-foreground">{t("运行中或待核查，暂不能移除")}</p>}
        </div>}
    </div>;})}
    <dialog ref={dialog} aria-label={label} onCancel={e=>{e.preventDefault();close();}} className="fixed inset-0 m-auto max-w-sm rounded-lg border border-border bg-background p-5 text-foreground backdrop:bg-black/40">
        <strong>{label} ({targets.length})</strong><p className="my-3 text-sm">{t(localOnly?"仅从此浏览器的本机列表移除；云端历史、已保存的素材和画布作品不受影响。":"只移除当前账号的云端历史，其他设备同步。已保存的素材、画布作品和计费记录不受影响。")}</p>
        {error&&<p role="alert" className="mb-2 text-sm text-destructive">{t(error)}</p>}
        <div className="flex justify-end gap-2"><button autoFocus type="button" disabled={busy} className={button} onClick={close}>{t("取消")}</button><button type="button" disabled={busy||disabled} className={button+" text-destructive"} onClick={()=>void submit()}>{t(busy?"正在移除…":"确认移除")}</button></div>
    </dialog></>;
}
