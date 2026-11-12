import { uiText, useUiText } from "@/lib/i18n";
import { GenerationAccountHistory } from "@/components/generation-account-history";
import { formatBeijingTime } from "@/lib/beijing-time";
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Image, InputNumber, Segmented, Tag } from "antd";
import { ClipboardPaste, Download, FolderPlus, Grid2x2, ImagePlus, LoaderCircle, Plus, RotateCcw, Upload } from "lucide-react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useSearchParams } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { WorkbenchTasks, useWorkbenchTask, useWorkbenchTaskStatus } from "@/components/workbench-tasks";
import { DEFAULT_WORKBENCH_TASK, matchesWorkbenchTask } from "@/lib/workbench-task-state";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { useToolConfig } from "@/hooks/use-tool-config";
import { useGenerationDraft } from "@/hooks/use-generation-draft";
import { useImageDrop } from "@/hooks/use-image-drop";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { readClipboardImages } from "@/lib/clipboard-images";
import { imageModelProfile } from "@/lib/image-model-settings";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { resolveToolModel } from "@/services/api/business-config";
import { DEFAULT_SEAMLESS_STITCH_PARAMETERS, requestSeamlessStitch, type SeamlessStitchParameters } from "@/services/api/internal-ai";
import { getQueuedTaskByRequestId, listQueuedTasks, QueuedTaskFailedError, QueuedTaskSubmissionUncertainError, type QueuedTask } from "@/services/api/generation-tasks";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { hydratePromptReuse } from "@/services/api/prompts";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { loadSeamlessPreview, type StitchPreviewImage } from "./seamless-preview";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import "./seamless-workbench.css";
import { WorkbenchImage } from "@/components/workbench-image";

const SEAMLESS_PRESETS = {
    small: { cutWidth: 100, redrawWidth: 100, blurAmount: 50, redrawStrength: 0.5, steps: 12 },
    large: DEFAULT_SEAMLESS_STITCH_PARAMETERS,
} as const;

type StitchPreset = keyof typeof SEAMLESS_PRESETS | "custom";

type StitchResult = { status: "idle" } | { status: "pending" } | { status: "failed"; error: string } | { status: "success"; image: StitchPreviewImage; durationMs: number };
type StitchTaskRecord = { workspaceId: string; requestId: string; taskId?: string; pending: boolean };

export function SeamlessStitchPage() {
    const ownerId = useUserStore(state => state.user?.id);
    return <WorkbenchTasks key={ownerId || "local"} ownerId={ownerId} boardKey="seamless-stitch"><SeamlessStitchWorkspace /></WorkbenchTasks>;
}

