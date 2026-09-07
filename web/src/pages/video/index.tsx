import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Music2, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Drawer, Empty, Input, Modal, Tag, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useSearchParams } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, videoResolutionLabel, videoSizeLabel, videoSecondsLabel } from "@/components/video-settings-panel";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { isHappyHorseVideoConfig, type HappyHorseMode } from "@/lib/happyhorse-video";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, resolveVideoMode, videoReferenceError } from "@/lib/video-model-parameters";
import { readReferenceMediaFile } from "@/lib/video-reference-files";
import { createLatestVideoPreview, hydrateVideoLogMedia } from "./video-log-media";
import { deleteStoredMedia, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { QueuedTaskPausedError, recoverQueuedTask } from "@/services/api/generation-tasks";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { hydratePromptReuse } from "@/services/api/prompts";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
    error?: string;
    recovery?: { task: VideoGenerationTask; canRecover: boolean };
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    happyHorseMode?: HappyHorseMode;
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "生成中" | "成功" | "失败";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
    canRecover?: boolean;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoMode" | "videoGenerateAudio" | "videoWatermark">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "wireless-canvas:video_generation_logs";
const logStore = localforage.createInstance({ name: "wireless-canvas", storeName: "video_generation_logs" });

export default function VideoPage() {
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const loadedReuseTokenRef = useRef(new Set<string>());
    const generateRef = useRef<() => Promise<void>>(async () => undefined);
    const restoredInitialResultRef = useRef(false);
    const previewLoader = useRef(createLatestVideoPreview()).current;
    const logRefreshRevisionRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = (..._args: unknown[]) => true;
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
    const addAsset = useAssetStore((state) => state.addAsset);
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const configuredModels = useBusinessConfigStore((state) => state.models);
    const user = useUserStore((state) => state.user);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [videoReferences, setVideoReferences] = useState<ReferenceVideo[]>([]);
    const [audioReferences, setAudioReferences] = useState<ReferenceAudio[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState("");
    const [readingReferences, setReadingReferences] = useState(false);
    const [referenceError, setReferenceError] = useState("");
    const [referencesOpen, setReferencesOpen] = useState(false);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const videoConfig = buildVideoConfig(effectiveConfig, model);
    const isHappyHorse = isHappyHorseVideoConfig({ ...effectiveConfig, model, videoModel: model });
    const modelSpec = getVideoModelParameterSpec(model);
    const maxImageReferences = videoConfig.videoMode === "first-frame" || videoConfig.videoMode === "last-frame" ? 1 : videoConfig.videoMode === "first-last-frame" ? 2 : modelSpec?.maxImages || 0;
    const optionalReferenceCount = references.length + videoReferences.length + audioReferences.length;
    const validationError = videoReferenceError(videoConfig, references, videoReferences, audioReferences);
    const currentMode = resolveVideoMode(videoConfig, references.length, videoReferences.length, audioReferences.length);
    useEffect(() => { if (optionalReferenceCount) setReferencesOpen(true); }, [optionalReferenceCount]);
    const estimatedUsage = estimate({ operationType: "video_generation", modelId: modelOptionName(model), quantity: 1 });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimatedUsage.configured && user.creditBalance < estimatedUsage.credits);
    const canGenerate = Boolean(prompt.trim() || (isHappyHorse && currentMode === "first-frame")) && !quotaBlocked && !validationError;

    const handleMissingModelConfig = () => {
        if (canManageConfig) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }
        message.warning("当前没有可用模型，请联系管理员统一配置模型和 API");
    };

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        const happyHorse = configuredModels.find((item) => item.modelId === "happyhorse-1.1");
        const currentEnabled = configuredModels.some((item) => item.modelId === model);
        if (happyHorse && !currentEnabled) updateConfig("videoModel", happyHorse.modelId);
    }, [configuredModels, model, updateConfig]);

    useEffect(() => {
        void refreshLogs();
        return () => {
            logRefreshRevisionRef.current += 1;
            previewLoader.invalidate();
        };
    }, []);

    useEffect(() => {
        if (restoredInitialResultRef.current || running || !logs.length || results.length) return;
        restoredInitialResultRef.current = true;
        const latest = logs.find((log) => log.status === "成功" && log.video);
        if (!latest?.video) return;
        setPreviewLoading(true);
        void previewLoader.load(
            () => hydrateVideoLogMedia(latest, { image: resolveImageUrl, media: resolveMediaUrl }, false),
            (resolved) => { setPreviewLoading(false); if (resolved.video) setResults([{ id: resolved.video.id, status: "success", video: resolved.video }]); },
            () => { setPreviewLoading(false); setPreviewError("最近视频暂时无法读取，可以从生成记录重新选择。"); },
        );
    }, [logs, message, previewLoader, results.length, running]);

    useEffect(() => {
        const presetPrompt = searchParams.get("prompt");
        const presetModel = searchParams.get("model");
        if (presetPrompt) setPrompt(presetPrompt);
        if (presetModel) updateConfig("videoModel", presetModel);
    }, [searchParams, updateConfig]);

    useEffect(() => {
        const token = searchParams.get("reuseToken");
        if (!token || loadedReuseTokenRef.current.has(token)) return;
        loadedReuseTokenRef.current.add(token);
        void hydratePromptReuse(token).then(async (payload) => {
            setPrompt(payload.template.prompt);
            const parameters = payload.template.parameters;
            if (payload.pricing.selectedModel?.modelId) updateConfig("videoModel", payload.pricing.selectedModel.modelId);
            if (typeof parameters.size === "string") updateConfig("size", parameters.size);
            if (typeof parameters.resolution === "string") updateConfig("vquality", parameters.resolution);
            if (typeof parameters.seconds === "string") updateConfig("videoSeconds", parameters.seconds);
            const nextReferences = await Promise.all(payload.template.referenceAssetIds.map(async (assetId) => {
                const blob = await fetchServerAssetContent(assetId);
                const image = await uploadImage(blob);
                return { id: nanoid(), name: "模板参考图.png", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, sourceAssetId: assetId };
            }));
            setReferences(nextReferences);
            payload.warnings.forEach((warning) => message.warning(warning));
            if (payload.pricing.modelChanged) message.warning(payload.pricing.selectedModel ? `模型已变更，当前使用 ${payload.pricing.selectedModel.name}` : "模型已变更，请先选择管理员当前启用的视频模型");
            const cost = !deploymentFeatures.creditsEnabled ? "不计积分" : (payload.pricing.estimate ? `${payload.pricing.estimate.totalCredits} 积分` : "以当前选择为准");
            if (payload.mode === "fill_and_generate") {
                modal.confirm({ title: "确认使用当前配置生成视频？", content: !deploymentFeatures.creditsEnabled ? "确认后将直接提交视频生成任务。" : `当前实际预计消耗 ${cost}。确认后才会提交任务并扣费。`, okText: "确认生成", cancelText: "仅保留填入", onOk: () => generateRef.current() });
            } else message.success(`模板已填入，当前预计 ${cost}`);
        }).catch((error) => {
            loadedReuseTokenRef.current.delete(token);
            message.error(error instanceof Error ? error.message : "模板复用失败");
        });
    }, [message, modal, searchParams, updateConfig]);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        if (selectedFiles.some((file) => !isSupportedVideoImage(file))) throw new Error("图片入口支持 JPEG、PNG、WebP，单张非空且不超过 10MB。");
        if (references.length + selectedFiles.length > maxImageReferences) throw new Error(`当前模型或模式最多使用 ${maxImageReferences} 张图片，请先移除多余参考图。`);
        const nextReferences = await Promise.all(
            selectedFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, width: image.width, height: image.height };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addMediaReferences = async (files: FileList | null, kind: "video" | "audio") => {
        const selected = Array.from(files || []);
        if (!selected.length) return;
        setReadingReferences(true);
        setReferenceError("");
        try {
            const shallow = selected.map((file) => ({ id: file.name, name: file.name, type: file.type, bytes: file.size, url: "" }));
            const preliminary = videoReferenceError(videoConfig, references, kind === "video" ? [...videoReferences, ...shallow] : videoReferences, kind === "audio" ? [...audioReferences, ...shallow] : audioReferences, undefined, true);
            if (preliminary) throw new Error(preliminary);
            const prepared = await Promise.all(selected.map(readReferenceMediaFile));
            const error = videoReferenceError(videoConfig, references, kind === "video" ? [...videoReferences, ...prepared] : videoReferences, kind === "audio" ? [...audioReferences, ...prepared] : audioReferences, undefined, true);
            if (error) throw new Error(error);
            const stored = await Promise.all(prepared.map(async (item, index) => ({ ...item, ...await uploadMediaFile(selected[index], kind) })));
            if (kind === "video") setVideoReferences((current) => [...current, ...stored]);
            else setAudioReferences((current) => [...current, ...stored]);
        } catch (error) {
            setReferenceError(error instanceof Error ? error.message : "读取参考素材失败");
        } finally { setReadingReferences(false); }
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            if (references.length + blobs.length > maxImageReferences) throw new Error(`当前模型最多使用 ${maxImageReferences} 张图片，请先移除多余参考图。`);
            if (blobs.some((blob) => !isSupportedVideoImage(blob))) throw new Error("参考图仅支持 JPEG、PNG、WebP，单张非空且不超过 10MB。");
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(`已读取 ${nextReferences.length} 张参考图`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "剪切板里没有可读取的图片");
        }
    };
    const generate = async () => {
        previewLoader.invalidate();
        setPreviewLoading(false);
        setPreviewError("");
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setElapsedMs(0);
        setRunning(true);
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, snapshot.videoReferences, snapshot.audioReferences, undefined, snapshot.happyHorseMode);
            const log = buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, happyHorseMode: snapshot.happyHorseMode, durationMs: 0, status: "生成中", task });
            await saveLog(log);
            void pollGenerationLog(log, snapshot.config);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            await saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: snapshot.config,
                    references: snapshot.references,
                    videoReferences: snapshot.videoReferences,
                    audioReferences: snapshot.audioReferences,
                    happyHorseMode: snapshot.happyHorseMode,
                    durationMs: performance.now() - batchStartedAt,
                    status: "失败",
                    error: errorMessage,
                }),
            );
            message.error(errorMessage);
            setRunning(false);
        }
    };
    generateRef.current = generate;

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text && !(isHappyHorse && currentMode === "first-frame")) {
            message.error("请输入视频提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            handleMissingModelConfig();
            return null;
        }
        if (!user || user.status !== "active") {
            message.error("当前设计师账号不可用");
            return null;
        }
        if (quotaBlocked) {
            message.error(`额度不足：预计需要 ${estimatedUsage.credits} 积分，当前剩余 ${user.creditBalance} 积分`);
            return null;
        }
        if (validationError) {
            message.error(validationError);
            return null;
        }
        return { text, config: videoConfig, references: [...references], videoReferences: [...videoReferences], audioReferences: [...audioReferences], happyHorseMode: undefined };
    };

    const retryResult = (result: GenerationResult) => {
        if (result.recovery) {
            if (!result.recovery.canRecover) { message.warning("原任务提交状态待核查，请勿重复生成"); return; }
            const log = logs.find((item) => item.task?.id === result.recovery?.task.id);
            if (!log) { message.error("原任务记录暂未读取，请从生成记录中重新打开"); return; }
            void pollGenerationLog(log, undefined, true);
            return;
        }
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: "生成视频",
            coverUrl: "",
            tags: [],
            source: "视频创作台",
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", module: "视频创作", prompt, model, recreatePath: `/video?prompt=${encodeURIComponent(prompt)}&model=${encodeURIComponent(model)}` },
        });
        message.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            if (references.length >= maxImageReferences) { message.warning(`当前模型或模式最多使用 ${maxImageReferences} 张图片，请先移除多余参考图。`); return; }
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else if (payload.kind === "video") {
            const reference = { id: nanoid(), name: payload.title, type: "video/mp4", url: payload.url, storageKey: payload.storageKey, width: payload.width, height: payload.height };
            const error = videoReferenceError(videoConfig, references, [...videoReferences, reference], audioReferences, undefined, true);
            if (error) { message.warning(error); return; }
            setVideoReferences((value) => [...value, reference]);
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        restoredInitialResultRef.current = true;
        previewLoader.invalidate();
        setPreviewLoading(false);
        setPreviewError("");
        setPrompt("");
        setReferences([]);
        setVideoReferences([]);
        setAudioReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog) => {
        await logStore.setItem(log.id, serializeLog(log));
        await refreshLogs();
    };

    const refreshLogs = async () => {
        const revision = ++logRefreshRevisionRef.current;
        const nextLogs = await readStoredLogs();
        if (revision !== logRefreshRevisionRef.current) return nextLogs;
        setLogs(nextLogs);
        resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "生成中" && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, recover = false) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        activeLogIdsRef.current.add(log.id);
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults([{ id: log.id, status: "pending" }]);
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        let terminalFailure = false;
        try {
            if (recover) await recoverQueuedTask(log.task.id);
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const state = await pollVideoGenerationTask(configOverride || taskConfig, log.task);
                if (state.status === "completed") {
                    const stored = await storeGeneratedVideo(state.result);
                    const nextVideo: GeneratedVideo = {
                        id: nanoid(),
                        url: stored.url,
                        storageKey: stored.storageKey,
                        durationMs: Date.now() - log.createdAt,
                        width: stored.width || 1280,
                        height: stored.height || 720,
                        bytes: stored.bytes,
                        mimeType: stored.mimeType,
                    };
                    setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
                    await saveLog({ ...log, status: "成功", durationMs: nextVideo.durationMs, video: nextVideo, error: undefined, canRecover: undefined });
                    addAsset({
                        kind: "video",
                        title: "视频创作结果",
                        coverUrl: "",
                        tags: ["视频创作"],
                        source: "视频创作",
                        data: { url: nextVideo.url, storageKey: nextVideo.storageKey, width: nextVideo.width, height: nextVideo.height, bytes: nextVideo.bytes, mimeType: nextVideo.mimeType },
                        metadata: { source: "video-page", module: "视频创作", prompt: log.prompt, model: log.model, ...(stored.serverAssetId ? { serverAssetId: stored.serverAssetId } : {}), recreatePath: `/video?prompt=${encodeURIComponent(log.prompt)}&model=${encodeURIComponent(log.model)}` },
                    });
                    message.success("视频已生成");
                    return;
                }
                if (state.status === "failed") { terminalFailure = true; throw new Error(state.error); }
                if (attempt === 119) throw new Error("本次查询超时，可恢复查询原任务，不会重新生成");
                await delay(2500);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            const canRecover = error instanceof QueuedTaskPausedError ? error.canRecover : terminalFailure ? undefined : true;
            setResults([{ id: log.id, status: "failed", error: errorMessage, ...(canRecover !== undefined ? { recovery: { task: log.task, canRecover } } : {}) }]);
            await saveLog({ ...log, status: "失败", durationMs: Date.now() - log.createdAt, error: errorMessage, canRecover });
            message.error(errorMessage);
        } finally {
            activeLogIdsRef.current.delete(log.id);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        restoredInitialResultRef.current = true;
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        updateConfig("videoMode", log.config.videoMode || log.happyHorseMode || "auto");
        setReferences([]);
        setVideoReferences([]);
        setAudioReferences([]);
        setResults([]);
        setPreviewLoading(true);
        setPreviewError("");
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        void previewLoader.load(
            () => hydrateVideoLogMedia(log, { image: resolveImageUrl, media: resolveMediaUrl }),
            (resolved) => {
                setPreviewLoading(false);
                setReferences(resolved.references);
                setVideoReferences(resolved.videoReferences);
                setAudioReferences(resolved.audioReferences);
                setResults(resolved.status === "生成中" ? [{ id: resolved.id, status: "pending" }] : resolved.video ? [{ id: resolved.video.id, status: "success", video: resolved.video }] : [{ id: resolved.id, status: "failed", error: resolved.error || "生成失败", ...(resolved.task && resolved.canRecover !== undefined ? { recovery: { task: resolved.task, canRecover: resolved.canRecover } } : {}) }]);
            },
            (error) => { setPreviewLoading(false); setPreviewError(error instanceof Error ? error.message : "记录中的媒体暂时无法读取"); },
        );
    };

    const readReferenceFiles = async (files: FileList | null) => {
        if (!files?.length || readingReferences) return;
        setReadingReferences(true);
        setReferenceError("");
        try { await addReferences(files); }
        catch (error) { setReferenceError(error instanceof Error ? error.message : "参考素材读取失败，请重新选择文件"); }
        finally { setReadingReferences(false); }
    };

    return (
        <div className="wb-page flex h-full flex-col overflow-hidden">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[280px_minmax(0,1fr)]">
                <aside className="wb-surface thin-scrollbar hidden min-h-0 overflow-y-auto p-4 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={previewGenerationLog}
                    />
                </aside>

                <section className="grid gap-4 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[minmax(380px,420px)_minmax(0,1fr)]">
                    <div className="wb-surface thin-scrollbar flex flex-col p-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <div><p className="wb-eyebrow">动态影像工作台</p><h1 className="wb-title">视频创作</h1></div>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    记录
                                </Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    参数
                                </Button>
                            </div>
                        </div>
                        <p className="wb-description">写下镜头与动作，添加参考素材，让静态想法动起来。</p>
                        {readingReferences ? <div role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在处理参考素材…</div> : null}
                        {referenceError || validationError ? <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{referenceError || validationError}</p> : null}

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="shrink-0 text-base font-semibold">提示词</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            提示词库
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            我的素材
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder="描述镜头运动、主体动作、场景氛围和画面风格" />
                            </div>

                            <p className="text-xs leading-5 text-muted-foreground">图片支持 JPEG/PNG/WebP，单张 ≤10MB；视频支持 MP4/MOV，音频支持 WAV/MP3。素材和模式按所选模型校验，切换模型不会删除素材。</p>
                            <details open={referencesOpen} onToggle={(event) => setReferencesOpen(event.currentTarget.open)} className="rounded-xl border border-border p-3">
                                <summary className="cursor-pointer text-sm font-medium text-foreground">参考素材<span className="ml-2 text-xs font-normal text-muted-foreground">{optionalReferenceCount ? optionalReferenceCount + " 个已添加" : "可选 · 点击添加"}</span></summary>
                                <div className="mt-4 space-y-4">
                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            剪切板
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <div className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700">
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{seedanceReferenceLabel("image", index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图，最多 {maxImageReferences} 张</div> : null}
                                </div>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">{modelSpec?.imageInputHint}</p>
                            </div>
                            {modelSpec?.maxVideos || videoReferences.length ? <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-sm font-semibold">参考视频 · 最多 {modelSpec?.maxVideos || 0} 段</span>
                                    <Button size="small" disabled={!modelSpec?.maxVideos || readingReferences} icon={<Upload className="size-3.5" />} onClick={() => videoInputRef.current?.click()}>上传视频</Button>
                                </div>
                                <div className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700">
                                    {videoReferences.map((item, index) => (
                                        <div key={item.id} className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-black dark:border-stone-800">
                                            <video src={item.url} className="size-full object-cover" muted preload="metadata" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{seedanceReferenceLabel("video", index)}</span>
                                            <ReferenceOrderButtons index={index} total={videoReferences.length} onMove={(offset) => setVideoReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded bg-black/60 text-white"
                                                onClick={() => setVideoReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考视频"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div> : null}

                            {modelSpec?.maxAudios || audioReferences.length ? <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-sm font-semibold">参考音频 · 最多 {modelSpec?.maxAudios || 0} 段</span>
                                    <Button size="small" disabled={!modelSpec?.maxAudios || readingReferences} icon={<Upload className="size-3.5" />} onClick={() => audioInputRef.current?.click()}>上传音频</Button>
                                </div>
                                <div className="hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 pb-3 overscroll-x-contain dark:border-stone-700">
                                    {audioReferences.map((item, index) => (
                                        <div key={item.id} className="group relative flex h-20 w-48 shrink-0 flex-col justify-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-2 dark:border-stone-800 dark:bg-stone-900">
                                            <div className="flex min-w-0 items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                <Music2 className="size-4 shrink-0" />
                                                <span className="shrink-0 rounded bg-stone-200 px-1 text-[10px] text-stone-700 dark:bg-stone-800 dark:text-stone-200">{seedanceReferenceLabel("audio", index)}</span>
                                                <span className="truncate">{item.name}</span>
                                            </div>
                                            <audio src={item.url} controls className="h-8 w-full" preload="metadata" />
                                            <ReferenceOrderButtons index={index} total={audioReferences.length} onMove={(offset) => setAudioReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded bg-black/60 text-white"
                                                onClick={() => setAudioReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考音频"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div> : null}

                                </div>
                            </details>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {videoResolutionLabel(videoConfig.vquality)} · {videoSizeLabel(videoConfig.size)} · {videoSecondsLabel(videoConfig.videoSeconds)}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    调整
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} referenceCount={references.length} imageMode={currentMode} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <div className="mb-3 flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs dark:border-stone-800 dark:bg-stone-900">
                                <span>{!deploymentFeatures.creditsEnabled ? "不计积分" : `预计消耗 ${estimatedUsage.configured ? estimatedUsage.credits : "待配置"} 积分`}</span>
                                <span>{!deploymentFeatures.authenticationEnabled ? "免登录" : (user ? `${user.displayName} 剩余 ${user.creditBalance}` : "未登录")}</span>
                            </div>
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running || readingReferences || previewLoading} onClick={() => void generate()}>
                                {running ? "正在生成视频" : "生成视频"}
                            </Button>
                        </div>
                    </div>

                    <div className="wb-surface thin-scrollbar p-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-xl font-semibold">生成结果</h2>
                            {running ? <Tag className="m-0 px-2 py-1">用时 {formatDuration(elapsedMs)}</Tag> : null}
                        </div>
                        {previewError ? <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><p>{previewError}</p>{previewLog ? <Button className="mt-3" onClick={() => previewGenerationLog(previewLog)}>重新读取记录</Button> : null}</div> : null}
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) =>
                                    result.status === "success" && result.video ? (
                                        <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" ? (
                                        <FailedVideoCard key={result.id} error={result.error || "生成失败"} recovery={result.recovery} onRetry={() => retryResult(result)} />
                                    ) : (
                                        <PendingVideoCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="wb-empty min-h-[320px] lg:min-h-[500px]">
                                {previewLoading ? <LoaderCircle className="size-9 animate-spin" /> : <VideoIcon className="size-9" />}
                                <strong>{previewLoading ? "正在读取这段视频" : "下一段精彩，从这里开始"}</strong>
                                <p>{previewLoading ? "只加载当前记录，其他视频保留在历史中。" : "先选模型，再描述画面。生成后可以直接播放、下载，或保存到我的素材。"}</p>
                                {!previewLoading && !prompt ? <Button onClick={() => setPrompt("镜头缓慢推进，展示一件白色衬衫的面料纹理与领口细节。自然柔光，背景简洁，主体保持一致，动作平稳。")} icon={<Sparkles className="size-4" />}>填入一段示例</Button> : null}
                            </div>
                        )}
                    </div>
                </section>
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
            <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)} destroyOnHidden>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={previewGenerationLog}
                />
            </Drawer>
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} referenceCount={references.length} imageMode={currentMode} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}


function GenerationSettings({ config, model, updateConfig, openConfigDialog, referenceCount, imageMode }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void; referenceCount: number; imageMode?: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={{ ...config, model, videoModel: model }} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" referenceCount={referenceCount} imageMode={imageMode} />
            </div>
        </>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={video.url} controls preload="metadata" className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        添加到素材
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        下载
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, recovery, onRetry }: { error: string; recovery?: GenerationResult["recovery"]; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{recovery ? "原任务查询暂停" : "生成失败"}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger disabled={recovery?.canRecover === false} onClick={onRetry}>
                    {recovery ? recovery.canRecover ? "恢复查询原任务" : "提交状态待核查" : "重新生成"}
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const [visibleCount, setVisibleCount] = useState(40);
    const visibleLogs = logs.slice(0, visibleCount);
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">生成记录</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    新建
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? "取消" : "全选"}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    删除
                </Button>
            </div>
            <div className="space-y-3">
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
                {visibleCount < logs.length ? <Button block className="!h-10" onClick={() => setVisibleCount((value) => value + 40)}>加载更多记录（剩余 {logs.length - visibleCount} 条）</Button> : null}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">暂无生成记录</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{videoResolutionLabel(log.resolution)}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "成功" ? "blue" : log.status === "生成中" ? "processing" : "red"}>
                        {log.status}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(log.durationMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return logs.map(normalizeLog).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

function normalizeLog(log: Partial<GenerationLog>): GenerationLog {
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references: log.references || [],
        videoReferences: log.videoReferences || [],
        audioReferences: log.audioReferences || [],
        happyHorseMode: log.happyHorseMode,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "成功",
        task: log.task,
        canRecover: log.canRecover,
        video: log.video,
        error: log.error,
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
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
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
    durationMs: number;
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
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
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

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
