import {useEffect,useRef,useState,type ReactNode} from "react";
import {temporaryTryoutPreview,retryTryoutSave} from "@/services/api/tryout-result-preview";
import {watchTaskEvents} from "@/services/api/task-events";
import {observeQuickDisplay} from "@/lib/tryout/display-timing";
import {useUserStore} from "@/stores/use-user-store";

export default function TryoutResultPreview({task,owner,children}:{task:string;owner:string;children:ReactNode}){
    const current=useUserStore(s=>s.user?.id),life=useRef<AbortController|null>(null);
    const [view,setView]=useState<{url:string;state:"saving"|"retryable"|"review"}|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
    useEffect(()=>{
        if(current!==owner)return;
        const cancel=new AbortController(),events=watchTaskEvents([task]);
        life.current=cancel;
        let url="";
        void (async()=>{
            const start=Date.now();
            while(!cancel.signal.aborted){
                const revision=events.version;
                try{
                    const result=await temporaryTryoutPreview(task,owner,cancel.signal,!!url);
                    if(result&&!cancel.signal.aborted){
                        if(!url&&result.blob)url=URL.createObjectURL(result.blob);
                        if(url)setView(old=>old?.url===url&&old.state===result.state?old:{url,state:result.state});
                    }
                }catch{}
                if(!cancel.signal.aborted)await events.next(revision,15000,cancel.signal,Date.now()-start<20000?1000:10000);
            }
        })().catch(()=>{});
        return ()=>{cancel.abort();events.close();if(url)URL.revokeObjectURL(url);life.current=null;};
    },[current,task,owner]);
    if(current!==owner||!view)return children;
    return <div className="relative h-full w-full" data-testid="tryout-result-preview">
        <img src={view.url} alt="上游已返回的试款预览" onLoad={e=>observeQuickDisplay(e.currentTarget,task,"preview")} draggable={false} className="h-full w-full object-contain"/>
        <div className="wb-surface absolute inset-x-1 bottom-1 rounded px-2 py-1 text-xs" role="status">
            {view.state==="saving"?"已出图，正在保存原图":view.state==="review"?"已出图，原图保存需要管理员核查":"已出图，原图尚未保存"}
            {view.state==="retryable"&&<button type="button" className="ml-2 underline" disabled={busy} onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onClick={async e=>{
                e.stopPropagation();const signal=life.current?.signal;if(!signal||busy)return;setBusy(true);
                try{
                    const recovered=await retryTryoutSave(task,owner,signal);
                    if(!signal.aborted)setNotice(recovered?"已安排保存原单，不会重新生成":"已核对原单，未重复安排保存");
                }catch{if(!signal.aborted)setNotice("请刷新核对原单，不要重新生成");}
            }}>重试保存</button>}
            {notice&&<p>{notice}</p>}
        </div>
    </div>;
}