export function SeamlessStitchWorkspace() {
    useUiText();
    const workbenchTask = useWorkbenchTask();
    const { id: workspaceId, active: workspaceActive, draftScope } = workbenchTask;
    const [stitchTaskStore] = useState(() => createWorkspaceStorage("seamless_stitch_tasks"));
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const loadedReuseTokenRef = useRef(new Set<string>());
    const restoredHistoryTaskIdRef = useRef<string | null>(null);
    const runStitchRef = useRef<() => Promise<void>>(async () => undefined);
    const sourceRef = useRef<ReferenceImage | null>(null);
    const historyBusyRef = useRef(false);
    const previewSequenceRef = useRef(0);
    const submitLockRef = useRef(false);
    const sourceReadRef = useRef(false);
    const mountedRef = useRef(true);
    const user = useUserStore((state) => state.user);
    const hydrateSession = useUserStore((state) => state.hydrateSession);
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const models = useBusinessConfigStore((state) => state.models);
    const tools = useBusinessConfigStore((state) => state.tools);
    const defaults = useEffectiveConfig("image");
    const [draftConfig, setDraftConfig, configReady] = useGenerationDraft<Partial<AiConfig>>(draftScope("seamless-stitch:settings"), {});
    const baseConfig = { ...defaults, ...draftConfig };
    const updateConfig = useCallback(<K extends keyof AiConfig>(key: K, value: AiConfig[K]) => setDraftConfig(current => ({ ...current, [key]: value })), [setDraftConfig]);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const selectedModel = draftConfig.imageModel || draftConfig.model || resolveCapabilityModel(defaults, "image", models, defaults.imageModel || defaults.model);
    const config = useToolConfig({ ...baseConfig, model: selectedModel, imageModel: selectedModel, count: "1" }, "seamless-stitch");
    const addAsset = useAssetStore((state) => state.addAsset);
    const [source, setSource, sourceReady] = useGenerationDraft<ReferenceImage | null>(draftScope("seamless-stitch:source"), null, async saved => saved ? { ...saved, dataUrl: await resolveImageUrl(saved.storageKey, saved.dataUrl) } : null);
    sourceRef.current = source;
    const [preset, setPreset, presetReady] = useGenerationDraft<StitchPreset>(draftScope("seamless-stitch:preset"), workspaceId === DEFAULT_WORKBENCH_TASK && searchParams.get("preset") === "small" ? "small" : "large");
    const [parameters, setParameters, parametersReady] = useGenerationDraft<SeamlessStitchParameters>(draftScope("seamless-stitch:parameters"), readSeamlessParameters(workspaceId === DEFAULT_WORKBENCH_TASK ? searchParams : new URLSearchParams()));
    const [result, setResult] = useState<StitchResult>({ status: "idle" });
    const [historyResult, setHistoryResult] = useState<StitchResult>({ status: "idle" });
    const [resultView, setResultView] = useState<"current" | "history">("current");
    const displayedResult = resultView === "history" ? historyResult : result;
    const [running, setRunning] = useState(false);
    const [readingSource, setReadingSource] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [history, setHistory] = useState<QueuedTask[]>([]);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [historyError, setHistoryError] = useState("");
    const [historyPending, setHistoryPending] = useState(false);
    const [historyReady, setHistoryReady] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewMode, setPreviewMode] = useState<"single" | "repeat">("single");
    const seamlessModel = resolveToolModel({ models, tools, prices: [] }, "seamless-stitch", config.model);
    const modelProfile = imageModelProfile(config.model, models);
    const usesImageSettings = typeof seamlessModel?.imageSupportsMask === "boolean" || modelProfile.kind === "quality-resolution" || modelProfile.kind === "resolution-1k";
    const estimatedUsage = estimate({ operationType: "seamless_stitch", toolKey: "seamless-stitch", modelId: config.model, quantity: 1 });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimatedUsage.configured && user.creditBalance < estimatedUsage.credits);
    const draftReady = configReady && sourceReady && presetReady && parametersReady;
    useWorkbenchTaskStatus({ busy: running || readingSource, pending: historyPending, ready: draftReady && historyReady, label: result.status === "success" ? "已完成" : result.status === "failed" ? "已失败" : "草稿" });

    const refreshHistory = useCallback(async () => {
        if (historyBusyRef.current) return;
        historyBusyRef.current = true;
        try {
            const ownerId = useUserStore.getState().user?.id;
            const records: StitchTaskRecord[] = [];
            await stitchTaskStore.iterate<StitchTaskRecord, void>(record => { records.push(record); });
            const tasks = await listQueuedTasks(undefined, "seamless_stitch");
            // Recover only previously persisted requests; a missing response is never a new POST.
            const owned = records.filter(record => matchesWorkbenchTask(record, workspaceId));
            for (const record of owned.filter(record => record.pending)) {
                if (tasks.some(task => task.id === record.taskId || task.requestId === `${record.requestId}:0`)) continue;
                const original = await getQueuedTaskByRequestId(`${record.requestId}:0`);
                if (original) tasks.push(original);
            }
            if (useUserStore.getState().user?.id !== ownerId) return;
            if (!mountedRef.current) return;
            const belongs = (task: QueuedTask) => {
                const record = records.find(item => item.taskId === task.id || task.requestId === `${item.requestId}:0`);
                return record ? matchesWorkbenchTask(record, workspaceId) : workspaceId === DEFAULT_WORKBENCH_TASK;
            };
            const matching = tasks.filter(task => task.operationType === "seamless_stitch" && belongs(task));
            for (const record of owned.filter(record => record.pending)) {
                const task = matching.find(task => task.id === record.taskId || task.requestId === `${record.requestId}:0`);
                if (task && ["success", "failed", "cancelled"].includes(task.status)) {
                    await stitchTaskStore.setItem(record.requestId, { ...record, taskId: task.id, pending: false });
                    record.pending = false;
                }
            }
            if (!mountedRef.current || useUserStore.getState().user?.id !== ownerId) return;
            setHistory(matching.slice(0, 20));
            setHistoryPending(owned.some(record => record.pending) || matching.some(task => !["success", "failed", "cancelled"].includes(task.status)));
            setHistoryReady(true);
            setHistoryError("");
        } catch {
            if (mountedRef.current) setHistoryError("历史记录暂时未能加载，当前图片仍可使用。");
        } finally {
            historyBusyRef.current = false;
            if (mountedRef.current) setHistoryLoading(false);
        }
    }, [workspaceId, stitchTaskStore]);

    const openHistoryTask = async (task: QueuedTask, initial = false) => {
        const imageUrl = task.resultUrls[0];
        if (!imageUrl) return;
        const sequence = ++previewSequenceRef.current;
        if (!initial) setResultView("history");
        setPreviewLoading(true);
        try {
            const image = await loadSeamlessPreview(imageUrl);
            if (!mountedRef.current || sequence !== previewSequenceRef.current) return;
            restoredHistoryTaskIdRef.current = task.id;
            if (initial) setResult({ status: "success", image, durationMs: 0 });
            else setHistoryResult({ status: "success", image, durationMs: 0 });
        } catch (error) {
            if (sequence === previewSequenceRef.current) message.error(error instanceof Error ? uiText(error.message) : uiText("历史图片读取失败"));
        } finally {
            if (mountedRef.current && sequence === previewSequenceRef.current) setPreviewLoading(false);
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        void refreshHistory();
        const onVisible = () => { if (document.visibilityState === "visible") void refreshHistory(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => { mountedRef.current = false; ++previewSequenceRef.current; document.removeEventListener("visibilitychange", onVisible); };
    }, [refreshHistory]);
    const hasActiveHistory = history.some(task => ["queued", "pending", "processing", "running"].includes(task.status));
    useEffect(() => {
        if (!running && !hasActiveHistory && !historyPending) return;
        const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshHistory(); }, 4_000);
        return () => window.clearInterval(timer);
    }, [hasActiveHistory, historyPending, refreshHistory, running]);

    useEffect(() => {
        if (running || previewLoading || result.status !== "idle") return;
        const latest = history.find((task) => task.status === "success" && task.resultUrls[0]);
        if (!latest || latest.id === restoredHistoryTaskIdRef.current) return;
        // Auto-restore once; a broken preview can still be retried explicitly.
        restoredHistoryTaskIdRef.current = latest.id;
        void openHistoryTask(latest, true);
    }, [history, result.status, running, previewLoading]);

    const setSourceFromBlob = async (blob: Blob, name: string) => {
        if (sourceReadRef.current) return;
        const owner = useUserStore.getState().user?.id;
        sourceReadRef.current = true; setReadingSource(true);
        try {
            const uploaded = await uploadImage(blob);
            if (!mountedRef.current || useUserStore.getState().user?.id !== owner) return;
            const nextSource = { id: nanoid(), name, type: uploaded.mimeType, dataUrl: uploaded.url, url: uploaded.url, storageKey: uploaded.storageKey };
            sourceRef.current = nextSource;
            setSource(nextSource);
            return true;
        } finally {
            sourceReadRef.current = false;
            if (mountedRef.current) setReadingSource(false);
        }
    };

    const imageDrop = useImageDrop({
        scopeKey: draftScope("seamless-stitch:source"),
        disabled: !workspaceActive || !draftReady || readingSource || user?.status !== "active",
        onFiles: async files => {
            if (files.length !== 1) throw new Error("每个参考图位置一次只能拖入一张图片，请分别放入对应位置。");
            await setSourceFromBlob(files[0]!, files[0]!.name);
        },
    });

    const uploadSource = async (files?: FileList | null) => {
        const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
        if (!file) {
            message.error(uiText("请选择图片文件"));
            return;
        }
        try {
            await setSourceFromBlob(file, file.name);
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("图片上传失败"));
        }
    };

    const pasteSource = async () => {
        try {
            const [image] = await readClipboardImages(navigator.clipboard);
            await setSourceFromBlob(image, "clipboard-image.png");
            message.success(uiText("已读取剪贴板图片"));
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("剪贴板图片读取失败"));
        }
    };

    const insertAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind !== "image") {
            message.warning(uiText("无缝拼接只能使用图片素材"));
            return;
        }
        try {
            const response = await fetch(payload.dataUrl);
            if (!response.ok) throw new Error(`素材读取失败（${response.status}）`);
            if (!await setSourceFromBlob(await response.blob(), payload.title)) return;
            message.success(uiText("已加入参考图"));
            setAssetPickerOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("素材读取失败，请重试"));
        }
    };

    const runStitch = async () => {
        if (!draftReady || !historyReady || historyPending || submitLockRef.current || sourceReadRef.current || imageDrop.reading) return;
        const activeSource = sourceRef.current || source;
        if (!activeSource) {
            message.error(uiText("请先上传一张需要无缝拼接的图片"));
            return;
        }
        submitLockRef.current = true;
        setRunning(true);
        const ownerId = useUserStore.getState().user?.id;
        const requestId = nanoid();
        let submitted = false;
        let taskId: string | undefined;
        try {
        if (deploymentFeatures.authenticationEnabled) await hydrateSession();
        const currentUser = useUserStore.getState().user;
        if (deploymentFeatures.authenticationEnabled && (!currentUser || currentUser.status !== "active")) {
            message.error(uiText("当前设计师账号不可用"));
            return;
        }
        if ((deploymentFeatures.creditsEnabled && !estimatedUsage.configured) || !seamlessModel) {
            message.error(uiText("管理员尚未完成无缝拼接配置"));
            return;
        }
        if (deploymentFeatures.creditsEnabled && currentUser && estimatedUsage.configured && currentUser.creditBalance < estimatedUsage.credits) {
            message.error(uiText("当前账号暂时无法提交，请联系管理员"));
            return;
        }

        const startedAt = performance.now();
        ++previewSequenceRef.current;
        setPreviewLoading(false);
        setResultView("current");
        setResult({ status: "pending" });
            const response = await requestSeamlessStitch(activeSource, parameters, config, {
                requestId,
                onSubmissionStarted: async () => {
                    await stitchTaskStore.setItem(requestId, { workspaceId, requestId, pending: true } satisfies StitchTaskRecord);
                    submitted = true;
                    if (mountedRef.current) setHistoryPending(true);
                },
                onSubmitted: async ids => {
                    taskId = ids[0];
                    await stitchTaskStore.setItem(requestId, { workspaceId, requestId, taskId, pending: true } satisfies StitchTaskRecord);
                },
            });
            if (useUserStore.getState().user?.id !== ownerId) return;
            await stitchTaskStore.setItem(requestId, { workspaceId, requestId, taskId: response.sourceTaskId || taskId, pending: false } satisfies StitchTaskRecord);
            const uploaded = await uploadImage(response.dataUrl);
            if (!mountedRef.current || useUserStore.getState().user?.id !== ownerId) return;
            const recreateParameters = new URLSearchParams({ tool: "seamless-stitch", model: response.model.modelId });
            if (response.usesImageSettings) {
                recreateParameters.set("size", response.config.size);
                recreateParameters.set("quality", response.config.quality);
                recreateParameters.set("imageOptions", response.config.imageOptions || "");
            } else {
                recreateParameters.set("preset", preset);
                Object.entries(parameters).forEach(([key, value]) => recreateParameters.set(key, String(value)));
            }
            addAsset({
                kind: "image",
                title: `${activeSource.name.replace(/\.[^.]+$/, "")} 无缝拼接`,
                coverUrl: uploaded.url,
                tags: ["无缝拼接"],
                source: "无缝拼接",
                data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                metadata: {
                    source: "image-page",
                    module: "无缝拼接",
                    toolMode: "seamless-stitch",
                    operationType: "seamless_stitch",
                    projectId: "tool-seamless-stitch",
                    designerId: currentUser?.id,
                    prompt: response.usesImageSettings ? response.prompt : `无缝拼接：切割 ${parameters.cutWidth}，重绘 ${parameters.redrawWidth}，羽化 ${parameters.blurAmount}，强度 ${parameters.redrawStrength}，步数 ${parameters.steps}`,
                    model: response.model.name,
                    modelId: response.model.modelId,
                    sourceFile: activeSource.name,
                    sourceImage: activeSource.storageKey || activeSource.url || activeSource.dataUrl,
                    ...response.parameters,
                    recreatePath: `/image?${recreateParameters.toString()}`,
                },
            });
            setResult({ status: "success", image: uploaded, durationMs: performance.now() - startedAt });
            message.success(uiText("无缝拼接完成"));
        } catch (error) {
            if (useUserStore.getState().user?.id !== ownerId) return;
            const unresolved = submitted && !(error instanceof QueuedTaskFailedError) && (Boolean(taskId) || error instanceof QueuedTaskSubmissionUncertainError);
            if (submitted && !unresolved) await stitchTaskStore.setItem(requestId, { workspaceId, requestId, taskId, pending: false } satisfies StitchTaskRecord);
            const reason = error instanceof Error ? error.message : "无缝拼接失败";
            if (mountedRef.current) { setHistoryPending(unresolved); setResult({ status: "failed", error: reason }); message.error(uiText(reason)); }
        } finally {
            submitLockRef.current = false;
            if (mountedRef.current && useUserStore.getState().user?.id === ownerId) { setRunning(false); void refreshHistory(); }
        }
    };
    runStitchRef.current = runStitch;

    useEffect(() => {
        if (workspaceId !== DEFAULT_WORKBENCH_TASK) return;
        const model = searchParams.get("model");
        if (model) updateConfig("imageModel", model);
        for (const key of ["size", "quality", "imageOptions"] as const) {
            const value = searchParams.get(key);
            if (value !== null) updateConfig(key, value);
        }
    }, [searchParams, updateConfig, workspaceId]);

    useEffect(() => {
        if (workspaceId !== DEFAULT_WORKBENCH_TASK) return;
        const token = searchParams.get("reuseToken");
        if (!token || loadedReuseTokenRef.current.has(token)) return;
        loadedReuseTokenRef.current.add(token);
        void hydratePromptReuse(token).then(async (payload) => {
            const parameters = payload.template.parameters;
            const selectedModel = payload.pricing.selectedModel;
            if (selectedModel) updateConfig("imageModel", selectedModel.modelId);
            const settings = promptImageSettings(parameters, selectedModel?.modelId || config.model);
            for (const key of ["size", "quality", "imageOptions"] as const) updateConfig(key, settings[key]);
            const reusedParameters = readTemplateParameters(parameters);
            if (reusedParameters) {
                setParameters(reusedParameters);
                setPreset(matchesPreset(reusedParameters, SEAMLESS_PRESETS.small) ? "small" : matchesPreset(reusedParameters, SEAMLESS_PRESETS.large) ? "large" : "custom");
            }
            const firstAssetId = payload.template.referenceAssetIds[0];
            if (firstAssetId) await setSourceFromBlob(await fetchServerAssetContent(firstAssetId), "模板参考图.png");
            payload.warnings.forEach((warning) => message.warning(uiText(warning)));
            if (payload.mode === "fill_and_generate") {
                if (!firstAssetId) message.info(uiText("模板参数已填入，请先选择一张图片后再生成。"));
                else modal.confirm({ title: uiText("确认开始无缝拼接？"), content: uiText("确认后将直接提交生成任务。"), okText: uiText("确认生成"), cancelText: uiText("仅保留填入"), onOk: () => runStitchRef.current() });
            } else message.success(uiText("模板已填入"));
        }).catch((error) => {
            loadedReuseTokenRef.current.delete(token);
            message.error(error instanceof Error ? uiText(error.message) : uiText("模板复用失败"));
        });
    }, [estimatedUsage.credits, message, modal, searchParams, updateConfig, config.model]);

    return (
        <div className="wb-page stitch-workbench flex h-full min-h-0 flex-col overflow-hidden">
            <main className="stitch-workbench-layout min-h-0 flex-1">
                <section {...imageDrop.dropProps} aria-busy={imageDrop.reading || readingSource} className={`wb-surface stitch-form flex min-h-0 flex-col p-4${imageDrop.dragging ? " outline outline-2 outline-offset-2 outline-primary" : ""}`}>
                    <div className="thin-scrollbar stitch-form-fields min-h-0 flex-1 overflow-y-auto">
                    {imageDrop.dragging || imageDrop.reading || readingSource ? <p role="status" className="mb-3 rounded-lg bg-primary/10 p-3 text-sm">{uiText(imageDrop.dragging ? "松开以添加参考图片，不会自动生成。" : "正在读取拖入图片，请稍候。")}</p> : null}
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="mb-3 grid size-10 place-items-center rounded-lg bg-muted text-foreground">
                                <Grid2x2 className="size-5" />
                            </div>
                            <h1 className="wb-title">{uiText("无缝拼接")}</h1>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{uiText("把单张花纹或纹理处理成可连续平铺的无缝素材。")}</p>
                        </div>
                    </div>

                    <div className="mt-6">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                            <span className="text-base font-semibold">{uiText("输入图片")}</span>
                            <div className="flex gap-2">
                                <Button size="small" disabled={readingSource || imageDrop.reading} icon={<ClipboardPaste className="size-3.5" />} onClick={() => void pasteSource()}>
                                    {uiText("粘贴")}</Button>
                                <Button size="small" disabled={readingSource || imageDrop.reading} icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                    {uiText("素材库")}</Button>
                                <Button size="small" disabled={readingSource || imageDrop.reading} icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                    {uiText("上传")}</Button>
                            </div>
                        </div>
                        <button
                            type="button"
                            disabled={readingSource || imageDrop.reading}
                            className="group relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted transition hover:border-border"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {source ? (
                                <WorkbenchImage src={source.dataUrl} alt={source.name} className="size-full object-contain" />
                            ) : (
                                <span className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                                    <span className="grid size-12 place-items-center rounded-full bg-card text-muted-foreground shadow-sm">
                                        <ImagePlus className="size-5" />
                                    </span>
                                    {uiText("选择一张花纹或纹理图片")}</span>
                            )}
                        </button>
                        {source ? <div className="mt-2 truncate text-xs text-muted-foreground">{source.name}</div> : null}
                    </div>

                    <div className="mt-5">
                        <span className="mb-2 block text-sm font-semibold">{uiText("处理模型")}</span>
                        <ModelPicker toolKey="seamless-stitch" config={config} value={config.model} onChange={(value) => updateConfig("imageModel", value)} capability="image" modelsSource="server" fullWidth className="h-10 rounded-lg" onMissingConfig={() => openConfigDialog(false)} />
                    </div>
                    {usesImageSettings ? <fieldset className="mt-4 min-w-0 border-0 p-0">
                        <ImageSettingsPanel config={config} referenceCount={source ? 1 : 0} onConfigChange={updateConfig} onConfigNormalize={(key, value) => { if (configReady) updateConfig(key, value); }} theme={theme} maxCount={1} showTitle={false} className="space-y-4" />
                        <p className="mt-3 text-xs leading-5" style={{ color: theme.node.muted }}>{uiText("按参考图生成四方连续平铺的花型单元，保留原图元素、配色与风格。此模式不使用内部工作流的切割、重绘或步数参数；生成后请检查平铺接缝。")}</p>
                    </fieldset> : <><div className="mt-5">
                        <span className="mb-2 block text-sm font-semibold">{uiText("花型预设")}</span>
                        <Segmented
                            block
                            value={preset}
                            options={[{ label: uiText("小花"), value: "small" }, { label: uiText("大花"), value: "large" }, { label: uiText("自定义"), value: "custom" }]}
                            onChange={(value) => {
                                const nextPreset = value as StitchPreset;
                                setPreset(nextPreset);
                                if (nextPreset !== "custom") setParameters(SEAMLESS_PRESETS[nextPreset]);
                            }}
                        />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                        <ParameterField label={uiText("切割宽度")} value={parameters.cutWidth} onChange={(value) => updateParameter(setParameters, setPreset, "cutWidth", value)} />
                        <ParameterField label={uiText("重绘宽度")} value={parameters.redrawWidth} onChange={(value) => updateParameter(setParameters, setPreset, "redrawWidth", value)} />
                        <ParameterField label={uiText("羽化")} value={parameters.blurAmount} onChange={(value) => updateParameter(setParameters, setPreset, "blurAmount", value)} />
                        <ParameterField label={uiText("重绘强度")} value={parameters.redrawStrength} min={0} max={1} step={0.1} onChange={(value) => updateParameter(setParameters, setPreset, "redrawStrength", value)} />
                        <ParameterField label={uiText("步数")} value={parameters.steps} max={100} onChange={(value) => updateParameter(setParameters, setPreset, "steps", value)} />
                    </div>
                    <div className="mt-2 text-xs leading-5 text-muted-foreground">{uiText("小花推荐 100 / 100 / 50 / 0.5；大花推荐 200 / 200 / 100 / 1。参数由真实内部工作流处理。")}</div></>}

                    </div>
                    <div className="stitch-submit shrink-0 pt-4">
                        {!source && draftReady ? <p role="status" className="text-[13px] text-muted-foreground">{uiText("请先上传一张需要无缝拼接的图片")}</p> : null}
                        {quotaBlocked ? <p role="status" className="text-sm text-destructive">{uiText("当前账号暂时无法提交，请联系管理员")}</p> : null}
                        {!seamlessModel ? <p className="mb-3 text-xs leading-5 text-muted-foreground">{uiText("此工具尚未配置，管理员启用无缝拼接模型后即可使用。")}</p> : null}
                        {historyPending && !running ? <p role="status" className="mb-2 text-xs text-muted-foreground">{uiText("原任务仍在处理或待核查；可新建独立任务，当前请求不会自动重发。")}</p> : null}
                        <Button block icon={<Plus className="size-4" />} loading={workbenchTask.creating} disabled={!workbenchTask.ready || workbenchTask.creating} onClick={() => void workbenchTask.createNewTask()}>{uiText("新建任务，继续创作")}</Button>
                        <Button type="primary" size="large" block aria-label={uiText("开始无缝拼接")} icon={<Grid2x2 className="size-4" />} loading={running} disabled={!draftReady || !historyReady || historyPending || !source || (deploymentFeatures.creditsEnabled && !estimatedUsage.configured) || !seamlessModel || running || readingSource || imageDrop.reading || quotaBlocked} onClick={() => void runStitch()}>
                            {uiText(running ? "正在处理无缝拼接" : "开始无缝拼接")}</Button>
                    </div>
                </section>

                <section className="wb-surface thin-scrollbar stitch-result-panel min-h-0 overflow-y-auto p-4 lg:p-5">
                    <div role="tablist" aria-label={uiText("无缝拼接结果视图")} className="stitch-result-tabs mb-4">
                        <button type="button" role="tab" aria-selected={resultView === "current"} onClick={() => setResultView("current")}>{uiText("本次结果")}</button>
                        <button type="button" role="tab" aria-selected={resultView === "history"} onClick={() => setResultView("history")}>{uiText("历史记录")}</button>
                    </div>
                    <div className="stitch-preview">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-xl font-semibold">{uiText("处理结果")}</h2>
                        {previewLoading ? <span role="status" className="text-xs text-muted-foreground">{uiText("正在读取历史图片…")}</span> : null}
                        {displayedResult.status === "success" ? <Tag color="green">{uiText("已完成")}</Tag> : displayedResult.status === "pending" ? <Tag color="orange">{uiText("处理中")}</Tag> : null}
                    </div>
                    {displayedResult.status === "pending" ? (
                        <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-dashed border-orange-300 bg-orange-50/30 text-muted-foreground dark:bg-orange-950/10">
                            <LoaderCircle className="mb-3 size-8 animate-spin text-orange-500" />
                            <span className="text-sm">{uiText("正在生成无缝纹理")}</span>
                        </div>
                    ) : displayedResult.status === "success" ? (
                        <div>
                            <div className="mb-3 flex flex-wrap items-center gap-3">
                                <Segmented name="seamless-preview" aria-label={uiText("结果预览方式")} value={previewMode} onChange={value => setPreviewMode(value as "single" | "repeat")} options={[{ label: "单图", value: "single" }, { label: "2×2 平铺", value: "repeat" }]} />
                                <span className="text-xs" style={{ color: theme.node.muted }}>{uiText("平铺检查接缝，不改变原图或下载文件。")}</span>
                            </div>
                            <div className="overflow-hidden rounded-lg border border-border bg-muted">
                                {previewMode === "repeat" ? <div role="img" aria-label={uiText("无缝拼接结果 2×2 平铺预览")} className="w-full" style={{ aspectRatio: `${displayedResult.image.width} / ${displayedResult.image.height}`, backgroundImage: `url(${JSON.stringify(displayedResult.image.url)})`, backgroundSize: "50% 50%", backgroundRepeat: "repeat" }} /> : <Image src={displayedResult.image.url} alt={uiText("无缝拼接结果")} className="max-h-[620px] w-full object-contain" />}
                            </div>
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                <div className="text-xs text-muted-foreground">
                                    {displayedResult.durationMs ? uiText("{width}×{height} · {value3} 秒", { width: displayedResult.image.width, height: displayedResult.image.height, value3: (displayedResult.durationMs / 1000).toFixed(1) }) : uiText("历史处理结果")}
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        icon={<RotateCcw className="size-4" />}
                                        onClick={() => {
                                            const nextSource = { id: nanoid(), name: "seamless-result.png", type: displayedResult.image.mimeType, dataUrl: displayedResult.image.url, url: displayedResult.image.url, storageKey: displayedResult.image.storageKey };
                                            sourceRef.current = nextSource;
                                            setSource(nextSource);
                                        }}
                                    >
                                        {uiText("继续拼接")}</Button>
                                    <Button icon={<Download className="size-4" />} onClick={() => saveAs(displayedResult.image.url, "seamless-stitch.png")}>
                                        {uiText("下载结果")}</Button>
                                </div>
                            </div>
                        </div>
                    ) : displayedResult.status === "failed" ? (
                        <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50 px-6 text-center dark:border-red-950 dark:bg-red-950/20">
                            <p className="max-w-lg text-sm text-red-600 dark:text-red-300">{uiText(displayedResult.error || "")}</p>
                            <Button className="mt-4" icon={<RotateCcw className="size-4" />} onClick={() => void runStitch()}>
                                {uiText("重新处理")}</Button>
                        </div>
                    ) : (
                        <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-dashed border-border">
                            <Grid2x2 className="mb-4 size-12 text-muted-foreground" />
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={uiText("先上传花纹图片，选择模型并调整参数，再点击开始无缝拼接")} />
                        </div>
                    )}
                    </div>
                {resultView === "history" ? <aside className="stitch-history-panel">
                    <GenerationAccountHistory board="seamless-stitch" />
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div>
                            <h2 className="text-base font-semibold">{uiText("历史出图")}</h2>
                            <p className="mt-1 text-xs text-muted-foreground">{uiText("最近 20 条无缝拼接任务")}</p>
                        </div>
                        <Tag>{history.length}</Tag>
                    </div>
                    {historyLoading ? <p role="status" className="py-8 text-center text-xs text-muted-foreground">{uiText("正在加载历史…")}</p> : null}
                    {historyError ? <div role="alert" className="mb-3 text-xs leading-5 text-muted-foreground">{historyError}<Button size="small" className="mt-2" onClick={() => void refreshHistory()}>{uiText("重试")}</Button></div> : null}
                    {history.length ? (
                        <div className="space-y-3">
                            {history.map((task) => {
                                const imageUrl = task.resultUrls[0];
                                const time = `${formatBeijingTime(task.createdAt)} ${uiText("北京时间")}`;
                                return (
                                    <article key={task.id} className="overflow-hidden rounded-lg border border-border bg-muted">
                                        {task.status === "success" && imageUrl ? <button type="button" className="block w-full" onClick={() => void openHistoryTask(task)} aria-label={uiText("查看处理结果")}><WorkbenchImage loading="lazy" decoding="async" src={imageUrl} alt={uiText("无缝拼接历史结果")} className="aspect-[4/3] w-full object-contain transition hover:opacity-80" /></button> : (
                                            <div className="flex aspect-square flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
                                                {task.status === "processing" ? <LoaderCircle className="size-5 animate-spin text-orange-500" /> : <Grid2x2 className="size-5 text-red-400" />}
                                                <span>{task.status === "processing" ? uiText("正在等待内部 AI 返回") : task.failureReason || uiText("处理失败")}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                                            <span className={task.status === "success" ? "text-emerald-600" : task.status === "processing" ? "text-orange-600" : "text-red-500"}>{task.status === "success" ? uiText("已完成") : task.status === "processing" ? uiText("处理中") : uiText("失败")}</span>
                                            <div className="flex items-center gap-2">
                                                {task.status === "success" && imageUrl ? <><button type="button" className="text-muted-foreground hover:text-orange-600" onClick={() => void openHistoryTask(task)}>{uiText("查看")}</button><button type="button" className="text-muted-foreground hover:text-orange-600" onClick={() => saveAs(imageUrl, `seamless-stitch-${task.id.slice(0, 8)}.png`)}>{uiText("下载")}</button></> : null}
                                                <span className="text-muted-foreground">{time}</span>
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="flex min-h-48 flex-col items-center justify-center text-center">
                            <Grid2x2 className="mb-3 size-8 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">{uiText("提交后的任务会保留在这里")}</p>
                        </div>
                    )}
                </aside> : null}
                </section>
            </main>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                    void uploadSource(event.target.files);
                    event.target.value = "";
                }}
            />
            <AssetPickerModal open={workspaceActive && assetPickerOpen} defaultTab="my-assets" selectionMode="single-image" onInsert={insertAsset} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

function ParameterField({ label, value, min = 1, max = 2_000, step = 1, disabled, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; onChange: (value: number | null) => void }) {
    useUiText();
    return <label className="min-w-0"><span className="mb-2 block text-xs font-medium text-foreground">{label}</span><InputNumber className="w-full" value={value} min={min} max={max} step={step} disabled={disabled} onChange={onChange} /></label>;
}

function updateParameter(setParameters: React.Dispatch<React.SetStateAction<SeamlessStitchParameters>>, setPreset: React.Dispatch<React.SetStateAction<StitchPreset>>, key: keyof SeamlessStitchParameters, value: number | null) {
    if (value === null || !Number.isFinite(value)) return;
    setPreset("custom");
    setParameters((current) => ({ ...current, [key]: value }));
}

function readSeamlessParameters(searchParams: URLSearchParams): SeamlessStitchParameters {
    const preset = searchParams.get("preset") === "small" ? SEAMLESS_PRESETS.small : SEAMLESS_PRESETS.large;
    return {
        cutWidth: readNumber(searchParams.get("cutWidth"), preset.cutWidth, 1, 2_000),
        redrawWidth: readNumber(searchParams.get("redrawWidth"), preset.redrawWidth, 1, 2_000),
        blurAmount: readNumber(searchParams.get("blurAmount"), preset.blurAmount, 1, 2_000),
        redrawStrength: readNumber(searchParams.get("redrawStrength"), preset.redrawStrength, 0, 1),
        steps: readNumber(searchParams.get("steps"), preset.steps, 1, 100),
    };
}

function readTemplateParameters(value: Record<string, unknown>): SeamlessStitchParameters | null {
    const parsed = {
        cutWidth: value.cutWidth,
        redrawWidth: value.redrawWidth,
        blurAmount: value.blurAmount,
        redrawStrength: value.redrawStrength,
        steps: value.steps,
    };
    return Object.values(parsed).every((item) => typeof item === "number") ? parsed as SeamlessStitchParameters : null;
}

function matchesPreset(parameters: SeamlessStitchParameters, preset: SeamlessStitchParameters) {
    return Object.entries(preset).every(([key, value]) => parameters[key as keyof SeamlessStitchParameters] === value);
}

function readNumber(value: string | null, fallback: number, min: number, max: number) {
    if (value === null || value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
