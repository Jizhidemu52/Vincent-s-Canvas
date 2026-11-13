import { uiText, useUiText, getUiLocale } from "@/lib/i18n";
import { displayNotice, DisplayText, DisplayTranslationPreview, useDisplayText  } from "@/hooks/use-display-text";
import { GenerationAccountHistory } from "@/components/generation-account-history";
import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Music2, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { handleSubmitShortcut } from "@/lib/submit-shortcut";
import { useGenerationDraft } from "@/hooks/use-generation-draft";
import { isOrdinaryPromptUrl, usePromptUrlHandoff } from "@/hooks/use-prompt-url-handoff";
import { useImageDrop } from "@/hooks/use-image-drop";
import { acquireVideoPlayback, videoPlaybackOwner, type VideoPlaybackView } from "@/hooks/use-video-playback";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { generationDownloadName, generationErrorMessage, generationErrorDiagnostic, shouldConfirmPromptReuse } from "@/lib/generation-feedback";
import { GenerationDiagnostic } from "@/components/generation-diagnostic";
import { useResultCanvas } from "@/hooks/use-result-canvas";
import { GenerationTaskCancel } from "@/components/generation-task-cancel";
import { WorkbenchImage } from "@/components/workbench-image";
import { snapshotVideoRequest, type VideoRequestSnapshot } from "./video-retry";
import { VideoMotionPanel } from "./video-motion-panel";
import { createVideoMotionInput, motionVideoConfig, videoMotionSummary } from "./video-motion";
import { defaultVideoMotionSettings, normalizeVideoMotionSettings, type VideoMotionSettings } from "../../../../shared/video-motion-options";
import type { PromptInputData } from "../../../../shared/prompt-contracts";
import { PracticeExampleRecord } from "@/components/design-examples";
import { useGenerationWorkspace } from "@/hooks/use-generation-workspace";
import { WorkbenchTasks, useWorkbenchTask, useWorkbenchTaskStatus } from "@/components/workbench-tasks";
import { DEFAULT_WORKBENCH_TASK, matchesWorkbenchTask } from "@/lib/workbench-task-state";
import { GenerationElapsed } from "@/components/generation-elapsed";
import { GenerationQueueProgress } from "@/components/generation-queue-progress";
import { upsertGenerationLog } from "@/lib/generation-log-update";
import { pastedImageFiles, readClipboardImages } from "@/lib/clipboard-images";
import { workbenchSubmissions } from "@/lib/submission-gate";
import { App, Button, Checkbox, Drawer, Empty, Input, Modal, Tag, Tooltip, Typography } from "antd";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useLocation, useSearchParams } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { useToolConfig } from "@/hooks/use-tool-config";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, videoResolutionLabel, videoSizeLabel, videoSecondsLabel } from "@/components/video-settings-panel";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { type HappyHorseMode } from "@/lib/happyhorse-video";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, resolveVideoMode, videoReferenceError, withVideoDurationDefault } from "@/lib/video-model-parameters";
import { readReferenceMediaFile } from "@/lib/video-reference-files";
import { createLatestVideoPreview, hydrateVideoLogMedia } from "./video-log-media";
import { completedVideoTaskDurationMs } from "./video-task-duration";
import { deleteStoredMedia, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { getQueuedTask, getQueuedTaskByRequestId, QueuedTaskFailedError, QueuedTaskPausedError, QueuedTaskSubmissionUncertainError, recoverQueuedTask, waitForTasks } from "@/services/api/generation-tasks";
import { resolveConfiguredToolModel } from "@/services/api/tool-runtime";
import type { PublicModel } from "@/services/api/business-config";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { hydratePromptReuse } from "@/services/api/prompts";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { videoFileExtension } from "../../../../shared/video-output";
import "../image/image-workbench.css";
import "./video-workbench.css";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number | null;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    serverAssetId?: string;
    localAssetId?: string;
    playbackSourceError?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "paused";
    video?: GeneratedVideo;
    error?: string;
    diagnostic?: string;
    recovery?: { logId: string; task?: VideoGenerationTask; canRecover: boolean };
    createdAt?: number;
    taskId?: string;
};

