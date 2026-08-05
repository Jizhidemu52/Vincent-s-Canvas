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
    onImageCountChange?: (count: number) => void;
    onGenerateImages?: () => void;
    onSelectCandidate?: (nodeId: string) => void;
    onVideoModelChange?: (model: string) => void;
    onVideoSecondsChange?: (seconds: string) => void;
    onAspectRatioChange?: (ratio: string) => void;
    onGenerateVideo?: () => void;
    onRetry?: (stage: "image" | "video") => void;
    onOpenResult?: () => void;
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

type CanvasAgentMediaWorkflowCardContractActions = {
    imageModels: string[];
    videoModels: string[];
    hasImageModelChange?: boolean;
    hasImageAction: boolean;
    hasVideoModelChange?: boolean;
    hasVideoAction: boolean;
    hasCandidateAction: boolean;
    hasRetryAction: boolean;
    hasResultAction?: boolean;
};

export function getCanvasAgentMediaWorkflowCardContract(workflow: CanvasAgentMediaWorkflow, actions: CanvasAgentMediaWorkflowCardContractActions) {
    const imageModel = actions.imageModels.includes(workflow.imageModel) ? workflow.imageModel : undefined;
    const videoModel = actions.videoModels.includes(workflow.videoModel) ? workflow.videoModel : undefined;
    const videoState = getCanvasAgentMediaWorkflowCardState(workflow, { hasVideoAction: actions.hasVideoAction && Boolean(videoModel) });
    const canGenerateImages = workflow.intent !== "video" && Boolean(imageModel) && actions.hasImageAction && workflow.imageStatus !== "running";
    const canGenerateVideo = workflow.intent !== "image" && Boolean(videoModel) && videoState.canGenerateVideo;
    const candidates = workflow.candidates
        .filter((candidate) => candidate.status === "success")
        .map((candidate, index) => ({
            ...candidate,
            id: `${workflow.id}-candidate-${index + 1}`,
            name: `${workflow.id}-candidate`,
            label: `候选图 ${index + 1}`,
            checked: candidate.nodeId === workflow.selectedCandidateNodeId,
            disabled: !actions.hasCandidateAction,
        }));
    const selectedCandidate = candidates.find((candidate) => candidate.checked);

    return {
        imageModel,
        videoModel,
        selectedCandidateNodeId: workflow.selectedCandidateNodeId,
        imageCount: workflow.imageCount,
        videoSeconds: workflow.videoSeconds,
        aspectRatio: workflow.aspectRatio,
        selectedCandidateSummary: selectedCandidate ? `${selectedCandidate.label} · ${selectedCandidate.nodeId}` : "未选择候选图",
        videoResult: workflow.videoResult ? { ...workflow.videoResult, canOpen: Boolean(actions.hasResultAction) } : undefined,
        imageModelSelect: { value: imageModel, disabled: !actions.hasImageModelChange },
        videoModelSelect: { value: videoModel, disabled: !actions.hasVideoModelChange },
        imageGenerateButton: { disabled: !canGenerateImages },
        videoGenerateButton: { disabled: !canGenerateVideo },
        canGenerateImages,
        canGenerateVideo,
        videoDisabledMessage: videoModel ? videoState.videoDisabledMessage : "请选择视频模型",
        candidates,
        imageError: workflow.imageStatus === "failed" ? { message: workflow.error || "图片生成失败，请重试。", role: "alert" as const, canRetry: actions.hasRetryAction, retryVisible: actions.hasRetryAction } : undefined,
        videoError: workflow.videoStatus === "failed" ? { message: workflow.error || "视频生成失败，请重试。", role: "alert" as const, canRetry: actions.hasRetryAction, retryVisible: actions.hasRetryAction } : undefined,
    };
}

