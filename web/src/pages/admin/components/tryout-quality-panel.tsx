import {useEffect,useState} from "react";
import type {qualityReport,ReviewPoint} from "../../../../../shared/try-on-quality";
import {modelRequest} from "@/services/api/tryout-models";
import {useUserStore} from "@/stores/use-user-store";

type Rows=ReturnType<typeof qualityReport>;
const framing={head:"头肩",half:"半身",full:"全身"};
export default function TryoutQualityPanel(){
    const owner=useUserStore(s=>s.user?.role==="super_admin"?s.user.id:null);
    const [data,setData]=useState<{owner:string;rows:Rows}|null>(null),[error,setError]=useState(""),[reload,setReload]=useState(0);
    const [origin,setOrigin]=useState<ReviewPoint["origin"]>("physical");
    useEffect(()=>{
        if(!owner)return;
        const c=new AbortController();setError("");setData(null);
        void modelRequest<{groups:Rows}>("/api/admin/tryout-bindings/wear-quality",owner,c.signal).then(r=>{if(!c.signal.aborted)setData({owner,rows:r.groups});}).catch(()=>{if(!c.signal.aborted)setError("暂时无法读取上身评测");});
        return ()=>c.abort();
    },[owner,reload]);
    if(!owner)return null;
    return <section aria-label="上身效果" className="wb-surface space-y-4 p-5">
        <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">上身效果 · 品类评测</h2><label>样本来源 <select value={origin} onChange={e=>setOrigin(e.target.value as ReviewPoint["origin"])}><option value="physical">实物照片</option><option value="synthetic">合成样品</option></select></label></header>
        <p>只展示随版本发布、完成三轮并经过人工抽查的结果。未测不等于低分；合成样品不计入实物通过率。当前做法与评测候选分别列出。</p>
        {error?<div role="alert">{error} <button onClick={()=>setReload(n=>n+1)}>重试</button></div>:data?.owner!==owner?<p role="status">正在读取…</p>:<div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><caption className="sr-only">按品类查看做法和最近评测</caption>
            <thead><tr>{["品类","当前做法","综合分 / 5","通过率","最近测试（UTC）","分数趋势","上身"].map(s=><th key={s} scope="col" className="p-2">{s}</th>)}</tr></thead>
            <tbody>{data.rows.map(row=>{
                const results=row.reviews.filter(r=>r.origin===origin),latest=results[0],prior=latest&&results.slice(1).find(r=>r.variant===latest.variant);
                const delta=prior&&latest?latest.score-prior.score:null;
                return <tr key={row.group} className="border-t align-top"><th scope="row" className="p-2">{row.group}</th>
                    <td className="p-2"><details><summary className="cursor-pointer">{row.framing.map(f=>framing[f]).join(" / ")} · {row.twoStep?"两步":"一步"}</summary><p className="max-w-56">原图 · {row.resolution.toUpperCase()}。{row.guard}</p>{latest&&<p>评测候选：{latest.variant}。共 {latest.sampleCount} 份回执，人工抽查 {latest.reviewed} 份。</p>}</details></td>
                    <td className="p-2">{latest?latest.score.toFixed(2):"未测"}</td><td className="p-2">{latest?Math.round(latest.passRate*100)+"%":"—"}</td>
                    <td className="p-2">{latest?latest.testedAt.slice(0,10):"—"}</td><td className="p-2">{delta===null?"—":(delta>0?"+":"")+delta.toFixed(2)}</td><td className="p-2">{row.enabled?"开放":"未开放"}</td></tr>;
            })}</tbody></table></div>}
    </section>;
}