type GenerationLog = {
    id: string;
    workspaceId?: string;
    createdAt: number;
    title: string;
    prompt: string;
    promptInput?: PromptInputData;
    effectivePrompt?: string;
    summaryZh?: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    happyHorseMode?: HappyHorseMode;
    durationMs: number | null;
    size: string;
    resolution: string;
    seconds: string;
    status: "生成中" | "成功" | "失败" | "查询暂停";
    task?: VideoGenerationTask;
    requestId?: string;
    video?: GeneratedVideo;
    error?: string;
    canRecover?: boolean;
    diagnostic?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoMode" | "videoGenerateAudio" | "videoWatermark" | "videoSeed" | "videoOutputFormat">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

export function videoModelSummaryLabel(config: AiConfig, model: string, models: readonly Pick<PublicModel, "id" | "modelId" | "name">[]) {
    const selected = models.find(item => item.id === model || item.modelId === modelOptionName(model));
    return selected?.name || modelOptionLabel(config, model);
}

export default function VideoPage() {
    useUiText();
    const ownerId = useUserStore(state => state.user?.id);
    const [searchParams] = useSearchParams();
    const { key: navigationKey } = useLocation();
    return <WorkbenchTasks key={ownerId || "local"} ownerId={ownerId} boardKey="video" urlInputKey={isOrdinaryPromptUrl(searchParams) ? navigationKey : undefined}><VideoGenerationWorkspace /></WorkbenchTasks>;
}

/** Editing a draft revokes only pending history-to-draft writes, not its running task or preview. */
function useVideoDraft<T>(key: string, initial: T, revision: { current: number }, hydrate?: (value: T) => Promise<T>) {
    const [value, save, ready] = useGenerationDraft(key, initial, hydrate);
    const update = useCallback<Dispatch<SetStateAction<T>>>(next => {
        revision.current += 1;
        save(next);
    }, [revision, save]);
    return [value, update, ready] as const;
}

function VideoGenerationWorkspace() {
    useUiText();
    const display = useDisplayText();
    const workbenchTask = useWorkbenchTask();
    const { id: workspaceId, active: workspaceActive, draftScope } = workbenchTask;
    const [logStore] = useState(() => createWorkspaceStorage("video_generation_logs"));
    const { message, modal } = App.useApp();
    const resultCanvas = useResultCanvas();
    const [searchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const observationControllers = useRef(new Map<string, AbortController>());
    const mountedRef = useRef(false);
    const loadedReuseTokenRef = useRef(new Set<string>());
    const generateRef = useRef<() => Promise<void>>(async () => undefined);
    const restoredInitialResultRef = useRef(false);
    const previewLoader = useRef(createLatestVideoPreview()).current;
    const playbackSessions = useRef(new Map<string, { video: GeneratedVideo; owner: string | null; controller: AbortController; release?: () => void }>()).current;
    const playbackOwner = useUserStore(videoPlaybackOwner);
    const logRefreshRevisionRef = useRef(0);
    const logReadIdRef = useRef(0);
    const resultViewScopeRef = useRef(0);
    const draftEditRevisionRef = useRef(0);
    const visibleResultLogIdsRef = useRef(new Set<string>());
    const baseConfig = useEffectiveConfig();
    const [draftConfig, setDraftConfig, configReady] = useVideoDraft<Partial<AiConfig>>(draftScope("video:settings"), {}, draftEditRevisionRef);
    const config = { ...baseConfig, ...draftConfig };
    const effectiveConfig = useToolConfig({ ...config, model: config.videoModel || config.model }, "video");
    const updateConfig: UpdateAiConfig = useCallback((key, value) => setDraftConfig(current => current[key] === value ? current : { ...current, [key]: value }), [setDraftConfig]);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
    const addAsset = useAssetStore((state) => state.addAsset);
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const configuredModels = useBusinessConfigStore((state) => state.models);
    const configuredTools = useBusinessConfigStore((state) => state.tools);
    const configStatus = useBusinessConfigStore((state) => state.status);
    const user = useUserStore((state) => state.user);
    const [prompt, setPrompt, promptReady] = useVideoDraft(draftScope("video:prompt"), "", draftEditRevisionRef);
    const [motion, setMotion, motionReady] = useVideoDraft<VideoMotionSettings>(draftScope("video:motion"), defaultVideoMotionSettings, draftEditRevisionRef, async value => normalizeVideoMotionSettings(value));
    const [rawPrompt, setRawPrompt, rawReady] = useVideoDraft(draftScope("video:raw-prompt"), false, draftEditRevisionRef);
    const [references, setReferences, referencesReady] = useVideoDraft<ReferenceImage[]>(draftScope("video:references"), [], draftEditRevisionRef, async items => Promise.all(items.map(async item => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) }))));
    const {
        logs, setLogs, running, setRunning, startedAt, setStartedAt, activeTaskId, setActiveTaskId,
        previewLoading, setPreviewLoading, logsOpen, setLogsOpen, settingsOpen, setSettingsOpen,
        promptDialogOpen, setPromptDialogOpen, assetPickerOpen, setAssetPickerOpen,
        selectedLogIds, setSelectedLogIds, previewLog, setPreviewLog, deleteConfirmOpen, setDeleteConfirmOpen,
        deletingLogs, deleteSelectedHistory,
    } = useGenerationWorkspace<ReferenceImage, GenerationLog>();
    const [videoReferences, setVideoReferences, videosReady] = useVideoDraft<ReferenceVideo[]>(draftScope("video:videos"), [], draftEditRevisionRef, async items => Promise.all(items.map(async item => ({ ...item, url: await resolveMediaUrl(item.storageKey, item.url) }))));
    const [audioReferences, setAudioReferences, audiosReady] = useVideoDraft<ReferenceAudio[]>(draftScope("video:audios"), [], draftEditRevisionRef, async items => Promise.all(items.map(async item => ({ ...item, url: await resolveMediaUrl(item.storageKey, item.url) }))));
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [historyResults, setHistoryResults] = useState<GenerationResult[]>([]);
    const [resultView, setResultView] = useState<"current" | "history">("current");
    const previewLogRef = useRef(previewLog);
    previewLogRef.current = previewLog;
    const displayedResults = resultView === "history" ? historyResults : results;
    const [playbacks, setPlaybacks] = useState<Record<string, VideoPlaybackView>>({});
    const [previewError, setPreviewError] = useState("");
    const [readingReferences, setReadingReferences] = useState(false);
    const [referenceScope, setReferenceScope] = useState(0);
    const referenceScopeRef = useRef(referenceScope);
    referenceScopeRef.current = referenceScope;
    const isCurrentReferenceScope = (scope: number) => mountedRef.current && referenceScopeRef.current === scope;
    const resetReferenceScope = () => {
        referenceScopeRef.current += 1;
        setReferenceScope(referenceScopeRef.current);
        setReadingReferences(false);
    };
    const [referenceError, setReferenceError] = useState("");
    const [referencesOpen, setReferencesOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [logsReady, setLogsReady] = useState(false);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logsError, setLogsError] = useState("");
    const draftReady = configReady && promptReady && referencesReady && videosReady && audiosReady && motionReady && rawReady;
    usePromptUrlHandoff({ ready: draftReady, prompt, applyPrompt: setPrompt, applyModel: value => updateConfig("videoModel", value) });
    useWorkbenchTaskStatus({ busy: submitting || running || readingReferences, pending: logs.some(log => log.status === "生成中" || log.status === "查询暂停"), ready: draftReady && logsReady, label: results.some(result => result.status === "success") ? "已完成" : results.some(result => result.status === "failed") ? "已失败" : "草稿" });
    useUnsavedGuard(readingReferences, uiText("参考素材正在读取，离开可能中断上传。"));
    const reusePrompt = (next: string, apply = () => setPrompt(next)) => {
        if (!shouldConfirmPromptReuse(prompt, next)) { apply(); return; }
        modal.confirm({ title: uiText("替换当前草稿？"), content: uiText("当前提示词已有内容，复用将替换现有输入；浏览结果不会更改草稿。"), okText: uiText("确认替换"), cancelText: uiText("保留草稿"), onOk: apply });
    };

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const allowRawPrompt = configuredTools.find(tool => tool.toolKey === "video")?.allowRawPrompt === true;
    const planning = !(allowRawPrompt && rawPrompt);
    const videoConfig = motionVideoConfig(buildVideoConfig(withVideoDurationDefault(effectiveConfig, draftConfig.videoSeconds), model), motion, { images: references.length, videos: videoReferences.length, audios: audioReferences.length }, planning);
    const modelSpec = getVideoModelParameterSpec(model);
    const selectedMode = effectiveConfig.videoMode;
    const maxImageReferences = modelSpec?.nativeAudio ? modelSpec.maxImages : selectedMode === "first-frame" || selectedMode === "last-frame" ? 1 : selectedMode === "first-last-frame" ? 2 : modelSpec?.maxImages || 0;
    const optionalReferenceCount = references.length + videoReferences.length + audioReferences.length;
    const validationError = videoReferenceError(videoConfig, references, videoReferences, audioReferences);
    const currentMode = resolveVideoMode(videoConfig, references.length, videoReferences.length, audioReferences.length);
    useEffect(() => { if (optionalReferenceCount) setReferencesOpen(true); }, [optionalReferenceCount]);
    const estimatedUsage = estimate({ operationType: "video_generation", toolKey: "video", modelId: modelOptionName(model), quantity: 1 });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimatedUsage.configured && user.creditBalance < estimatedUsage.credits);
    let modelReady = false;
    try { modelReady = configStatus === "ready" && resolveConfiguredToolModel({ models: configuredModels, tools: configuredTools, prices: [] }, "video", model).capabilities.includes("video"); } catch { /* Keep the saved selection visible; never switch provider silently. */ }
    const canGenerate = draftReady && logsReady && (planning || Boolean(prompt.trim())) && modelReady && !quotaBlocked && !validationError && Boolean(user && user.status === "active");

    const handleMissingModelConfig = () => {
        if (canManageConfig) {
            message.warning(uiText("请先完成配置"));
            openConfigDialog(true);
            return;
        }
        message.warning(uiText("当前没有可用模型，请联系管理员统一配置模型和 API"));
    };

    useEffect(() => {
        mountedRef.current = true;
        void refreshLogs(true);
        return () => {
            mountedRef.current = false;
            for (const controller of observationControllers.current.values()) controller.abort();
            logRefreshRevisionRef.current += 1;
            previewLoader.invalidate();
            for (const session of playbackSessions.values()) {
                session.controller.abort();
                session.release?.();
            }
            playbackSessions.clear();
        };
    }, []);

    useEffect(() => {
        const videos = displayedResults.flatMap(result => result.status === "success" && result.video ? [result.video] : []);
        const currentVideos = new Map(videos.map(video => [video.id, video]));
        for (const [id, session] of playbackSessions) {
            if (currentVideos.get(id) === session.video && session.owner === playbackOwner) continue;
            session.controller.abort();
            session.release?.();
            playbackSessions.delete(id);
        }
        setPlaybacks(current => Object.fromEntries(Object.entries(current).filter(([id]) => currentVideos.has(id))));
        for (const video of videos) {
            if (playbackSessions.has(video.id)) continue;
            const session = { video, owner: playbackOwner, controller: new AbortController(), release: undefined as (() => void) | undefined };
            playbackSessions.set(video.id, session);
            if (!video.serverAssetId) {
                setPlaybacks(current => ({ ...current, [video.id]: { status: "local", error: video.playbackSourceError } }));
                continue;
            }
            setPlaybacks(current => ({ ...current, [video.id]: { status: "preparing" } }));
            void acquireVideoPlayback(video.serverAssetId, session.controller.signal).then(preview => {
                if (session.controller.signal.aborted || playbackSessions.get(video.id) !== session) { preview.release(); return; }
                session.release = preview.release;
                setPlaybacks(current => ({ ...current, [video.id]: { status: "ready", playbackUrl: preview.playbackUrl, width: preview.width, height: preview.height, durationMs: preview.durationMs } }));
            }).catch(error => {
                if (session.controller.signal.aborted || playbackSessions.get(video.id) !== session) return;
                setPlaybacks(current => ({ ...current, [video.id]: { status: "error", error: error instanceof Error ? error.message : "兼容预览暂不可用；原任务已成功，可下载原件。" } }));
            });
        }
    }, [displayedResults, playbackSessions, playbackOwner]);

    useEffect(() => {
        if (restoredInitialResultRef.current || running || !logs.length || results.length) return;
        restoredInitialResultRef.current = true;
        const latest = logs.find((log) => log.status === "成功" && log.video);
        if (!latest?.video) return;
        setPreviewLoading(true);
        void previewLoader.load(
            (signal) => hydrateVideoLogMedia(latest, { image: resolveImageUrl, media: resolveMediaUrl, task: getQueuedTask }, false, signal),
            (resolved) => { setPreviewLoading(false); if (resolved.video) setResults([{ id: resolved.id, status: "success", video: resolved.video }]); },
            () => { setPreviewLoading(false); setPreviewError(uiText("最近视频暂时无法读取，可以从生成记录重新选择。")); },
        );
    }, [logs, message, previewLoader, results.length, running]);

    useEffect(() => {
        if (workspaceId !== DEFAULT_WORKBENCH_TASK || isOrdinaryPromptUrl(searchParams)) return;
        const presetPrompt = searchParams.get("prompt");
        const presetModel = searchParams.get("model");
        if (presetPrompt) setPrompt(presetPrompt);
        if (presetModel) updateConfig("videoModel", presetModel);
    }, [searchParams, updateConfig, workspaceId]);

    useEffect(() => {
        if (workspaceId !== DEFAULT_WORKBENCH_TASK) return;
        const token = searchParams.get("reuseToken");
        if (!token || loadedReuseTokenRef.current.has(token)) return;
        loadedReuseTokenRef.current.add(token);
        const scope = referenceScopeRef.current;
        let active = true;
        let restored = false;
        const stillCurrent = () => active && isCurrentReferenceScope(scope);
        void hydratePromptReuse(token).then(async (payload) => {
            if (!stillCurrent()) return;
            const nextReferences = await Promise.all(payload.template.referenceAssetIds.map(async (assetId) => {
                const blob = await fetchServerAssetContent(assetId);
                if (!stillCurrent()) return null;
                const image = await uploadImage(blob);
                return { id: nanoid(), name: "模板参考图.png", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, sourceAssetId: assetId };
            }));
            if (!stillCurrent()) return;
            restored = true;
            setPrompt(payload.template.prompt);
            const parameters = payload.template.parameters;
            if (payload.pricing.selectedModel?.modelId) updateConfig("videoModel", payload.pricing.selectedModel.modelId);
            if (typeof parameters.size === "string") updateConfig("size", parameters.size);
            if (typeof parameters.resolution === "string") updateConfig("vquality", parameters.resolution);
            if (typeof parameters.seconds === "string") updateConfig("videoSeconds", parameters.seconds);
            const seed = parameters.videoSeed ?? parameters.seed;
            if (typeof seed === "string" || typeof seed === "number") updateConfig("videoSeed", String(seed));
            const format = parameters.videoOutputFormat ?? parameters.outputFormat ?? parameters.output_format;
            if (format === "mp4" || format === "mov") updateConfig("videoOutputFormat", format);
            setReferences(nextReferences.filter((item): item is NonNullable<typeof item> => item !== null));
            payload.warnings.forEach((warning) => message.warning(displayNotice(uiText(warning))));
            if (payload.pricing.modelChanged) message.warning(displayNotice(payload.pricing.selectedModel ? uiText("模型已变更，当前使用 {name}", { name: payload.pricing.selectedModel.name }) : uiText("模型已变更，请先选择管理员当前启用的视频模型")));
            if (payload.mode === "fill_and_generate") {
                modal.confirm({ title: uiText("确认使用当前配置生成视频？"), content: uiText("确认后将直接提交视频生成任务。"), okText: uiText("确认生成"), cancelText: uiText("仅保留填入"), onOk: () => generateRef.current() });
            } else message.success(uiText("模板已填入"));
        }).catch((error) => {
            loadedReuseTokenRef.current.delete(token);
            if (stillCurrent()) message.error(displayNotice(error instanceof Error ? uiText(error.message) : uiText("模板复用失败")));
        });
        return () => { active = false; if (!restored) loadedReuseTokenRef.current.delete(token); };
    }, [message, modal, searchParams, updateConfig]);

    const addReferences = async (files?: FileList | File[] | null) => {
        const scope = referenceScopeRef.current;
        const selectedFiles = Array.from(files || []);
        if (selectedFiles.some((file) => !isSupportedVideoImage(file))) throw new Error("图片入口支持 JPEG、PNG、WebP，单张非空且不超过 10MB。");
        if (references.length + selectedFiles.length > maxImageReferences) throw new Error(`当前模型或模式最多使用 ${maxImageReferences} 张图片，请先移除多余参考图。`);
        const nextReferences = await Promise.all(
            selectedFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, width: image.width, height: image.height };
            }),
        );
        if (!isCurrentReferenceScope(scope)) return;
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addMediaReferences = async (files: FileList | null, kind: "video" | "audio") => {
        const selected = Array.from(files || []);
        if (!selected.length) return;
        draftEditRevisionRef.current += 1;
        const scope = referenceScopeRef.current;
        setReadingReferences(true);
        setReferenceError("");
        try {
            const shallow = selected.map((file) => ({ id: file.name, name: file.name, type: file.type, bytes: file.size, url: "" }));
            const preliminary = videoReferenceError(videoConfig, references, kind === "video" ? [...videoReferences, ...shallow] : videoReferences, kind === "audio" ? [...audioReferences, ...shallow] : audioReferences, undefined, true);
            if (preliminary) throw new Error(preliminary);
            const prepared = await Promise.all(selected.map(readReferenceMediaFile));
            if (!isCurrentReferenceScope(scope)) return;
            const error = videoReferenceError(videoConfig, references, kind === "video" ? [...videoReferences, ...prepared] : videoReferences, kind === "audio" ? [...audioReferences, ...prepared] : audioReferences, undefined, true);
            if (error) throw new Error(error);
            const stored = await Promise.all(prepared.map(async (item, index) => ({ ...item, ...await uploadMediaFile(selected[index], kind) })));
            if (!isCurrentReferenceScope(scope)) return;
            if (kind === "video") setVideoReferences((current) => [...current, ...stored]);
            else setAudioReferences((current) => [...current, ...stored]);
        } catch (error) {
            if (isCurrentReferenceScope(scope)) setReferenceError(error instanceof Error ? error.message : "读取参考素材失败");
        } finally { if (isCurrentReferenceScope(scope)) setReadingReferences(false); }
    };

    const addReferencesFromClipboard = async () => {
        if (readingReferences) return;
        draftEditRevisionRef.current += 1;
        const scope = referenceScopeRef.current;
        setReadingReferences(true);
        try {
            const blobs = await readClipboardImages(navigator.clipboard);
            if (references.length + blobs.length > maxImageReferences) throw new Error(`当前模型最多使用 ${maxImageReferences} 张图片，请先移除多余参考图。`);
            if (blobs.some((blob) => !isSupportedVideoImage(blob))) throw new Error("参考图仅支持 JPEG、PNG、WebP，单张非空且不超过 10MB。");
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            if (!isCurrentReferenceScope(scope)) return;
            setReferences((value) => [...value, ...nextReferences]);
            message.success(displayNotice(uiText("已读取 {length} 张参考图", { length: nextReferences.length })));
        } catch (error) {
            if (isCurrentReferenceScope(scope)) message.error(displayNotice(error instanceof Error ? uiText(error.message) : uiText("剪切板里没有可读取的图片")));
        } finally { if (isCurrentReferenceScope(scope)) setReadingReferences(false); }
    };
    const generate = async (original?: VideoRequestSnapshot) => {
        if (!mountedRef.current || !draftReady || !logsReady) return;
        previewLoader.invalidate();
        setPreviewLoading(false);
        setPreviewError("");
        const snapshot = original ? snapshotVideoRequest(original) : buildRequestSnapshot();
        if (!snapshot) return;
        if (original) {
            try { resolveConfiguredToolModel({ models: configuredModels, tools: configuredTools, prices: [] }, "video", original.config.videoModel || original.config.model); }
            catch { message.warning(uiText("原模型已不可用，请联系管理员；未更换模型或提交新任务。")); return; }
            if (!user || user.status !== "active") { message.error(uiText("当前设计师账号不可用")); return; }
        }
        const release = workbenchSubmissions.acquire(`video:${user?.id}:${workspaceId}`);
        if (!release) { message.info(uiText("视频正在提交，请勿重复点击")); return; }
        setSubmitting(true);
        setResultView("current");
        let log = { ...buildLog({ prompt: snapshot.text, model: snapshot.config.model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: null, status: "生成中" }), workspaceId, promptInput: snapshot.promptInput };
        visibleResultLogIdsRef.current.add(log.id);
        setResults(current => [...current, { id: log.id, status: "pending", createdAt: log.createdAt }]);
        try {
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, snapshot.videoReferences, snapshot.audioReferences, {
                promptInput: snapshot.promptInput,
                onSubmissionStarted: async (requestId) => {
                    log = { ...log, requestId };
                    // Persist the lookup key before the paid POST, including a page refresh mid-request.
                    await logStore.setItem(log.id, serializeLog(log));
                    logRefreshRevisionRef.current += 1;
                    setLogs(current => upsertGenerationLog(current, log));
                },
            });
            log = { ...log, task, requestId: task.requestId || log.requestId, effectivePrompt: task.prompt, summaryZh: task.summaryZh };
            await saveLog(log);
            void pollGenerationLog(log, false, false);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            const uncertain = error instanceof QueuedTaskSubmissionUncertainError;
            const diagnostic = generationErrorDiagnostic(error, { requestId: log.requestId, taskId: log.task?.id });
            setResults(current => current.map(item => item.id === log.id ? { id: log.id, status: uncertain ? "paused" : "failed", error: errorMessage, diagnostic, ...(uncertain ? { recovery: { logId: log.id, canRecover: true } } : {}) } : item));
            await saveLog({ ...log, status: uncertain ? "查询暂停" : "失败", error: errorMessage, diagnostic, durationMs: null, canRecover: uncertain ? true : undefined });
            message.error(displayNotice(uiText(errorMessage)));
        } finally {
            release();
            setSubmitting(false);
        }
    };
    generateRef.current = generate;

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text && !planning) {
            message.error(uiText("请输入视频提示词"));
            return null;
        }
        if (!modelReady) {
            handleMissingModelConfig();
            return null;
        }
        if (!user || user.status !== "active") {
            message.error(uiText("当前设计师账号不可用"));
            return null;
        }
        if (quotaBlocked) {
            message.error(uiText("当前账号暂时无法提交，请联系管理员"));
            return null;
        }
        if (validationError) {
            message.error(displayNotice(uiText(validationError)));
            return null;
        }
        return snapshotVideoRequest({ text, ...(planning ? { promptInput: createVideoMotionInput(text, motion, videoConfig, { images: references.length, videos: videoReferences.length, audios: audioReferences.length }) } : {}), config: videoConfig, references, videoReferences, audioReferences });
    };

    const retryResult = async (result: GenerationResult) => {
        if (result.recovery) {
            if (!result.recovery.canRecover) { message.warning(uiText("需要管理员协助确认原任务，请勿重复生成")); return; }
            const log = logs.find((item) => item.id === result.recovery?.logId);
            if (!log) { message.error(uiText("原任务记录暂未读取，请从生成记录中重新打开")); return; }
            void pollGenerationLog(log, true);
            return;
        }
        const log = logs.find(item => item.id === result.id);
        if (!log || log.status !== "失败") { message.warning(uiText("原任务状态尚未确认，请继续查询，不要重复生成。")); return; }
        modal.confirm({ title: uiText("按原参数重试？"), content: uiText("将使用此失败任务的原提示词、模型与参考素材提交一个新任务；当前草稿保持不变。"), okText: uiText("按原参数重试"), cancelText: uiText("取消"), onOk: async () => {
            const restored = await hydrateVideoLogMedia(log, { image: resolveImageUrl, media: resolveMediaUrl }, true);
            await generate(snapshotVideoRequest({ text: log.prompt, promptInput: log.promptInput, config: { ...baseConfig, ...log.config }, references: restored.references, videoReferences: restored.videoReferences, audioReferences: restored.audioReferences }));
        } });
    };

    const downloadVideo = async (video: GeneratedVideo) => {
        try {
            const url = await resolveMediaUrl(video.storageKey, video.url);
            let blob: Blob;
            if (!url && video.serverAssetId) blob = await fetchServerAssetContent(video.serverAssetId);
            else {
                if (!url) throw new Error("原视频文件不在当前浏览器中，请重新导入原件。");
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`视频下载失败（${response.status}）`);
                    blob = await response.blob();
                } catch (error) {
                    if (!video.serverAssetId) throw error;
                    // An expired browser URL may fall back only to the same original, never playback.
                    blob = await fetchServerAssetContent(video.serverAssetId);
                }
            }
            saveAs(blob, generationDownloadName(logs.find(log => log.video?.id === video.id)?.title || "生成视频", videoFileExtension(blob.type || video.mimeType)));
        } catch (error) { message.error(displayNotice(uiText(generationErrorMessage(error)))); }
    };

    const reportPlaybackError = (video: GeneratedVideo) => {
        setPlaybacks(current => ({ ...current, [video.id]: {
            ...current[video.id], status: "error",
            error: video.serverAssetId ? "当前浏览器仍无法播放兼容预览；原任务已成功，可下载原件或稍后重新读取记录。" : "当前浏览器无法解码本地原件；没有可用的服务端兼容预览，原任务状态不变，可下载原件。",
        } }));
    };

    const reportPlaybackMetadata = (id: string, metadata: Pick<VideoPlaybackView, "width" | "height" | "durationMs">) => {
        setPlaybacks(current => ({ ...current, [id]: { ...(current[id] || { status: "local" }), ...metadata } }));
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        const existing = useAssetStore.getState().assets.find(asset => asset.ownerId === user?.id && (asset.id === video.localAssetId || Boolean(video.serverAssetId && asset.metadata?.serverAssetId === video.serverAssetId) || asset.kind === "video" && asset.data.storageKey === video.storageKey));
        if (existing) { message.info(uiText("该视频已在我的素材中，无需重复添加")); return; }
        const sourceLog = logs.find(log => log.video?.id === video.id);
        addAsset({
            kind: "video",
            title: "生成视频",
            coverUrl: "",
            tags: [],
            source: "视频创作台",
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", module: "视频创作", prompt: sourceLog?.prompt || "", model: sourceLog?.model || "", ...(video.serverAssetId ? { serverAssetId: video.serverAssetId } : {}), recreatePath: `/video?prompt=${encodeURIComponent(sourceLog?.prompt || "")}&model=${encodeURIComponent(sourceLog?.model || "")}` },
        });
        message.success(uiText("已加入我的素材"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (!workspaceActive || !draftReady || readingReferences) return;
        draftEditRevisionRef.current += 1;
        const scope = referenceScopeRef.current;
        setReadingReferences(true);
        try {
        if (payload.kind === "text") {
            reusePrompt(payload.content);
        } else if (payload.kind === "image") {
            if (references.length >= maxImageReferences) { message.warning(displayNotice(uiText("当前模型或模式最多使用 {maxImageReferences} 张图片，请先移除多余参考图。", { maxImageReferences: maxImageReferences }))); return; }
            const stored = await uploadImage(payload.dataUrl);
            if (!isCurrentReferenceScope(scope)) return;
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else if (payload.kind === "video") {
            const reference = { id: nanoid(), name: payload.title, type: "video/mp4", url: payload.url, storageKey: payload.storageKey, width: payload.width, height: payload.height };
            const error = videoReferenceError(videoConfig, references, [...videoReferences, reference], audioReferences, undefined, true);
            if (error) { message.warning(displayNotice(uiText(error))); return; }
            setVideoReferences((value) => [...value, reference]);
        }
        message.success(displayNotice(uiText(payload.kind === "image" ? "已加入参考图" : "已选择")));
        setAssetPickerOpen(false);
        } catch (error) { if (isCurrentReferenceScope(scope)) message.error(displayNotice(uiText(generationErrorMessage(error)))); }
        finally { if (isCurrentReferenceScope(scope)) setReadingReferences(false); }
    };

    const createTask = async () => {
        // Preserve this workspace and its in-flight observers. A failed registry
        // write must not discard the draft or close the mobile history portal.
        if (await workbenchTask.createNewTask()) setLogsOpen(false);
    };

    const deleteSelectedLogs = async () => {
        try {
            const deleted = await deleteSelectedHistory(async (selected) => {
                if (selected.some(log => log.status === "生成中" || log.status === "查询暂停")) throw new Error("进行中或待核查的原任务记录不能删除，请等待任务结束");
                const assets = useAssetStore.getState().assets;
                const mediaKeys = selected.map(log => log.video?.storageKey).filter((key): key is string => Boolean(key) && !assets.some(asset => asset.kind === "video" && asset.data.storageKey === key));
                await Promise.all(selected.map(log => logStore.removeItem(log.id)));
                await deleteStoredMedia(mediaKeys);
            });
            if (deleted?.previewRemoved) setHistoryResults([]);
            if (deleted) {
                const removed = new Set(deleted.deletedIds);
                setResults(current => current.filter(result => !removed.has(result.id)));
                await refreshLogs();
            }
        } catch (error) {
            message.error(displayNotice(error instanceof Error ? uiText(error.message) : uiText("记录删除失败")));
        }
    };

    const saveLog = async (log: GenerationLog) => {
        // Storage failure must not disguise a submitted task as a submission failure.
        logRefreshRevisionRef.current += 1;
        setLogs((current) => upsertGenerationLog(current, log));
        try {
            await logStore.setItem(log.id, serializeLog(log));
        } catch (error) {
            message.warning(displayNotice(uiText("视频任务继续处理，但本地记录未保存：{value1}", { value1: error instanceof Error ? error.message : "浏览器存储不可用" })));
        }
    };

    const refreshLogs = async (restoreInitialResults = false) => {
        const ownerId = user?.id;
        const currentOwner = () => mountedRef.current && useUserStore.getState().user?.id === ownerId && useUserStore.getState().user?.status === "active";
        if (!currentOwner()) return;
        const revision = ++logRefreshRevisionRef.current;
        const readId = ++logReadIdRef.current;
        const resultScope = resultViewScopeRef.current;
        const isCurrent = () => currentOwner() && revision === logRefreshRevisionRef.current;
        setLogsLoading(true);
        try {
            const nextLogs = (await readStoredLogs(logStore)).filter(log => matchesWorkbenchTask(log, workspaceId));
            if (!isCurrent()) return;
            setLogs(nextLogs);
            setLogsReady(true);
            setLogsError("");
            resumePendingLogs(nextLogs, restoreInitialResults && resultScope === 0 && resultViewScopeRef.current === 0);
        } catch (error) {
            if (!isCurrent()) return;
            setLogsError(error instanceof Error ? error.message : "视频历史读取失败");
        } finally {
            if (currentOwner() && readId === logReadIdRef.current) setLogsLoading(false);
        }
    };

    const resumePendingLogs = (items: GenerationLog[], showResults = true) => {
        for (const log of items) {
            if ((log.status === "生成中" || log.status === "查询暂停") && (log.task || log.requestId)) void pollGenerationLog(log, false, showResults);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, recover = false, showResult = true) => {
        if ((!log.task && !log.requestId) || activeLogIdsRef.current.has(log.id)) return;
        if (showResult) visibleResultLogIdsRef.current.add(log.id);
        let task = log.task;
        const ownerId = user?.id;
        const controller = new AbortController();
        observationControllers.current.set(log.id, controller);
        const isCurrent = () => mountedRef.current && useUserStore.getState().user?.id === ownerId;
        const displayResult = (result: GenerationResult) => {
            if (!isCurrent()) return;
            const updated = { ...result, id: log.id, createdAt: log.createdAt, taskId: task?.id };
            if (visibleResultLogIdsRef.current.has(log.id)) setResults(current => [...current.filter(item => item.id !== log.id), updated]);
            // History is a separate view: another task finishing cannot replace it.
            if (previewLogRef.current?.id === log.id) {
                if (result.status !== "pending") { previewLoader.invalidate(); setPreviewLoading(false); }
                setHistoryResults([updated]);
            }
        };
        activeLogIdsRef.current.add(log.id);
        setRunning(true);
        setActiveTaskId(task?.id || null);
        setStartedAt((value) => value || performance.now());
        displayResult({ id: log.id, status: "pending" });
        try {
            if (!task) {
                const found = await getQueuedTaskByRequestId(log.requestId!, controller.signal);
                if (!found) throw new Error("尚未查到提交结果，请稍后继续查询原请求，不要重复生成");
                task = { id: found.id, requestId: found.requestId, model: log.model, provider: "server", prompt: found.prompt, summaryZh: videoMotionSummary(found) };
                log = { ...log, task, effectivePrompt: found.prompt || log.effectivePrompt, summaryZh: task.summaryZh || log.summaryZh };
                await saveLog(log);
                if (isCurrent()) setActiveTaskId(task.id);
            }
            if (recover) await recoverQueuedTask(task.id, controller.signal);
            const [completed] = await waitForTasks([task.id], controller.signal, undefined, true);
            if (!completed) throw new Error("原视频任务暂时无法查询，请继续查询原任务，不要重复生成");
            if (completed.status !== "success") throw new QueuedTaskFailedError(completed);
            log = { ...log, effectivePrompt: completed.prompt || log.effectivePrompt, summaryZh: videoMotionSummary(completed) || log.summaryZh };
            if (!completed.resultUrls[0]) throw new Error("原视频任务暂时没有可读取结果，请继续查询");
            const stored = await storeGeneratedVideo({ url: completed.resultUrls[0], mimeType: "video/mp4" });
            if (useUserStore.getState().user?.id !== ownerId) return;
            const nextVideo: GeneratedVideo = {
                id: nanoid(), url: stored.url, storageKey: stored.storageKey,
                durationMs: completedVideoTaskDurationMs(completed),
                // Asset dimensions use zero for unknown; the player displays measured metadata only.
                width: stored.width ?? 0, height: stored.height ?? 0,
                bytes: stored.bytes, mimeType: stored.mimeType,
                serverAssetId: stored.serverAssetId,
            };
            const existing = useAssetStore.getState().assets.find(asset => asset.ownerId === ownerId && Boolean(stored.serverAssetId && asset.metadata?.serverAssetId === stored.serverAssetId));
            nextVideo.localAssetId = existing?.id || addAsset({
                kind: "video", title: "视频创作结果", coverUrl: "", tags: ["视频创作"], source: "视频创作",
                data: { url: nextVideo.url, storageKey: nextVideo.storageKey, width: nextVideo.width, height: nextVideo.height, bytes: nextVideo.bytes, mimeType: nextVideo.mimeType },
                metadata: { source: "video-page", module: "视频创作", prompt: log.prompt, model: log.model, ...(stored.serverAssetId ? { serverAssetId: stored.serverAssetId } : {}), recreatePath: `/video?prompt=${encodeURIComponent(log.prompt)}&model=${encodeURIComponent(log.model)}` },
            });
            displayResult({ id: log.id, status: "success", video: nextVideo });
            await saveLog({ ...log, status: "成功", durationMs: nextVideo.durationMs, video: nextVideo, error: undefined, canRecover: undefined });
            if (isCurrent()) message.success(uiText("视频已生成"));
        } catch (error) {
            if (useUserStore.getState().user?.id !== ownerId) return;
            const errorMessage = controller.signal.aborted ? "已停止本页查询；服务端任务可能继续，可查询原任务。" : error instanceof Error ? error.message : "暂时无法查询原任务";
            const canRecover = error instanceof QueuedTaskPausedError ? error.canRecover : error instanceof QueuedTaskFailedError ? undefined : true;
            // A later missing/read-failed lookup cannot erase the original POST failure.
            const diagnostic = canRecover !== undefined && log.diagnostic ? log.diagnostic : generationErrorDiagnostic(error, { requestId: log.requestId || task?.requestId, taskId: task?.id });
            displayResult({ id: log.id, status: canRecover === undefined ? "failed" : "paused", error: errorMessage, diagnostic, ...(canRecover !== undefined ? { recovery: { logId: log.id, task, canRecover } } : {}) });
            await saveLog({ ...log, status: canRecover === undefined ? "失败" : "查询暂停", durationMs: null, error: errorMessage, diagnostic, canRecover });
            if (isCurrent() && !controller.signal.aborted) message.warning(displayNotice(uiText(errorMessage)));
        } finally {
            observationControllers.current.delete(log.id);
            activeLogIdsRef.current.delete(log.id);
            if (isCurrent() && !activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const selectResultPrompt = (video: GeneratedVideo) => {
        const sourceLog = logs.find(log => log.video?.id === video.id);
        if (!sourceLog || typeof sourceLog.prompt !== "string") return;
        reusePrompt(sourceLog.prompt);
    };

    const previewGenerationLog = (log: GenerationLog, restoreDraft = false) => {
        const revision = ++resultViewScopeRef.current;
        const ownerId = user?.id;
        const isCurrent = () => mountedRef.current && resultViewScopeRef.current === revision && useUserStore.getState().user?.id === ownerId;
        restoredInitialResultRef.current = true;
        setPreviewLog(log);
        setResultView("history");
        setLogsOpen(false);
        setHistoryResults([]);
        setPreviewLoading(true);
        setPreviewError("");
        if (restoreDraft) {
            resetReferenceScope();
            setPrompt(log.prompt);
            setMotion(normalizeVideoMotionSettings(log.promptInput?.fields ?? defaultVideoMotionSettings));
            setRawPrompt(!log.promptInput && allowRawPrompt);
            updateConfig("videoMode", log.config.videoMode || log.happyHorseMode || "auto");
            setReferences([]);
            setVideoReferences([]);
            setAudioReferences([]);
            if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
            if (log.config.size) updateConfig("size", log.config.size);
            if (log.config.vquality) updateConfig("vquality", log.config.vquality);
            if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
            if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
            if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
            updateConfig("videoSeed", log.config.videoSeed || "");
            updateConfig("videoOutputFormat", log.config.videoOutputFormat || "mp4");
        }
        const restorationRevision = draftEditRevisionRef.current;
        void previewLoader.load(
            async (signal) => {
                const resolved = await hydrateVideoLogMedia(log, { image: resolveImageUrl, media: resolveMediaUrl, task: getQueuedTask, refreshDuration: true }, restoreDraft, signal);
                signal.throwIfAborted();
                if (!isCurrent()) throw new DOMException("记录读取已停止或员工会话已变化", "AbortError");
                if (resolved.durationMs !== log.durationMs || resolved.video?.durationMs !== log.video?.durationMs) {
                    try { await logStore.setItem(resolved.id, serializeLog(resolved)); }
                    catch { if (isCurrent() && !signal.aborted) message.warning(uiText("耗时已核对，但本地记录保存失败；下次打开时将重新核对。")); }
                    signal.throwIfAborted();
                    if (!isCurrent()) throw new DOMException("记录读取已停止或员工会话已变化", "AbortError");
                }
                return resolved;
            },
            (resolved) => {
                if (!isCurrent()) return;
                setPreviewLoading(false);
                setPreviewLog(resolved);
                if (resolved.durationMs !== log.durationMs || resolved.video?.durationMs !== log.video?.durationMs) {
                    logRefreshRevisionRef.current += 1;
                    setLogs(current => upsertGenerationLog(current, resolved));
                }
                if (restoreDraft && restorationRevision === draftEditRevisionRef.current) {
                    setReferences(resolved.references);
                    setVideoReferences(resolved.videoReferences);
                    setAudioReferences(resolved.audioReferences);
                }
                setHistoryResults(resolved.status === "生成中" ? [{ id: resolved.id, status: "pending" }] : resolved.video ? [{ id: resolved.id, status: "success", video: resolved.video }] : [{ id: resolved.id, status: "failed", error: resolved.error || "生成失败", diagnostic: resolved.diagnostic, taskId: resolved.task?.id, ...((resolved.task || resolved.requestId) && resolved.canRecover !== undefined ? { recovery: { logId: resolved.id, task: resolved.task, canRecover: resolved.canRecover } } : {}) }]);
            },
            (error) => { if (isCurrent()) { setPreviewLoading(false); setPreviewError(error instanceof Error ? uiText(error.message) : uiText("记录中的媒体暂时无法读取")); } },
        );
    };

    const readReferenceFiles = async (files: FileList | File[] | null) => {
        if (!files?.length || readingReferences) return;
        draftEditRevisionRef.current += 1;
        const scope = referenceScopeRef.current;
        setReadingReferences(true);
        setReferenceError("");
        try { await addReferences(files); }
        catch (error) { if (isCurrentReferenceScope(scope)) setReferenceError(error instanceof Error ? error.message : "参考素材读取失败，请重新选择文件"); }
        finally { if (isCurrentReferenceScope(scope)) setReadingReferences(false); }
    };

    const imageDrop = useImageDrop({
        onFiles: readReferenceFiles,
        scopeKey: draftScope(`video:${referenceScope}`),
        disabled: !workspaceActive || !draftReady || readingReferences || submitting || previewLoading || user?.status !== "active",
    });

    return (
        <div className="wb-page generation-workbench video-workbench flex h-full flex-col overflow-hidden">
            <main className="video-workbench-layout min-h-0 flex-1">
                    <div {...imageDrop.dropProps} aria-busy={imageDrop.reading || readingReferences} className={`wb-surface generation-form flex min-w-0 flex-col p-5 lg:min-h-0 lg:overflow-hidden${imageDrop.dragging ? " outline outline-2 outline-offset-2 outline-primary" : ""}`}>
                        {imageDrop.dragging ? <p role="status" className="mb-3 rounded-lg bg-primary/10 p-3 text-sm text-foreground">{uiText("松开以添加参考图片，不会自动生成。")}</p> : null}
                        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div><h1 className="wb-title">{uiText("视频生成")}</h1></div>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    {uiText("记录")}</Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {uiText("参数")}</Button>
                            </div>
                        </div>
                        <p className="wb-description">{uiText("上传图片，选择想要的动效，AI 帮你规划并生成视频。")}</p>
                        <Button className="mt-3" icon={<Upload className="size-4" />} onClick={() => fileInputRef.current?.click()} disabled={readingReferences}>{uiText("上传图片 · 首帧 / 尾帧")}</Button>
                        {readingReferences || imageDrop.reading ? <div role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{uiText("正在处理参考素材…")}</div> : null}
                        {referenceError || validationError ? <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{display(referenceError || validationError)}</p> : null}

                        <div className="mt-6 space-y-5">

                            <details open={referencesOpen} onToggle={(event) => setReferencesOpen(event.currentTarget.open)} className="rounded-xl border border-border p-3">
                                <summary className="cursor-pointer text-sm font-medium text-foreground">{uiText("参考素材")}<span className="ml-2 text-xs font-normal text-muted-foreground">{optionalReferenceCount ? optionalReferenceCount + uiText(" 个已添加") : uiText("可选 · 点击添加")}</span></summary>
                                <div className="mt-4 space-y-4">
                            <p className="text-[13px] leading-5 text-muted-foreground">{uiText(modelSpec?.nativeAudio ? "当前上传入口支持 JPEG/PNG/WebP 图片，单张 ≤10MB；最多 1 段不超过 15 秒的 MP4/MOV 视频，≤200MB。不支持音频输入。切换模型不会删除素材。" : "图片支持 JPEG/PNG/WebP，单张 ≤10MB；视频支持 MP4/MOV，音频支持 WAV/MP3。素材和模式按所选模型校验，切换模型不会删除素材。")}</p>
                            <div className="min-w-0">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{uiText("参考图")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {uiText("剪切板")}</Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {uiText("上传")}</Button>
                                    </div>
                                </div>
                                <div className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-border p-2 pb-3 overscroll-x-contain">
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-border">
                                            <WorkbenchImage src={item.dataUrl} alt={display(item.name)} loading="lazy" decoding="async" className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white">{(currentMode === "first-frame" || currentMode === "first-last-frame") && index === 0 ? uiText("首帧") : currentMode === "first-last-frame" && index === 1 ? uiText("尾帧") : uiText("图片{index}", { index: index + 1 })}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded bg-black/60 text-white"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={uiText("移除参考图")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-muted-foreground">{uiText("暂无参考图，最多 ")}{maxImageReferences} {uiText(" 张")}</div> : null}
                                </div>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">{uiText(modelSpec?.imageInputHint || "")}</p>
                            </div>
                            {modelSpec?.maxVideos || videoReferences.length ? <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-sm font-semibold">{uiText("参考视频 · 最多 ")}{modelSpec?.maxVideos || 0} {uiText(" 段")}</span>
                                    <Button size="small" disabled={!modelSpec?.maxVideos || readingReferences} icon={<Upload className="size-3.5" />} onClick={() => videoInputRef.current?.click()}>{uiText("上传视频")}</Button>
                                </div>
                                <div className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-border p-2 pb-3 overscroll-x-contain">
                                    {videoReferences.map((item, index) => (
                                        <div key={item.id} className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-md border border-border bg-black">
                                            <video src={item.url} className="size-full object-cover" muted preload="metadata" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white">{uiText("视频{index}", { index: index + 1 })}</span>
                                            <ReferenceOrderButtons index={index} total={videoReferences.length} onMove={(offset) => setVideoReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded bg-black/60 text-white"
                                                onClick={() => setVideoReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={uiText("移除参考视频")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div> : null}

                            {modelSpec?.maxAudios || audioReferences.length ? <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-sm font-semibold">{uiText("参考音频 · 最多 ")}{modelSpec?.maxAudios || 0} {uiText(" 段")}</span>
                                    <Button size="small" disabled={!modelSpec?.maxAudios || readingReferences} icon={<Upload className="size-3.5" />} onClick={() => audioInputRef.current?.click()}>{uiText("上传音频")}</Button>
                                </div>
                                <div className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-border p-2 pb-3 overscroll-x-contain">
                                    {audioReferences.map((item, index) => (
                                        <div key={item.id} className="group relative flex h-20 w-48 shrink-0 flex-col justify-center gap-2 rounded-md border border-border bg-muted px-2">
                                            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                                <Music2 className="size-4 shrink-0" />
                                                <span className="shrink-0 rounded bg-muted px-1 text-xs text-foreground">{uiText("音频{index}", { index: index + 1 })}</span>
                                                <span className="truncate">{display(item.name)}</span>
                                            </div>
                                            <audio src={item.url} controls className="h-8 w-full" preload="metadata" />
                                            <ReferenceOrderButtons index={index} total={audioReferences.length} onMove={(offset) => setAudioReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded bg-black/60 text-white"
                                                onClick={() => setAudioReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={uiText("移除参考音频")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div> : null}

                                </div>
                            </details>

                            {planning ? <VideoMotionPanel value={motion} onChange={setMotion} disabled={!draftReady} nativeAudio={modelSpec?.nativeAudio} /> : null}
                            <div>
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                                    <span className="shrink-0 text-base font-semibold">{uiText(planning ? "想要的效果（可选）" : "视频提示词")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {uiText("提示词库")}</Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {uiText("我的素材")}</Button>
                                    </div>
                                </div>
                                <Input.TextArea aria-label={uiText("视频提示词")} showCount value={prompt} onPaste={event => { const files = pastedImageFiles(event.clipboardData); if (files.length) { event.preventDefault(); void readReferenceFiles(files); } }} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => handleSubmitShortcut(event, canGenerate && !submitting && !readingReferences && !previewLoading, () => void generate())} rows={4} placeholder={uiText(planning ? "简单写就行，比如：模特转个身，镜头慢慢拉近看领口（可不填）" : "描述镜头运动、主体动作、场景氛围和画面风格（Ctrl/⌘ + Enter 提交）")} />
                                <DisplayTranslationPreview text={prompt} />
                                {allowRawPrompt ? <Checkbox className="mt-2" checked={rawPrompt} onChange={event => setRawPrompt(event.target.checked)}>{uiText("不经 AI 整理，直接发送")}</Checkbox> : null}
                            </div>

                        </div>
                        </div>
                        <div className="generation-submit shrink-0 pt-4">
                            <div className="mb-2 flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                                <span className="truncate text-muted-foreground">
                                    {display(videoModelSummaryLabel(effectiveConfig, model, configuredModels))} · {videoResolutionLabel(videoConfig.vquality)} · {videoSizeLabel(videoConfig.size)} · {videoSecondsLabel(videoConfig.videoSeconds, currentMode, modelSpec?.extendAddsDuration)}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {uiText("调整")}</Button>
                            </div>

                            {!modelReady ? <p className="text-xs text-amber-600">{configStatus === "ready" ? uiText("当前所选视频模型不可用，请重新选择；不会自动更换渠道。") : uiText("正在读取可用模型配置…")}</p> : null}
                            {logsError ? <div role="alert" className="mb-3 text-sm text-destructive"><p>{display(uiText(logsError))}</p><p>{uiText(logsReady ? "已有视频任务不受影响；可重新读取记录。" : "视频记录读取成功后才能生成；不会重复提交原任务。")}</p><Button size="small" loading={logsLoading} disabled={logsLoading} onClick={() => void refreshLogs(true)}>{uiText("重新读取视频记录")}</Button></div> : null}
                            {!canGenerate || submitting || readingReferences || previewLoading ? <p role="status" className="mb-2 text-[13px] text-muted-foreground">{!draftReady ? uiText("正在恢复草稿…") : !logsReady ? uiText(logsLoading ? "正在恢复视频记录…" : "视频记录尚未读取，请重试") : submitting ? uiText(planning ? "AI 正在规划动效并提交视频" : "正在提交，请勿重复点击") : readingReferences ? uiText("正在读取参考素材，请稍候") : previewLoading ? uiText("正在读取历史结果，请稍候") : !planning && !prompt.trim() ? uiText("还差：填写提示词") : quotaBlocked ? uiText("当前账号暂时无法提交，请联系管理员") : validationError ? display(uiText(validationError)) : !user || user.status !== "active" ? uiText("当前设计师账号不可用") : null}</p> : null}
                            <Button block icon={<Plus className="size-4" />} loading={workbenchTask.creating} disabled={!workbenchTask.ready || workbenchTask.creating} onClick={() => void createTask()}>{uiText("新建任务，继续创作")}</Button>
                            {running ? <Button block onClick={() => { for (const controller of observationControllers.current.values()) controller.abort(); }}>{uiText("停止本页查询（不取消服务端任务）")}</Button> : logs.some(log => log.status === "查询暂停") ? <Button block onClick={() => resumePendingLogs(logs)}>{uiText("继续查询原任务")}</Button> : null}
                            {/* Keep the primary action bottom-most so a second pointer click cannot hit a newly inserted action. */}
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={submitting} disabled={!canGenerate || submitting || readingReferences || previewLoading} onClick={() => void generate()}>
                                {submitting ? uiText("正在提交视频") : running ? uiText("继续生成新视频") : uiText("生成视频")}
                            </Button>
                        </div>
                    </div>

                    <div className="wb-surface thin-scrollbar video-result-panel min-w-0 p-5 lg:min-h-0 lg:overflow-y-auto">
                        <div role="tablist" aria-label={uiText("视频结果视图")} className="generation-result-tabs mb-4">
                            <button type="button" role="tab" aria-selected={resultView === "current"} onClick={() => setResultView("current")}>{uiText("本次结果")}</button>
                            <button type="button" role="tab" aria-selected={resultView === "history"} onClick={() => setResultView("history")}>{uiText("历史记录")}</button>
                        </div>
                        {resultView === "history" ? <div className="video-history-panel mb-5"><GenerationAccountHistory board="video" /><LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} createDisabled={!workbenchTask.ready || workbenchTask.creating} onCreateTask={() => void createTask()} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} /></div> : null}
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-xl font-semibold">{uiText(resultView === "history" ? "历史结果预览" : "生成结果")}</h2>
                            {resultView === "history" && previewLog ? <Button size="small" disabled={previewLoading} onClick={() => modal.confirm({ title: uiText("恢复为草稿？"), content: uiText("将替换当前提示词、参数与参考素材，不会提交生成任务。"), okText: uiText("确认恢复"), cancelText: uiText("保留草稿"), onOk: () => previewGenerationLog(previewLog, true) })}>{uiText("恢复为草稿继续改")}</Button> : null}
                            {running ? <Tag className="m-0 px-2 py-1">{uiText("用时 ")}<GenerationElapsed startedAt={startedAt} /></Tag> : null}
                        </div>
                        {resultView === "current" ? <GenerationQueueProgress taskId={activeTaskId} active={running} /> : null}
                        {previewError ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><p>{display(uiText(previewError || ""))}</p>{previewLog ? <Button className="mt-3" onClick={() => previewGenerationLog(previewLog)}>{uiText("重新读取记录")}</Button> : null}</div> : null}
                        {displayedResults.length ? (
                            <div className="grid gap-4">
                                {displayedResults.map((result) =>
                                    result.status === "success" && result.video ? (
                                        <ResultVideoCard
                                            key={result.id} video={result.video} playback={playbackSessions.get(result.video.id)?.owner === playbackOwner ? playbacks[result.video.id] : undefined}
                                            onPlaybackError={() => reportPlaybackError(result.video!)}
                                            onMetadata={metadata => reportPlaybackMetadata(result.video!.id, metadata)}
                                            summaryZh={logs.find(log => log.id === result.id || log.video?.id === result.video?.id)?.summaryZh}
                                            onSelect={selectResultPrompt} onDownload={downloadVideo} onSaveAsset={saveResultToAssets}
                                            onPlaceCanvas={resultCanvas.enabled ? video => { const source = logs.find(log => log.video?.id === video.id); void resultCanvas.place({ id: video.id, kind: "video", url: video.url, storageKey: video.storageKey, title: source?.title || "视频生成结果", width: video.width, height: video.height, prompt: source?.effectivePrompt || source?.prompt, model: source?.model, sourceTaskId: source?.task?.id }); } : undefined}
                                            placingCanvas={resultCanvas.busy}
                                        />
                                    ) : result.status === "failed" || result.status === "paused" ? (
                                        <FailedVideoCard key={result.id} error={result.error || uiText("生成失败")} diagnostic={result.diagnostic || logs.find(log => log.id === result.id)?.diagnostic} recovery={result.recovery} onRetry={() => void retryResult(result)} />
                                    ) : (
                                        <PendingVideoCard key={result.id} summaryZh={logs.find(log => log.id === result.id)?.summaryZh} createdAt={result.createdAt || logs.find(log => log.id === result.id)?.createdAt} taskId={result.taskId || logs.find(log => log.id === result.id)?.task?.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="wb-empty min-h-[320px] lg:min-h-[500px]">
                                {previewLoading ? <LoaderCircle className="size-9 animate-spin" /> : <VideoIcon className="size-9" />}
                                <strong>{previewLoading ? uiText("正在读取这段视频") : uiText("下一段精彩，从这里开始")}</strong>
                                    <p>{previewLoading ? uiText("只加载当前记录，其他视频保留在历史中。") : uiText("上传首帧图片，选动效或写一句想法。生成后可以播放、下载或放入画布。")}</p>
                                {!previewLoading && !prompt ? <Button onClick={() => setPrompt("镜头缓慢推进，展示一件白色衬衫的面料纹理与领口细节。自然柔光，背景简洁，主体保持一致，动作平稳。")} icon={<Sparkles className="size-4" />}>{uiText("填入一段示例")}</Button> : null}
                            </div>
                        )}
                    </div>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple={maxImageReferences > 1}
                className="hidden"
                disabled={readingReferences}
                onChange={(event) => {
                    void readReferenceFiles(event.target.files);
                    event.target.value = "";
                }}
            />
            <input ref={videoInputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple className="hidden" disabled={readingReferences} onChange={(event) => { void addMediaReferences(event.target.files, "video"); event.target.value = ""; }} />
            <input ref={audioInputRef} type="file" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" multiple className="hidden" disabled={readingReferences} onChange={(event) => { void addMediaReferences(event.target.files, "audio"); event.target.value = ""; }} />
            <Drawer title={uiText("生成记录")} placement="bottom" size="large" open={workspaceActive && logsOpen} onClose={() => setLogsOpen(false)} destroyOnHidden>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    createDisabled={!workbenchTask.ready || workbenchTask.creating}
                    onCreateTask={() => void createTask()}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={previewGenerationLog}
                />
            </Drawer>
            <Drawer title={uiText("参数")} placement="bottom" size="82vh" open={workspaceActive && settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={{ ...videoConfig, videoMode: selectedMode }} model={model} updateConfig={((key, value) => { updateConfig(key, value); if (key === "videoGenerateAudio") setMotion(current => ({ ...current, audio: value === "false" ? "none" : "ambient" })); }) as UpdateAiConfig} openConfigDialog={openConfigDialog} referenceCount={references.length} imageMode={currentMode} />
                </div>
            </Drawer>
            <PromptSelectDialog open={workspaceActive && promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={next => reusePrompt(next)} />
            <AssetPickerModal open={workspaceActive && assetPickerOpen} defaultTab="my-assets" onInsert={insertPickedAsset} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={uiText("删除生成记录")} open={workspaceActive && deleteConfirmOpen} onCancel={() => { if (!deletingLogs) setDeleteConfirmOpen(false); }} onOk={deleteSelectedLogs} confirmLoading={deletingLogs} cancelButtonProps={{ disabled: deletingLogs }} okText={uiText("删除")} okButtonProps={{ danger: true }} cancelText={uiText("取消")}>
                {uiText("确定删除选中的")}{selectedLogIds.length} {uiText("条生成记录吗？")}</Modal>
        </div>
    );
}


function GenerationSettings({ config, model, updateConfig, openConfigDialog, referenceCount, imageMode }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void; referenceCount: number; imageMode?: string }) {
    useUiText();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-2 block text-sm font-semibold sm:mb-2 sm:text-base">{uiText("模型")}</span>
                <ModelPicker toolKey="video" config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={{ ...config, model, videoModel: model }} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" referenceCount={referenceCount} imageMode={imageMode} />
            </div>
        </>
    );
}

function ResultVideoCard({ video, playback, onPlaybackError, onMetadata, summaryZh, onSelect, onDownload, onSaveAsset, onPlaceCanvas, placingCanvas }: { video: GeneratedVideo; playback?: VideoPlaybackView; onPlaybackError?: () => void; onMetadata?: (metadata: Pick<VideoPlaybackView, "width" | "height" | "durationMs">) => void; summaryZh?: string; onSelect: (video: GeneratedVideo) => void; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void; onPlaceCanvas?: (video: GeneratedVideo) => void; placingCanvas?: boolean }) {
    useUiText();
    const preparing = playback?.status === "preparing" || Boolean(video.serverAssetId && !playback);
    const playbackUrl = video.serverAssetId ? playback?.playbackUrl : video.url;
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-background">
            {summaryZh ? <div className="border-b border-border bg-muted/30 px-4 py-3 text-sm"><span className="mr-2 font-medium">{uiText("AI 动效规划")}</span><span className="text-muted-foreground"><DisplayText text={summaryZh} /></span></div> : null}
            <video src={playbackUrl} controls preload="metadata" className="aspect-video w-full bg-black object-contain" onError={onPlaybackError} onLoadedMetadata={event => {
                const media = event.currentTarget;
                onMetadata?.({ ...(media.videoWidth > 0 ? { width: media.videoWidth } : {}), ...(media.videoHeight > 0 ? { height: media.videoHeight } : {}), ...(Number.isFinite(media.duration) && media.duration > 0 ? { durationMs: Math.round(media.duration * 1000) } : {}) });
            }} />
            {preparing ? <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{uiText("视频已生成，正在准备兼容预览（最多等待 150 秒）；下载仍为原件。")}</div> : null}
            {!video.serverAssetId && !playback?.error ? <p className="px-3 py-2 text-xs text-muted-foreground">{uiText("仅有本地原件，服务端兼容预览不可用；播放能力取决于当前浏览器。")}</p> : null}
            {playback?.error ? <p role="alert" className="px-3 py-2 text-sm text-destructive"><DisplayText text={uiText(playback.error)} /></p> : null}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-3">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                        {playback?.width && playback.height ? `${playback.width}x${playback.height}` : uiText("尺寸未知")}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{playback?.durationMs ? formatDuration(playback.durationMs) : uiText("视频时长未知")}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                    <Button size="small" onClick={() => onSelect(video)}>{uiText("复用提示词")}</Button>
                    {onPlaceCanvas ? <Button size="small" loading={placingCanvas} onClick={() => onPlaceCanvas(video)}>{uiText("放入画布")}</Button> : null}
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {uiText("保存到素材库")}</Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {uiText("下载")}</Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard({ createdAt, taskId, summaryZh }: { createdAt?: number; taskId?: string; summaryZh?: string }) {
    useUiText();
    return (
        <div>
        {summaryZh ? <p className="mb-3 text-sm"><span className="mr-2 font-medium">{uiText("AI 动效规划")}</span><span className="text-muted-foreground"><DisplayText text={summaryZh} /></span></p> : null}
        <div role="status" aria-label={uiText("视频生成中")} className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-border bg-muted">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{uiText("已等待 ")}<GenerationElapsed startedAt={createdAt ? performance.now() - (Date.now() - createdAt) : 0} /></span>
                <GenerationQueueProgress taskId={taskId} active />
                <GenerationTaskCancel taskId={taskId} />
            </div>
        </div>
        </div>
    );
}

function FailedVideoCard({ error, diagnostic, recovery, onRetry }: { error: string; diagnostic?: string; recovery?: GenerationResult["recovery"]; onRetry: () => void }) {
    useUiText();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{recovery?.canRecover === false ? uiText("需要管理员协助") : recovery ? uiText("暂时无法获取进度") : uiText("生成失败")}</div>
                <GenerationDiagnostic error={error} details={diagnostic} />
                {recovery && <GenerationTaskCancel taskId={recovery.task?.id} />}
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger disabled={recovery?.canRecover === false} onClick={onRetry}>
                    {recovery ? recovery.canRecover ? uiText("继续获取结果") : uiText("需要管理员协助") : uiText("按原参数重试")}
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    createDisabled,
    onSelectedLogIdsChange,
    onCreateTask,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    createDisabled: boolean;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateTask: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    useUiText();
    const [visibleCount, setVisibleCount] = useState(40);
    const visibleLogs = logs.slice(0, visibleCount);
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{uiText("生成记录")}</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Tooltip title={createDisabled ? uiText("正在准备工作区，请稍候") : undefined}><Button size="small" icon={<Plus className="size-3.5" />} disabled={createDisabled} onClick={onCreateTask}>
                    {uiText("新建")}</Button></Tooltip>
                <Tooltip title={!logs.length ? uiText("暂无生成记录") : undefined}><Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? uiText("取消") : uiText("全选")}
                </Button></Tooltip>
                <Tooltip title={!selectedLogIds.length ? uiText("请先选择记录") : undefined}><Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {uiText("删除")}</Button></Tooltip>
            </div>
            <div className="space-y-3">
                <PracticeExampleRecord />
                {visibleLogs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {visibleCount < logs.length ? <Button block className="!h-10" onClick={() => setVisibleCount((value) => value + 40)}>{uiText("加载更多记录（剩余 ")}{logs.length - visibleCount} {uiText(" 条）")}</Button> : null}
                {!logs.length ? <div className="wb-surface wb-empty min-h-48"><History className="size-8" aria-hidden="true" /><p>{uiText("暂无生成记录")}</p><Tooltip title={createDisabled ? uiText("正在准备工作区，请稍候") : undefined}><Button disabled={createDisabled} onClick={onCreateTask} icon={<Plus className="size-4" />}>{uiText("新建任务，继续创作")}</Button></Tooltip></div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    useUiText();
    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-border bg-muted font-semibold" : "border-border bg-background hover:bg-muted"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-1" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5"><DisplayText text={log.title} /></div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-2 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-2 text-xs leading-none">{videoResolutionLabel(log.resolution)}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-2 text-xs leading-none">{log.seconds}s</Tag>
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-2 text-xs leading-none" color={log.status === "成功" ? "blue" : log.status === "生成中" ? "processing" : "red"}>
                        {uiText(log.status || "")}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-2 text-xs leading-none" color="green">
                        {log.durationMs === null ? uiText("耗时未知") : formatDuration(log.durationMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs(logStore: ReturnType<typeof createWorkspaceStorage>) {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return logs.map(normalizeLog).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (error) {
        throw new Error(`视频历史读取失败：${error instanceof Error ? error.message : "浏览器存储不可用"}`);
    }
}

function normalizeLog(log: Partial<GenerationLog>): GenerationLog {
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        workspaceId: log.workspaceId,
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || "",
        promptInput: log.promptInput,
        effectivePrompt: log.effectivePrompt,
        summaryZh: log.summaryZh,
        time: log.time || new Date().toLocaleString(getUiLocale(), { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references: log.references || [],
        videoReferences: log.videoReferences || [],
        audioReferences: log.audioReferences || [],
        happyHorseMode: log.happyHorseMode,
        durationMs: typeof log.durationMs === "number" && Number.isFinite(log.durationMs) && log.durationMs >= 0 ? log.durationMs : null,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "成功",
        task: log.task,
        requestId: log.requestId || log.task?.requestId,
        canRecover: log.canRecover,
        video: log.video,
        error: log.error,
        diagnostic: log.diagnostic,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        videoReferences: log.videoReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        audioReferences: log.audioReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function isSupportedVideoImage(blob: Blob) {
    return ["image/jpeg", "image/png", "image/webp"].includes(blob.type) && blob.size > 0 && blob.size <= 10 * 1024 * 1024;
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    useUiText();
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Tooltip title={uiText(index <= 0 ? "已是第一张参考图" : "向前移动参考图")}><span><Button size="small" aria-label={uiText("向前移动参考图")} className="!h-8 !w-8 !min-w-8 !rounded-md !bg-card/85 !p-0 !shadow-none" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} /></span></Tooltip>
            <Tooltip title={uiText(index >= total - 1 ? "已是最后一张参考图" : "向后移动参考图")}><span><Button size="small" aria-label={uiText("向后移动参考图")} className="!h-8 !w-8 !min-w-8 !rounded-md !bg-card/85 !p-0 !shadow-none" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} /></span></Tooltip>
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoMode: log.config?.videoMode || log.happyHorseMode || "auto",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        videoSeed: log.config?.videoSeed || "",
        videoOutputFormat: log.config?.videoOutputFormat || "mp4",
    };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    videoReferences,
    audioReferences,
    happyHorseMode,
    durationMs,
    status,
    task,
    video,
    error,
}: {
    prompt: string;
    model: string;
    config: AiConfig;
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    happyHorseMode?: HappyHorseMode;
    durationMs: number | null;
    status: GenerationLog["status"];
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
}): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoMode: config.videoMode,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoSeed: config.videoSeed,
        videoOutputFormat: config.videoOutputFormat,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "智能动效",
        prompt,
        time: new Date().toLocaleString(getUiLocale(), { hour12: false }),
        model,
        config: logConfig,
        references,
        videoReferences,
        audioReferences,
        happyHorseMode,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return {
        ...config,
        model,
        videoModel: model,
        ...normalizeVideoModelConfig({ ...config, model, videoModel: model }),
    };
}

function normalizeResolution(value: string) {
    return value.trim().replace(/p$/i, "");
}
