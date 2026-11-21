import {useEffect,useState} from "react";
import {modelRequest} from "@/services/api/tryout-models";
import {useUserStore} from "@/stores/use-user-store";

const metrics=[["admission","松手 → 平台受理"],["provider","发往上游 → 收到结果"],["display","收到结果 → 显示回执"],["total","松手 → 首次显示"]] as const;
type Metric=typeof metrics[number][0];
type Issue={state:"failed"|"paused";kind:string|null;code:string|null;hasUpstreamId:boolean;count:number};
type Model={modelId:string;name:string;tasks:number;succeeded:number;failed:number;paused:number;issues:Issue[]}&Record<`${Metric}Samples`,number>&Record<`${Metric}P${50|90}`,number|null>;
const duration=(ms:number|null)=>ms===null?"—":ms<1000?ms+" ms":(ms/1000).toFixed(2)+" s";
export default function TryoutSpeedPanel(){
    const owner=useUserStore(s=>s.user?.role==="super_admin"?s.user.id:null);
    const [data,setData]=useState<{owner:string;models:Model[]}|null>(null),[error,setError]=useState(""),[reload,setReload]=useState(0);
    useEffect(()=>{if(!owner)return;const c=new AbortController();setError("");setData(null);
        void modelRequest<{models:Model[]}>("/api/admin/tryout-bindings/speed",owner,c.signal).then(result=>{if(!c.signal.aborted)setData({owner,models:result.models});}).catch(()=>{if(!c.signal.aborted)setError("暂时无法读取速度统计");});
        return ()=>c.abort();
    },[owner,reload]);
    if(!owner)return null;
    return <section aria-label="试款速度" className="wb-surface space-y-4 p-5">
        <header className="flex items-center justify-between gap-4"><h2 className="font-semibold">快速试款 · 最近 7 天</h2><button type="button" onClick={()=>setReload(x=>x+1)}>刷新统计</button></header>
        <p>中位数（P50）代表一半样本不超过这个时间；P90 是九成样本不超过的时间。显示回执含浏览器上报耗时，刷新重开和后台标签页不计入首显。</p>
        {error?<p role="alert">{error}</p>:data?.owner!==owner?<p role="status">正在读取…</p>:!data.models.length?<p>近七天没有快速试款任务。</p>:data.models.map(m=><article key={m.modelId} className="space-y-2">
            <h3 className="font-semibold">{m.name}</h3><p>受理 {m.tasks} 单 · 成功 {m.succeeded} · 暂停 {m.paused} · 失败 {m.failed}</p>
            <table className="w-full text-left"><thead><tr><th>阶段</th><th>有效样本</th><th>P50</th><th>P90</th></tr></thead><tbody>{metrics.map(([key,label])=><tr key={key}><th scope="row">{label}</th><td>{m[key+"Samples" as `${Metric}Samples`]}</td><td>{duration(m[`${key}P50`])}</td><td>{duration(m[`${key}P90`])}</td></tr>)}</tbody></table>
            {m.issues.length>0?<details><summary>暂停与失败原因分布</summary><ul>{m.issues.map(i=><li key={JSON.stringify([i.state,i.kind,i.code,i.hasUpstreamId])}>{i.state==="paused"?"暂停":"失败"} · {i.kind??"未分类"} · {i.code??"无原因码"} · {i.hasUpstreamId?"有上游 ID":"无上游 ID"}：{i.count} 单</li>)}</ul></details>:null}
        </article>)}
    </section>;
}
