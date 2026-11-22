import {useId} from "react";
import {sampleIds} from "./tryout-material-kit";
const patterns=[
    [12,12,<path d="M0 2L6 10L12 2" stroke="rgba(0,0,0,.22)" strokeWidth="2" fill="none"/>],
    [6,6,<rect width="2" height="6" fill="rgba(0,0,0,.20)"/>],
    [16,20,<path d="M4 0q8 5 0 10q-8 5 0 10M12 0q-8 5 0 10q8 5 0 10" stroke="rgba(0,0,0,.24)" strokeWidth="1.8" fill="none"/>],
    [10,10,<path d="M1 3l3-2M6 2l3 2M2 8l2-3M7 9l2-3" stroke="rgba(255,255,255,.55)" strokeWidth="1"/>],
    [8,8,<><circle cx="2" cy="2" r="1.5" fill="rgba(255,255,255,.35)"/><circle cx="6" cy="6" r="1.5" fill="rgba(0,0,0,.14)"/></>],
    [10,10,<><rect width="5" height="10" fill="rgba(0,0,0,.16)"/><rect x="5" width="1" height="10" fill="rgba(255,255,255,.28)"/></>],
] as const;
export function FabricSample({presetId,photo}:{presetId?:string;photo?:string}){
    const id=useId(),p=patterns[sampleIds.indexOf(presetId??"")];
    if(photo)return <img alt="" draggable={false} className="block size-full object-cover" src={photo}/>;
    if(!p)return <small>暂无示意图</small>;
    return <svg aria-hidden="true" viewBox="0 0 40 40" width="100%" height="100%" preserveAspectRatio="none"><defs><pattern id={id} width={p[0]} height={p[1]} patternUnits="userSpaceOnUse"><rect width={p[0]} height={p[1]} fill="#C9B79C"/>{p[2]}</pattern></defs><rect width="40" height="40" fill={"url(#"+id+")"}/></svg>;
}