export function CanvasAgentMediaWorkflowCard({
    workflow,
    imageModels,
    videoModels,
    onImageModelChange,
    onImageCountChange,
    onGenerateImages,
    onSelectCandidate,
    onVideoModelChange,
    onVideoSecondsChange,
    onAspectRatioChange,
    onGenerateVideo,
    onRetry,
    onOpenResult,
}: CanvasAgentMediaWorkflowCardProps) {
    const card = getCanvasAgentMediaWorkflowCardContract(workflow, {
        imageModels,
        videoModels,
        hasImageModelChange: Boolean(onImageModelChange),
        hasImageAction: Boolean(onGenerateImages),
        hasVideoModelChange: Boolean(onVideoModelChange),
        hasVideoAction: Boolean(onGenerateVideo),
        hasCandidateAction: Boolean(onSelectCandidate),
        hasRetryAction: Boolean(onRetry),
        hasResultAction: Boolean(onOpenResult),
    });
    const showImageStage = workflow.intent !== "video";
    const showVideoStage = workflow.intent !== "image";

    return (
        <section className="overflow-hidden rounded-xl border border-black/10 bg-black/[0.025] text-sm dark:border-white/10 dark:bg-white/[0.04]" aria-label="图片转视频工作流">
            {showImageStage ? (
                <div className="space-y-3 p-3">
                    <WorkflowStageTitle icon={<ImageIcon className="size-3.5" />} title="第一步：生成候选图" status={workflow.imageStatus} />
                    <ModelSelect ariaLabel="选择图片模型" emptyLabel="暂无图片模型" models={imageModels} value={card.imageModelSelect.value} disabled={card.imageModelSelect.disabled} onChange={onImageModelChange} />
                    <label className="flex items-center justify-between gap-3 text-xs"><span className="opacity-65">图片数量</span><input aria-label="图片数量" type="number" min={1} max={15} value={card.imageCount} disabled={!onImageCountChange} onChange={(event) => onImageCountChange?.(Number(event.target.value))} className="h-8 w-20 rounded-md border border-black/10 bg-transparent px-2 dark:border-white/15" /></label>
                    <Button block type="primary" disabled={card.imageGenerateButton.disabled} icon={workflow.imageStatus === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />} onClick={onGenerateImages}>
                        {workflow.imageStatus === "running" ? "正在生成候选图" : "生成候选图"}
                    </Button>
                    {card.imageError ? <WorkflowError error={card.imageError.message} role={card.imageError.role} onRetry={card.imageError.retryVisible ? () => onRetry?.("image") : undefined} /> : null}
                    {card.candidates.length ? (
                        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="成功候选图">
                            {card.candidates.map((candidate) => {
                                return (
                                    <label
                                        key={candidate.nodeId}
                                        htmlFor={candidate.id}
                                        className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg border text-left transition focus-within:ring-2 focus-within:ring-primary/25 ${candidate.checked ? "border-primary ring-2 ring-primary/25" : "border-black/10 hover:border-primary/50 dark:border-white/15"} ${candidate.disabled ? "cursor-not-allowed opacity-60" : ""}`}
                                    >
                                        <input id={candidate.id} className="sr-only" type="radio" name={candidate.name} checked={candidate.checked} disabled={candidate.disabled} onChange={() => onSelectCandidate?.(candidate.nodeId)} />
                                        {candidate.url ? <img src={candidate.url} alt="" className="size-full object-cover" /> : <span aria-hidden className="grid size-full place-items-center bg-black/5 px-2 text-center text-xs opacity-65 dark:bg-white/10">{candidate.label}</span>}
                                        <span className="sr-only">{candidate.label}</span>
                                        <span className={`absolute right-1 top-1 size-3 rounded-full border-2 border-white ${candidate.checked ? "bg-primary" : "bg-black/25 dark:bg-white/25"}`} />
                                    </label>
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
                    <ModelSelect ariaLabel="选择视频模型" emptyLabel="暂无视频模型" models={videoModels} value={card.videoModelSelect.value} disabled={card.videoModelSelect.disabled} onChange={onVideoModelChange} />
                    <div className="grid grid-cols-2 gap-2">
                        <WorkflowValueSelect ariaLabel="视频时长" value={card.videoSeconds} values={["3", "5", "6", "8", "10", "15"]} suffix=" 秒" disabled={!onVideoSecondsChange} onChange={onVideoSecondsChange} />
                        <WorkflowValueSelect ariaLabel="画面比例" value={card.aspectRatio} values={["1:1", "16:9", "9:16", "4:3", "3:4"]} disabled={!onAspectRatioChange} onChange={onAspectRatioChange} />
                    </div>
                    <p className="text-xs opacity-65">已选图片：{card.selectedCandidateSummary}</p>
                    <Button block disabled={card.videoGenerateButton.disabled} icon={workflow.videoStatus === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Video className="size-3.5" />} onClick={onGenerateVideo}>
                        {workflow.videoStatus === "running" ? "正在生成视频" : "生成视频"}
                    </Button>
                    {card.videoDisabledMessage ? <p className="text-xs opacity-65">{card.videoDisabledMessage}</p> : null}
                    {card.videoError ? <WorkflowError error={card.videoError.message} role={card.videoError.role} onRetry={card.videoError.retryVisible ? () => onRetry?.("video") : undefined} /> : null}
                    {card.videoResult ? <Button block type="link" disabled={!card.videoResult.canOpen} onClick={onOpenResult}>在画布中查看视频结果</Button> : null}
                </div>
            ) : null}
        </section>
    );
}

function WorkflowValueSelect({ ariaLabel, value, values, suffix = "", disabled, onChange }: { ariaLabel: string; value: string; values: string[]; suffix?: string; disabled: boolean; onChange?: (value: string) => void }) {
    return <label className="space-y-1 text-xs"><span className="opacity-65">{ariaLabel}</span><select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange?.(event.target.value)} className="h-8 w-full rounded-md border border-black/10 bg-transparent px-2 dark:border-white/15">{values.map((item) => <option key={item} value={item}>{item}{suffix}</option>)}</select></label>;
}

function ModelSelect({ ariaLabel, emptyLabel, models, value, disabled, onChange }: { ariaLabel: string; emptyLabel: string; models: string[]; value?: string; disabled: boolean; onChange?: (model: string) => void }) {
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

function WorkflowError({ error, role, onRetry }: { error: string; role: "alert"; onRetry?: () => void }) {
    return <div role={role} className="flex items-center justify-between gap-2 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-300"><span>{error}</span>{onRetry ? <Button size="small" type="text" icon={<RefreshCw className="size-3" />} onClick={onRetry}>重试</Button> : null}</div>;
}
