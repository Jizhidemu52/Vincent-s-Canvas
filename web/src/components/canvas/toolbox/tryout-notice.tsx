import type {App} from "antd";
import {uiText as t} from "@/lib/i18n";
import {createClientUuid} from "@/lib/client-uuid";
import {TRYOUT_BATCH_MAX} from "../../../../../shared/tryout-limits";

type Report={accepted:string[];rejected:number;unknown:number};
export function tryoutNotice(notification:ReturnType<typeof App.useApp>["notification"],owner:string,current:()=>boolean,count:number){
    const key="tryout:"+createClientUuid(),limited=count>TRYOUT_BATCH_MAX?" · "+t("仅取前 12 款"):"";
    let stopped=false,cancelling=false,report:Report|undefined;
    const show=(title:string,description:string,action=false,duration=8)=>notification.open({key,placement:"bottom",title,description,actions:action?<button type="button" onClick={()=>void cancel()}>{t("取消排队")}</button>:undefined,duration});
    const cancel=async()=>{
        if(!current()){notification.destroy(key);return;}if(cancelling)return;stopped=true;
        if(!report){show(t("已请求取消"),t("未发出的不再提交；已发出的按原任务核对。"),false,0);return;}
        cancelling=true;let cancelled=0,started=0,unknown=report.unknown;
        for(const id of report.accepted){
            if(!current()){notification.destroy(key);return;}
            try{const r=await fetch("/api/tasks/"+encodeURIComponent(id)+"/cancel",{method:"POST",credentials:"same-origin",headers:{"X-Canvas-Owner-Id":owner}});
                if(r.ok)cancelled++;else if(r.status===409)started++;else unknown++;
            }catch{unknown++;}
        }
        if(current())show(t("取消结果"),t("已撤回 {ok} 款 · 已开始或已结束 {started} 款 · 待核查 {unknown} 款",{ok:cancelled,started,unknown}));
    };
    show(t("正在准备 {count} 款",{count:Math.min(count,TRYOUT_BATCH_MAX)})+limited,t("只对受理的试款预扣，已发出的不重复提交。"),true,0);
    return {canSend:()=>current()&&!stopped,dismiss:()=>notification.destroy(key),finish:async(r:Report)=>{
        report=r;
        if(!current()){notification.destroy(key);return;}
        if(stopped){await cancel();return;}
        show(t("已受理 {count} 款",{count:r.accepted.length})+limited,t("未受理 {rejected} 款 · 待核查 {unknown} 款。排队中的任务可以撤回。",{rejected:r.rejected,unknown:r.unknown}),r.accepted.length>0,20);
    }};
}
