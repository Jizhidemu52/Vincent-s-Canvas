import type {ImageTurn} from "../../../../shared/image-conversation-contracts";
import {defaultVideoMotionSettings} from "../../../../shared/video-motion-options";
import {normalizeVideoModelConfig,resolveVideoMode,videoModelRequestParameters} from "@/lib/video-model-parameters";
import {createVideoMotionInput} from "@/pages/video/video-motion";
import {useConfigStore} from "@/stores/use-config-store";
import {useUserStore} from "@/stores/use-user-store";
import {getBusinessConfig,estimateServerUsage} from "./business-config";
import {resolveConfiguredToolModel} from "./tool-runtime";

export type VideoProposal=NonNullable<ImageTurn["videoProposal"]>;
export type VideoEntry="canvas"|"standalone";
export async function prepareConversationVideo(owner:string,entry:VideoEntry,proposal:VideoProposal){
    const business=await getBusinessConfig();
    if(useUserStore.getState().user?.id!==owner)throw Error("账号已切换，未提交视频任务");
    const toolKey=entry==="canvas"?"canvas-video":"video",prefs=useConfigStore.getState().config;
    const enabled=business.models.filter(m=>m.capabilities.includes("video")&&!m.modelId.startsWith("demo-"));
    const preferred=enabled.find(m=>[m.id,m.modelId,m.name].includes(prefs.videoModel))??enabled[0];
    const model=resolveConfiguredToolModel(business,toolKey,preferred?.id??"");
    if(!model.capabilities.includes("video"))throw Error("该板块未配置可用的视频模型，未提交任务");
    const count=proposal.sourceAssetIds.length,parameterId=model.parameterModelId??model.modelId;
    const config={...prefs,model:parameterId,videoModel:parameterId,videoMode:"auto",videoSeconds:String(proposal.seconds??prefs.videoSeconds)};
    const mode=resolveVideoMode(config,count,0,0,undefined,parameterId);
    const params=videoModelRequestParameters(config,parameterId,mode);
    if(proposal.seconds&&params.seconds!==proposal.seconds)throw Error("当前视频模型不支持指定时长，未提交；请在对话中调整秒数。");
    const normalized={...config,...normalizeVideoModelConfig(config,parameterId,mode),videoMode:mode};
    const usage=estimateServerUsage(business,{operationType:"video_generation",modelId:model.id,toolKey});
    if(!usage.configured)throw Error("此视频模型未配置计费，未提交任务");
    const summary=[model.name,params.seconds?params.seconds+" 秒":null,count?count+" 张参考图":"文生视频",usage.credits?("预计 "+usage.credits+" 积分"):"可能产生费用"].filter(Boolean).join(" · ");
    const input={resolvedModel:model,modelId:model.id,toolKey,operationType:"video_generation",prompt:proposal.prompt,
        ...(entry==="standalone"?{promptInput:createVideoMotionInput(proposal.prompt,defaultVideoMotionSettings,normalized,{images:count,videos:0,audios:0})}:{}),
        sourceUrls:proposal.sourceAssetIds.map(id=>"/api/assets/"+id+"/content"),parameters:params};
    return {input,summary,identity:JSON.stringify([model.id,params,usage.credits,usage.rmbCost])};
}
