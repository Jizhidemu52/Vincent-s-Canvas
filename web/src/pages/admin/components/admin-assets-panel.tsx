import { App, Button, Image, Select, Table, Tag } from "antd";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { listAdminServerAssets, type ServerAsset } from "@/services/api/server-assets";

export function AdminAssetsPanel() {
    const { message } = App.useApp(); const [assets,setAssets]=useState<ServerAsset[]>([]); const [owner,setOwner]=useState("all"); const [loading,setLoading]=useState(true);
    const refresh=async()=>{setLoading(true);try{setAssets((await listAdminServerAssets()).assets);}catch(error){message.error(error instanceof Error?error.message:"素材加载失败");}finally{setLoading(false);}};
    useEffect(()=>{void refresh();},[]);
    const rows=useMemo(()=>assets.filter((asset)=>owner==="all"||asset.ownerUserId===owner),[assets,owner]);
    const owners=Array.from(new Map(assets.map((asset)=>[asset.ownerUserId,asset.ownerName])).entries()).map(([value,label])=>({value,label}));
    return <div className="grid gap-3"><div className="flex items-center gap-2"><Select className="w-56" value={owner} onChange={setOwner} options={[{value:"all",label:"全部设计师"},...owners]}/><Button className="ml-auto" icon={<RefreshCw className="size-4"/>} onClick={refresh}>刷新</Button></div><Table rowKey="id" size="small" loading={loading} dataSource={rows} columns={[
        {title:"预览",render:(_,asset:ServerAsset)=>asset.kind==="image"?<Image width={52} height={52} className="object-cover" src={`/api/assets/${asset.id}/content`}/>:<Tag>{asset.kind}</Tag>},
        {title:"素材",render:(_,asset:ServerAsset)=>typeof asset.metadata.title==="string"?asset.metadata.title:asset.filename},{title:"设计师",dataIndex:"ownerName"},{title:"部门",dataIndex:"departmentName"},{title:"项目",render:(_,asset:ServerAsset)=>asset.projectName||String(asset.metadata.projectId||"未归档")},{title:"来源",dataIndex:"source"},{title:"操作",dataIndex:"operationType"},{title:"模型",dataIndex:"modelName"},{title:"大小",render:(_,asset:ServerAsset)=>`${(asset.byteSize/1024/1024).toFixed(2)} MB`},{title:"时间",dataIndex:"createdAt"},{title:"下载",render:(_,asset:ServerAsset)=><Button type="link" icon={<Download className="size-4"/>} href={`/api/assets/${asset.id}/content`} target="_blank">打开</Button>},
    ]}/></div>;
}
