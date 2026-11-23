import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {fabricCrossings,validFabricBoundary,type FabricVertex} from "../../../../../shared/tryout-fabric-area";
import type {FabricDropPoint} from "../../../../../shared/tryout-submission";

export function FabricBoundaryDialog({url,point,name,onCancel,onConfirm}:{url:string;point:FabricDropPoint;name:string;onCancel:()=>void;onConfirm:(vertices:FabricVertex[])=>void}){
    const dialog=useRef<HTMLDialogElement>(null);
    const [vertices,setVertices]=useState<FabricVertex[]>([]);
    useEffect(()=>{const el=dialog.current!;el.showModal();return ()=>el.close();},[]);
    const valid=validFabricBoundary(vertices)&&fabricCrossings(vertices,point.yPct*10).filter(x=>x>point.xPct*10).length%2===1;
    return createPortal(<dialog ref={dialog} aria-labelledby="fabric-boundary-title" onCancel={e=>{e.preventDefault();onCancel();}} className="m-auto max-w-[94vw] rounded-lg border border-border bg-background p-4 text-foreground shadow-lg">
        <h2 id="fabric-boundary-title" className="font-semibold">圈选换料部位 · {name}</h2>
        <p className="my-2 text-sm">沿目标部位边缘依次点选，围住落点。只替换圈内材质，其余保留原图。</p>
        <div className="relative mx-auto w-fit">
            <img src={url} alt="换料产品原图" draggable={false} className="block max-h-[55vh] max-w-[min(78vw,760px)]" />
            <svg role="img" aria-label="换料部位轮廓" className="absolute inset-0 h-full w-full cursor-crosshair touch-none" viewBox="0 0 1000 1000" preserveAspectRatio="none" onClick={e=>{
                const b=e.currentTarget.getBoundingClientRect();
                const vertex={x:Math.round(1000*(e.clientX-b.left)/b.width),y:Math.round(1000*(e.clientY-b.top)/b.height)};
                setVertices(v=>v.length<64?[...v,vertex]:v);
            }}>
                <polygon points={vertices.map(p=>p.x+","+p.y).join(" ")} fill="Highlight" fillOpacity=".22" stroke="Highlight" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
                {vertices.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r="5" fill="Highlight" />)}
                <circle cx={point.xPct*10} cy={point.yPct*10} r="8" fill="Canvas" stroke="Highlight" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
            </svg>
        </div>
        <div className="mt-3 flex items-center justify-between gap-4 text-sm">
            <span aria-live="polite">{vertices.length<3?"至少点选 3 个边界点":valid?"范围已圈好":"请圈住落点，边缘不能交叉"}</span>
            <button type="button" disabled={!vertices.length} onClick={()=>setVertices(v=>v.slice(0,-1))}>撤销一点</button>
            <button type="button" onClick={onCancel}>取消</button>
            <button type="button" disabled={!valid} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={()=>onConfirm(vertices)}>确认局部换料</button>
        </div>
    </dialog>,document.body);
}
