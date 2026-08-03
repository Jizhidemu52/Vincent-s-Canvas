import { ImageIcon, LoaderCircle, RefreshCw, Video } from "lucide-react";

import { Button } from "antd";

import { canGenerateWorkflowVideo } from "@/lib/canvas/agent-media-workflow";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { CanvasAgentMediaWorkflow } from "@/types/canvas";

type CanvasAgentMediaWorkflowCardProps = {
    workflow: CanvasAgentMediaWorkflow;
    imageModels: string[];
    videoModels: string[];
    onImageModelChange?: (model: string) => void;
    onGenerateImages?: () => void;
    onSelectCandidate?: (nodeId: string) => void;
    onVideoModelChange?: (model: string) => void;
    onGenerateVideo?: () => void;
    onRetry?: (stage: "image" | "video") => void;
};

export function getCanvasAgentMediaWorkflowCardState(workflow: CanvasAgentMediaWorkflow, actions: { hasVideoAction: boolean }) {
    const videoEligible = canGenerateWorkflowVideo(workflow);
    const canGenerateVideo = videoEligible && actions.hasVideoAction && workflow.videoStatus !== "running";

    return {
        canGenerateVideo,
        videoDisabledMessage:
            !videoEligible && workflow.intent === "image_to_video"
                ? "请选择一张成功候选图"
                : !actions.hasVideoAction
                  ? "等待项目页面接入视频生成"
                  : workflow.videoStatus === "running"
                    ? "视频生成中"
                    : undefined,
    };
}

export function CanvasAgentMediaWorkflowCard({
    workflow,
    imageModels,
    videoModels,
    onImageModelChange,
    onGenerateImages,
    onSelectCandidate,
    onVideoModelChange,
    onGenerateVideo,
    onRetry,
}: CanvasAgentMediaWorkflowCardProps) {
    const cardState = getCanvasAgentMediaWorkflowCardState(workflow, { hasVideoAction: Boolean(onGenerateVideo) });
    const showImageStage = workflow.intent !== "video";
    const showVideoStage = workflow.intent !== "image";
    const successfulCandidates = workflow.candidates.filter((candidate) => candidate.status === "success");

    return (
        <section className="overflow-hidden rounded-xl border border-black/10 bg-black/[0.025] text-sm dark:border-white/10 dark:bg-white/[0.04]" aria-label="图片转视频工作流">
            {showImageStage ? (
                <div className="space-y-3 p-3">
                    <WorkflowStageTitle icon={<ImageIcon className="size-3.5" />} title="第一步：生成候选图" status={workflow.imageStatus} />
                    <ModelSelect ariaLabel="选择图片模型" emptyLabel="暂无图片模型" models={imageModels} value={workflow.imageModel} disabled={!onImageModelChange} onChange={onImageModelChange} />
                    <Button block type="primary" disabled={!onGenerateImages || workflow.imageStatus === "running" || !workflow.imageModel} icon={workflow.imageStatus === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />} onClick={onGenerateImages}>
                        {workflow.imageStatus === "running" ? "正在生成候选图" : "生成候选图"}
                    </Button>
                    {workflow.imageStatus === "failed" ? <WorkflowError error={workflow.error || "图片生成失败，请重试。"} onRetry={onRetry ? () => onRetry("image") : undefined} /> : null}
                    {successfulCandidates.length ? (
                        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="成功候选图">
                            {successfulCandidates.map((candidate) => {
                                const selected = candidate.nodeId === workflow.selectedCandidateNodeId;
                                return (
                                    <button
                                        key={candidate.nodeId}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        disabled={!onSelectCandidate}
                                        className={`group relative aspect-square overflow-hidden rounded-lg border text-left transition ${selected ? "border-primary ring-2 ring-primary/25" : "border-black/10 hover:border-primary/50 dark:border-white/15"} disabled:cursor-not-allowed disabled:opacity-60`}
                                        onClick={() => onSelectCandidate?.(candidate.nodeId)}
                                    >
                                        {candidate.url ? <img src={candidate.url} alt="成功候选图" className="size-full object-cover" /> : <span className="grid size-full place-items-center bg-black/5 px-2 text-center text-xs opacity-65 dark:bg-white/10">{candidate.nodeId}</span>}
                                        <span className={`absolute right-1 top-1 size-3 rounded-full border-2 border-white ${selected ? "bg-primary" : "bg-black/25 dark:bg-white/25"}`} />
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {showImageStage && showVideoStage ? <div className="border-t border-black/10 dark:border-white/10" /> : null}

            {showVideoStage ? (
                <div className="space-y-3 p-3">
                    <WorkflowStageTitle icon={<Video className="size-3.5" />} title={showImageStage ? "第二步：生成视频" : "生成视频"} status={workflow.videoStatus} />
                    <ModelSelect ariaLabel="选择视频模型" emptyLabel="暂无视频模型" models={videoModels} value={workflow.videoModel} disabled={!onVideoModelChange} onChange={onVideoModelChange} />
                    <Button block disabled={!cardState.canGenerateVideo || !workflow.videoModel} icon={workflow.videoStatus === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Video className="size-3.5" />} onClick={onGenerateVideo}>
                        {workflow.videoStatus === "running" ? "正在生成视频" : "生成视频"}
                    </Button>
                    {cardState.videoDisabledMessage ? <p className="text-xs opacity-65">{cardState.videoDisabledMessage}</p> : null}
                    {workflow.videoStatus === "failed" ? <WorkflowError error={workflow.error || "视频生成失败，请重试。"} onRetry={onRetry ? () => onRetry("video") : undefined} /> : null}
                </div>
            ) : null}
        </section>
    );
}

function ModelSelect({ ariaLabel, emptyLabel, models, value, disabled, onChange }: { ariaLabel: string; emptyLabel: string; models: string[]; value: string; disabled: boolean; onChange?: (model: string) => void }) {
    return (
        <Select value={value} disabled={disabled} onValueChange={onChange}>
            <SelectTrigger aria-label={ariaLabel} className="h-9 w-full text-sm">
                <span className="truncate">{value || ariaLabel}</span>
            </SelectTrigger>
            <SelectContent>
                {models.length ? models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>) : <SelectItem value="__empty_model__" disabled>{emptyLabel}</SelectItem>}
            </SelectContent>
        </Select>
    );
}

function WorkflowStageTitle({ icon, title, status }: { icon: React.ReactNode; title: string; status: CanvasAgentMediaWorkflow["imageStatus"] }) {
    return <div className="flex items-center gap-1.5 font-medium"><span className="opacity-70">{icon}</span><span>{title}</span>{status === "success" ? <span className="text-xs opacity-55">已完成</span> : null}</div>;
}

function WorkflowError({ error, onRetry }: { error: string; onRetry?: () => void }) {
    return <div className="flex items-center justify-between gap-2 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-300"><span>{error}</span>{onRetry ? <Button size="small" type="text" icon={<RefreshCw className="size-3" />} onClick={onRetry}>重试</Button> : null}</div>;
}
