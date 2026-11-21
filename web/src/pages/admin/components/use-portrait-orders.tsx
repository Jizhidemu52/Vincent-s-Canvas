import {useEffect,useRef,useState} from "react";
import {createClientUuid} from "@/lib/client-uuid";
import {modelIdentities,type ModelPreset} from "../../../../../shared/model-match";
import {availablePortraitSlots,slotKey,type PortraitSlot} from "../../../../../shared/model-portrait-recipe";
import {ModelRequestError,modelRequest} from "@/services/api/tryout-models";

type Row=ModelPreset&{draftAssetId:string|null;status:string};
type Job=Pick<PortraitSlot,"identity"|"framing">&{id:string;status:string;disposition:string|null};
type Order={requestId:string;slots:PortraitSlot[];confirmedCount:number};
const pending=(j:Job)=>["waiting","processing","paused"].includes(j.status);
const statusLabel:Record<string,string>={waiting:"排队中",processing:"生成中",paused:"暂停，请核对原任务",success:"已完成",failed:"生成失败",cancelled:"已取消"};
const base="/api/admin/model-presets/generation";

export function usePortraitOrders(owner:string|undefined,rows:Row[],refresh:()=>void,catalogReady:boolean){
    const [jobs,setJobs]=useState<Job[]|null>(null),[order,setOrder]=useState<Order|null>(null),[uncertain,setUncertain]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[revision,reload]=useState(0);
    const life=useRef<AbortController|null>(null),sending=useRef(false),latest=useRef(refresh);latest.current=refresh;
    const [retryOriginal,setRetryOriginal]=useState(false);
    const key="tryout-preset-order:"+owner;
    useEffect(()=>{
        const c=new AbortController();life.current=c;sending.current=false;setJobs(null);setBusy(false);setUncertain(false);setRetryOriginal(false);setOrder(null);setNotice("");
        if(owner)try{const saved=sessionStorage.getItem(key);if(saved){const data=JSON.parse(saved) as Order;if(data.requestId&&Array.isArray(data.slots)&&data.confirmedCount===data.slots.length){setOrder(data);setUncertain(true);}}}catch{}
        return ()=>c.abort();
    },[owner,key]);
    useEffect(()=>{
        if(!owner)return;
        const c=new AbortController();let timer:number|undefined,previous="";
        const read=async()=>{
            try{
                const res=await modelRequest<{jobs:Job[]}>(base,owner,c.signal);
                if(c.signal.aborted)return;
                const snapshot=JSON.stringify(res.jobs);
                if(previous&&previous!==snapshot)latest.current();
                previous=snapshot;setJobs(res.jobs);
                if(res.jobs.some(j=>j.status==="waiting"||j.status==="processing"))timer=window.setTimeout(read,2500);
            }catch{if(!c.signal.aborted){setJobs(null);setNotice("未能读取生成队列，请刷新核对");}}
        };
        void read();return ()=>{c.abort();clearTimeout(timer);};
    },[owner,revision]);
    const active=(s:PortraitSlot)=>jobs?.find(j=>slotKey(j)===slotKey(s)&&pending(j));
    const choose=(slots:PortraitSlot[])=>{if(!slots.length||busy||order||!jobs)return;setNotice("");setOrder({requestId:createClientUuid(),slots,confirmedCount:slots.length});};
    const send=async()=>{
        const signal=life.current?.signal;
        if(!owner||!order||sending.current||!signal||signal.aborted)return;
        sending.current=true;setBusy(true);
        try{
            try{sessionStorage.setItem(key,JSON.stringify(order));}
            catch{setNotice("浏览器未能保存批次编号，本次没有发出生成请求。");return;}
            const checking=uncertain&&!retryOriginal;
            const res=checking?await modelRequest<{jobs:{id:string}[]}>(base+"/"+order.requestId,owner,signal):await modelRequest<{jobs:{id:string}[]}>(base,owner,signal,"POST",order);
            if(signal.aborted)return;
            if(checking&&res.jobs?.length===0){setRetryOriginal(true);setNotice("尚未查到原批次。如需继续，只能用原编号提交，避免重复扣费。");return;}
            if(!Array.isArray(res.jobs)||res.jobs.length!==order.confirmedCount)throw new Error();
            sessionStorage.removeItem(key);setOrder(null);setUncertain(false);setRetryOriginal(false);setNotice("已受理 "+res.jobs.length+" 张，结果只进入待审核区。");latest.current();reload(x=>x+1);
        }catch(e){if(!signal.aborted){
            if(!uncertain&&e instanceof ModelRequestError&&e.status>=400&&e.status<500&&e.status!==408){sessionStorage.removeItem(key);setOrder(null);setUncertain(false);setRetryOriginal(false);setNotice(e.message);latest.current();reload(x=>x+1);}
            else{setUncertain(true);setRetryOriginal(false);setNotice("未确认是否受理，只能使用原批次编号再次核对。");}
        }}finally{if(!signal.aborted){sending.current=false;setBusy(false);}}
    };
    const all=modelIdentities.flatMap(m=>availablePortraitSlots(rows,m.identity));
    const usable=(s:PortraitSlot)=>catalogReady&&!!jobs&&!active(s)&&(s.framing==="full"||!!s.fullAssetId);
    const missing=all.filter(s=>!s.expectedAssetId&&usable(s)).filter(s=>s.framing==="full"||!all.some(f=>f.identity===s.identity&&f.framing==="full"&&!f.expectedAssetId));
    return {
        slot:(group:PortraitSlot["identity"],frame:PortraitSlot["framing"])=>{
            const s=all.find(s=>s.identity===group&&s.framing===frame)!,j=active(s)??jobs?.find(j=>slotKey(j)===slotKey(s));
            return <><button type="button" disabled={!!order||!usable(s)} onClick={()=>choose([s])}>{s.expectedAssetId?"重新生成高清图":"生成高清图"}</button>
                {s.framing!=="full"&&!s.fullAssetId?<small>请先准备该模特的全身参考图</small>:null}
                {j?<small>{j.disposition==="superseded"?"结果已保留，格子有更新，未覆盖":statusLabel[j.status]??j.status}</small>:null}</>;
        },
        controls:<div className="space-y-2"><button type="button" disabled={!!order||!missing.length} onClick={()=>choose(missing)}>补齐可生成的空位（{missing.length} 张）</button>{" "}
            <button type="button" disabled={busy} onClick={()=>{latest.current();reload(x=>x+1);}}>刷新生成进度</button>
            {order?<section role="alertdialog" aria-label="确认模特生成费用" className="wb-surface rounded border p-3"><p>{uncertain?"原批次回执待核对":"本次将付费生成"}：{order.confirmedCount} 张高清模特图。不会自动发布。</p>
                <button type="button" disabled={busy} onClick={()=>void send()}>{uncertain?(retryOriginal?"按原编号提交 "+order.confirmedCount+" 张":"按原编号核对"):"确认生成 "+order.confirmedCount+" 张"}</button>{" "}
                {!uncertain&&<button type="button" disabled={busy} onClick={()=>setOrder(null)}>取消</button>}</section>:null}
            {notice?<p role="status">{notice}</p>:null}</div>,
    };
}
