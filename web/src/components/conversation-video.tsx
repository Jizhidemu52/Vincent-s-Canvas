import {useEffect,useRef,useState} from "react";
import localforage from "localforage";
import {getQueuedTaskByRequestId,QueuedTaskHttpError,submitQueuedMediaTask,type QueuedTask} from "@/services/api/generation-tasks";
import {prepareConversationVideo,type VideoProposal,type VideoEntry} from "@/services/api/conversation-video";
import {useUserStore} from "@/stores/use-user-store";

export default function ConversationVideo({owner,turnId,projectId,entry,proposal}:{owner:string;turnId:string;projectId:string;entry:VideoEntry;proposal:VideoProposal}){
    const key="chat-video:"+turnId,marker="video-confirmed:"+owner+":"+turnId;
    const [quote,setQuote]=useState<Awaited<ReturnType<typeof prepareConversationVideo>>>(),[task,setTask]=useState<QueuedTask|null>(null);
    const [locked,lock]=useState(false),[ready,setReady]=useState(false),[error,tell]=useState(""),[rev,refresh]=useState(0);
    const life=useRef<AbortController|null>(null),working=useRef(false);
    const proposalKey=JSON.stringify(proposal);
    useEffect(()=>{
        const c=new AbortController();life.current=c;let timer:ReturnType<typeof setTimeout>|undefined;
        const current=()=>!c.signal.aborted&&useUserStore.getState().user?.id===owner;
        const read=async()=>{
            try{
                const original=await getQueuedTaskByRequestId(key,c.signal);
                if(!current())return;
                if(original){
                    if(original.requestId!==key||original.operationType!=="video_generation"||(original.userId&&original.userId!==owner))throw Error("视频任务身份不匹配");
                    setTask(original);lock(true);setReady(true);tell("");
                    if(["waiting","processing"].includes(original.status))timer=setTimeout(read,3500);
                }else if(await localforage.getItem(marker)){
                    if(current()){lock(true);setReady(true);tell("正在核对原视频任务，不会重复提交。");}
                }else{
                    const next=await prepareConversationVideo(owner,entry,proposal);
                    if(current()){setQuote(next);setReady(true);lock(false);tell("");}
                }
            }catch(e){if(current()){setReady(false);tell(e instanceof Error?e.message:"视频服务暂不可用");}}
        };
        void read();return ()=>{c.abort();clearTimeout(timer);};
    },[owner,turnId,entry,rev,proposalKey]);
    const send=async()=>{
        const signal=life.current?.signal;
        if(!signal||signal.aborted||!ready||!quote||locked||working.current||useUserStore.getState().user?.id!==owner)return;
        working.current=true;lock(true);tell("");
        let marked=false;
        try{
            if(await localforage.getItem(marker)){refresh(n=>n+1);return;}
            const next=await prepareConversationVideo(owner,entry,proposal);signal.throwIfAborted();
            if(next.identity!==quote.identity){setQuote(next);lock(false);tell("视频模型或费用已变化，请核对后再确认。");return;}
            await submitQueuedMediaTask({...next.input,requestId:key,projectId,signal,onSubmissionStarted:async()=>{
                if(useUserStore.getState().user?.id!==owner)throw Error("账号已切换");
                await localforage.setItem(marker,true);marked=true;
            }});
            if(!signal.aborted)refresh(n=>n+1);
        }catch(e){
            const rejected=e instanceof QueuedTaskHttpError&&e.submissionRejected;
            if(rejected&&marked)await localforage.removeItem(marker);
            if(!signal.aborted){lock(marked&&!rejected);tell(marked&&!rejected?"视频受理状态待核对；仅查询原任务，不会重发。":e instanceof Error?e.message:"未能提交视频");}
        }finally{working.current=false;}
    };
    const url=task?.status==="success"?task.resultUrls.find(s=>/^\/api\/assets\/[\w-]+\/content$/.test(s)):null;
    return <section aria-label="本轮视频" className="grid gap-2 rounded-lg border border-border p-3">
        {url?<video controls preload="metadata" src={url} className="max-h-80 max-w-full"/>:null}
        {task?<p role="status">{task.status==="success"?(url?"视频已完成":"视频已完成，暂未取到可播放的文件"):task.status==="waiting"?"视频已排队":task.status==="processing"?"正在生成视频":task.status==="paused"?"视频结果待核查":task.failureReason||"视频任务已结束"}</p>:null}
        {!task&&quote?<p>{quote.summary}</p>:null}
        {error?<p role="status">{error}</p>:null}
        {!task&&ready&&quote&&!locked?<button type="button" onClick={()=>void send()}>确认生成 1 段视频</button>:null}
        {error||task?.status==="paused"?<button type="button" onClick={()=>refresh(n=>n+1)}>核对视频状态</button>:null}
    </section>;
}
