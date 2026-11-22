import {useCallback,useEffect,useRef,useState} from "react";
import {useUserStore} from "@/stores/use-user-store";
import {createClientUuid} from "@/lib/client-uuid";
import {uploadServerAsset} from "@/services/api/server-assets";
import {modelRequest} from "@/services/api/tryout-models";

type Copy={name:string;description:string};
export function usePresetUpload(owner:string|undefined,kind:"fabric"|"portrait"){
    const [photo,show]=useState(""),[assetId,bind]=useState(""),[busy,lock]=useState(false),[message,tell]=useState("");
    const life=useRef<AbortController|null>(null),local=useRef("");
    const cancel=useCallback(()=>{life.current?.abort();life.current=null;if(local.current)URL.revokeObjectURL(local.current);local.current="";},[]);
    const reset=useCallback(()=>{cancel();show("");bind("");lock(false);tell("");},[cancel]);
    useEffect(()=>{reset();return cancel;},[owner,reset,cancel]);
    const upload=async(file:File,apply:(copy:Copy)=>void)=>{
        if(!owner||useUserStore.getState().user?.id!==owner)return;
        if(!["image/png","image/jpeg","image/webp"].includes(file.type)||!file.size||file.size>10*1024*1024){tell("请选择 10 MiB 以内的 PNG、JPG 或 WebP");return;}
        reset();const c=new AbortController();life.current=c;local.current=URL.createObjectURL(file);show(local.current);lock(true);tell("正在上传并识别图片…");
        try{
            const id=await uploadServerAsset(file,{source:kind==="fabric"?"material-preset-library":"company-model-library"},{expectedOwnerId:owner,signal:c.signal,clientReferenceId:"preset:"+createClientUuid()});
            c.signal.throwIfAborted();bind(id);
            const result=await modelRequest<Copy&{status:string}>("/api/admin/preset-analysis/"+kind+"/"+id,owner,c.signal,"POST",{});
            c.signal.throwIfAborted();
            if(result.status==="ready"){apply(result);tell("名称和描述已识别，可修改后发布。");}else tell("图片已上传，识别未完成。可手动填写并保存，不会自动重复识别。");
        }catch{if(!c.signal.aborted)tell("上传或识别未获确认，请核对。已上传的图片可手动填写后保存。");}
        finally{if(!c.signal.aborted)lock(false);}
    };
    return {photo,assetId,busy,message,reset,upload};
}
