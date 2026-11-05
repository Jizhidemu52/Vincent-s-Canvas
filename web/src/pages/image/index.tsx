import { uiText, useUiText, getUiLocale } from "@/lib/i18n";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { PromptOptimizeButton } from "@/components/prompt-optimize-button";
import type { PromptInputData, PromptScene } from "../../../../shared/prompt-contracts";
import { ArrowLeft, ArrowRight, BookmarkPlus, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, Share2, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { handleSubmitShortcut } from "@/lib/submit-shortcut";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { saveAs } from "file-saver";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { GenerationElapsed } from "@/components/generation-elapsed";
import { GenerationQueueProgress } from "@/components/generation-queue-progress";
import { upsertGenerationLog } from "@/lib/generation-log-update";
import { deleteHistoryEntries } from "@/lib/history-batch-delete";
import { useGenerationDraft } from "@/hooks/use-generation-draft";
import { useImageDrop } from "@/hooks/use-image-drop";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { generationErrorMessage, generationErrorDiagnostic, shouldConfirmPromptReuse } from "@/lib/generation-feedback";
import { GenerationDiagnostic } from "@/components/generation-diagnostic";
import { useResultCanvas } from "@/hooks/use-result-canvas";
import { GenerationTaskCancel } from "@/components/generation-task-cancel";
import { useGenerationWorkspace } from "@/hooks/use-generation-workspace";
import { useImageCopyEditor } from "@/hooks/use-image-copy-editor";
import { useImagePreview } from "@/hooks/use-image-preview";
import { imageCopyEditorNode } from "@/lib/image-edit-copy";
import { canvasImageDownloadFileName, canvasImageReferenceIdentity } from "@/lib/canvas/canvas-image-filename";
import { workbenchSubmissions } from "@/lib/submission-gate";
import { ReferenceImageTray } from "@/components/reference-images/reference-image-tray";
import { ModelPicker } from "@/components/model-picker";
import { useToolConfig } from "@/hooks/use-tool-config";
import { requireToolKey } from "@/services/api/tool-runtime";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { pastedImageFiles, readClipboardImages } from "@/lib/clipboard-images";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { toolModeOperation, type AdminToolMode } from "@/lib/admin-domain";
import { createImageReferenceItem, dedupeImageReferences, validateImageReferences } from "@/lib/image-reference-policy";
import { modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { fetchServerAssetContent, recordServerAssetEvent } from "@/services/api/server-assets";
import { useAssetStore } from "@/stores/use-asset-store";
import type { ImageReferenceItem, ImageReferenceOrigin, ReferenceImage } from "@/types/image";
import { hydrateImageLogMedia } from "./image-log-media";
import { partitionImageLogs } from "./image-log-scope";
import { getQueuedTask, getQueuedTaskByRequestId, recoverQueuedTask, waitForTasks, QueuedTaskFailedError, QueuedTaskPausedError, QueuedTaskSubmissionUncertainError } from "@/services/api/generation-tasks";
import { TaskObservationStoppedError } from "@/services/api/task-observation";
import { findPendingImageTask, pendingImagesForWorkspace, snapshotImageRequest, updateImageResultForRecord, type PendingImage, type ImageRequestSnapshot } from "./image-pending";
import { classifyTaskRecovery, submissionInvestigationMessage, watchTaskReconciliation } from "@/services/api/task-result-reconciliation";
import { restoreGenerationDraft } from "@/services/api/generation-history";
import { ImageLogThumbnail } from "./image-log-thumbnail";
import { GarmentRecipePanel } from "../creative/garment-recipe-panel";
import { garmentReferencesMatch, type GarmentRecipe } from "@/lib/garment-recipe";
import { CREATIVE_REQUIREMENT_PLACEHOLDER, type CreativePreset } from "@/lib/creative-presets";
import "./image-workbench.css";
const SeamlessStitchPage = lazy(() => import("@/pages/image/seamless-stitch").then(module => ({ default: module.SeamlessStitchPage })));
const CanvasImageEditorDialog = lazy(() => import("@/components/canvas/canvas-image-editor-dialog").then(module => ({ default: module.CanvasImageEditorDialog })));
import { hydratePromptReuse, savePromptFromTask } from "@/services/api/prompts";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { useDesignLibraryShare } from "@/pages/design-library/use-design-library-share";
import { consumePlacementAiHandoff, placementDraftScope, placementHandoffToken } from "@/pages/design-workbench/local/placement/ai-handoff";
import { PracticeExampleRecord } from "@/components/design-examples";
import { isQuickImageTool, QUICK_IMAGE_MODEL } from "@/lib/quick-image-tools";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
    sourceTaskId?: string;
    imageName?: string;
    imageVersion?: number;
    imageOriginId?: string;
    prompt?: string;
    userInput?: PromptInputData;
    optimized?: boolean;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "paused";
    image?: GeneratedImage;
    error?: string;
    diagnostic?: string;
    recovery?: PendingImage;
    snapshot?: ImageRequestSnapshot;
    createdAt?: number;
    taskId?: string;
    requestId?: string;
};

type GenerationLog = {
    id: string;
    ownerId?: string;
    tool?: string;
    createdAt: number;
    title: string;
    prompt: string;
    userInput?: PromptInputData;
    optimized?: boolean;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count" | "imageOptions">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

import { imageModelProfile, normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";

const LOG_STORE_KEY = "wireless-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = createWorkspaceStorage("image_generation_logs");
const creativeLogStore = createWorkspaceStorage("creative_generation_logs");
const pendingImageStore = createWorkspaceStorage("image_pending_tasks");
// Saved results notify only the matching employee/tool workspace.
const imageLogListeners = new Set<(log: GenerationLog, preserveView?: boolean) => void>();
// A remounted workspace may observe the same completed task while its original
// view is still importing the image. Share only that in-flight commit lifetime.
const imageResultCommits = new Map<string, { stopped: boolean; record: PendingImage; promise?: Promise<GeneratedImage> }>();

type GenerationToolMode = Exclude<AdminToolMode, "gpt-chat" | "batch-image-edit" | "seamless-stitch">;

const imageToolModes: Record<GenerationToolMode, { title: string; description: string; placeholder: string; button: string; projectId: string; requiresReference: boolean }> = {
    "remove-background": { title: "一键去背景", description: "上传一张原图，自动去除背景并导出透明 PNG，保留主体与原图。", placeholder: "", button: "一键去背景", projectId: "tool-remove-background", requiresReference: true },
    "hd-upscale": { title: "高清放大", description: "上传一张原图，使用 Nano 2.1 提升清晰度并输出 4K 图片，原图保持不变。", placeholder: "", button: "高清放大", projectId: "tool-hd-upscale", requiresReference: true },
    "midjourney-blend": {
        title: "MJ 多图融合",
        description: "上传 2–4 张参考图进行融合，不使用提示词。可独立调整生成速度、布局与自由比例。",
        placeholder: "",
        button: "开始融合",
        projectId: "tool-midjourney-blend",
        requiresReference: true,
    },
    "image-generation": {
        title: "图像生成",
        description: "用提示词生成新图片，生成记录会进入后台历史与额度账本。",
        placeholder: "描述画面主体、风格、构图、光线和用途",
        button: "开始生成",
        projectId: "image-workbench",
        requiresReference: false,
    },
    "detail-enhance": {
        title: "细节增强",
        description: "上传需要增强的原图，按后台放大/增强价格规则预估并记录消耗。",
        placeholder: "描述需要增强的细节、材质、清晰度和保留要求",
        button: "开始增强",
        projectId: "tool-detail-enhance",
        requiresReference: true,
    },
    "image-edit": {
        title: "图片编辑",
        description: "基于参考图做局部编辑、替换、修复或风格调整。",
        placeholder: "描述要编辑的位置、保留内容和希望得到的结果",
        button: "开始编辑",
        projectId: "tool-image-edit",
        requiresReference: true,
    },
    "angle-control": {
        title: "角度控制",
        description: "围绕产品或角色生成指定视角，记录为局部编辑类操作，便于后台审计。",
        placeholder: "描述目标角度，例如正面、侧面、俯视、三视图或 45 度视角",
        button: "生成角度图",
        projectId: "tool-angle-control",
        requiresReference: true,
    },
};

function resolveImageToolMode(value: string | null): GenerationToolMode {
    if (value === "detail-enhance" || value === "image-edit" || value === "angle-control" || value === "midjourney-blend" || value === "remove-background" || value === "hd-upscale") return value;
    return "image-generation";
}

export default function ImagePage() {
    useUiText();
    const [searchParams] = useSearchParams();
    return searchParams.get("tool") === "seamless-stitch" ? <Suspense fallback={<div className="wb-page wb-empty" role="status">{uiText("正在打开无缝拼接…")}</div>}><SeamlessStitchPage /></Suspense> : <ImageGenerationPage />;
}

export function ImageGenerationPage({ creativePreset }: { creativePreset?: CreativePreset } = {}) {
    useUiText();
    const [searchParams] = useSearchParams();
    const { pathname } = useLocation();
    const ownerId = useUserStore(state => state.user?.id);
    const historyTool = creativePreset ? `creative-${creativePreset.id}` : resolveImageToolMode(pathname === "/remove-background" ? "remove-background" : pathname === "/hd-upscale" ? "hd-upscale" : searchParams.get("tool"));
    const placementToken = placementHandoffToken(searchParams, historyTool);
    return <ImageGenerationWorkspace key={JSON.stringify([ownerId, historyTool, placementToken])} creativePreset={creativePreset} historyTool={historyTool} />;
}

function ImageGenerationWorkspace({ creativePreset, historyTool }: { creativePreset?: CreativePreset; historyTool: string }) {
    useUiText();
    const quickTool = isQuickImageTool(historyTool);
    const { message, modal } = App.useApp();
    const libraryShare = useDesignLibraryShare();
    const resultCanvas = useResultCanvas();
    const [searchParams] = useSearchParams();
    const placementToken = placementHandoffToken(searchParams, historyTool);
    const inputDraftScope = placementToken ? placementDraftScope(placementToken) : historyTool;
    const [placementStatus, setPlacementStatus] = useState<"loading" | "ready" | "error">(placementToken ? "loading" : "ready");
    const [placementError, setPlacementError] = useState("");
    const [placementAttempt, setPlacementAttempt] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const loadedRecreateAssetsRef = useRef(new Set<string>());
    const loadedReuseTokenRef = useRef(new Set<string>());
    const generateRef = useRef<() => Promise<void>>(async () => undefined);
    const restoredInitialResultRef = useRef(false);
    const pendingRestoreRevision = useRef(0);
    const removedPendingIds = useRef(new Set<string>());
    const resultViewPinnedRef = useRef(false);
    const inputRevision = useRef(0);
    const previewRevision = useRef(0);
    const logRefreshRevision = useRef(0);
    const {
        logs, setLogs, running, setRunning, startedAt, setStartedAt, activeTaskId, setActiveTaskId,
        previewLoading, setPreviewLoading, logsOpen, setLogsOpen, settingsOpen, setSettingsOpen,
        promptDialogOpen, setPromptDialogOpen, assetPickerOpen, setAssetPickerOpen,
        selectedLogIds, setSelectedLogIds, previewLog, setPreviewLog, deleteConfirmOpen, setDeleteConfirmOpen,
        deletingLogs, deleteSelectedHistory,
    } = useGenerationWorkspace<ImageReferenceItem, GenerationLog>();
    const [deleteLogIds, setDeleteLogIds] = useState<string[]>([]);
    const restoreBusy = useRef(false);
    const [restoringHistory, setRestoringHistory] = useState(false);
    const defaults = useEffectiveConfig();
    const [draftConfig, setDraftConfig, configReady] = useGenerationDraft<Partial<AiConfig>>(`${inputDraftScope}:settings`, {});
    const baseConfig = { ...defaults, ...draftConfig };
    const config = baseConfig;
    const [references, setReferences, referencesReady] = useGenerationDraft<ImageReferenceItem[]>(`${inputDraftScope}:references`, [], async items => Promise.all(items.map(async item => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) }))));
    const toolKey = requireToolKey(historyTool === "detail-enhance" || historyTool === "hd-upscale" ? "upscale" : historyTool === "image-generation" || historyTool === "midjourney-blend" || historyTool === "creative-text-to-style" ? "image_generation" : "inpaint", historyTool === "remove-background" ? "image-edit" : historyTool === "hd-upscale" ? "detail-enhance" : historyTool);
    const businessModels = useBusinessConfigStore(state => state.models);
    const blendModels = businessModels.filter(item => item.imageParameterProfile === "blend" || item.imageParameterProfile === "midjourney-blend" || item.modelId === "midjourney-blend");
    const baseImageModel = baseConfig.imageModel || baseConfig.model;
    const selectedImageModel = historyTool === "midjourney-blend"
        ? (blendModels.find(item => item.modelId === baseImageModel || item.id === baseImageModel) || blendModels[0])?.modelId || ""
        : baseImageModel;
    const managedConfig = useToolConfig({ ...baseConfig, model: selectedImageModel, imageModel: selectedImageModel }, toolKey);
    const effectiveConfig = quickTool ? { ...baseConfig, model: QUICK_IMAGE_MODEL, imageModel: QUICK_IMAGE_MODEL, count: "1", size: "auto", quality: historyTool === "hd-upscale" ? "4K" : "2K", imageOptions: "", systemPrompt: "" } : managedConfig;
    const updateConfig: UpdateAiConfig = useCallback((key, value) => setDraftConfig(current => current[key] === value ? current : { ...current, [key]: value }), [setDraftConfig]);
    const updateInputConfig: UpdateAiConfig = (key, value) => { inputRevision.current += 1; updateConfig(key, value); };
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canManageConfig = useCanManageConfig();
    const user = useUserStore((state) => state.user);
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const [optimizedDraft, setOptimizedDraft] = useState<{ prompt: string; input: PromptInputData; references: ReferenceImage[]; context?: string }>();
    const [prompt, setPrompt, promptReady] = useGenerationDraft(`${inputDraftScope}:prompt`, creativePreset?.prompt || "");
    const historyStore = creativePreset ? creativeLogStore : logStore;
    const [results, setResults] = useState<GenerationResult[]>([]);
    const imageEditor = useImageCopyEditor((copy, image) => {
        pendingRestoreRevision.current += 1;
        setResults(current => current.some(result => result.id === copy.assetId) ? current : [...current, { id: copy.assetId, status: "success", image: {
            id: copy.assetId, dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType, durationMs: 0,
            imageName: copy.node.metadata?.imageName, imageVersion: copy.node.metadata?.imageVersion, imageOriginId: copy.originId,
            prompt: copy.node.metadata?.prompt,
        } }]);
    });
    const [unclassifiedLogs, setUnclassifiedLogs] = useState<GenerationLog[]>([]);
    const mountedRef = useRef(false);
    const activeSubmissionRef = useRef(false);
    const observationControllers = useRef(new Set<AbortController>());
    const manuallyStoppedIds = useRef(new Set<string>());
    const observationStopRequested = useRef(false);
    const finishingImages = useRef(imageResultCommits);
    const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
    const latestPendingImages = useRef(pendingImages);
    latestPendingImages.current = pendingImages;
    const submitToolbarRef = useRef<HTMLDivElement>(null);
    const [submitToolbarHeight, setSubmitToolbarHeight] = useState(190);
    const [referenceAssetPickerOpen, setReferenceAssetPickerOpen] = useState(false);
    const [readingReferences, setReadingReferences] = useState(false);
    const [referenceScope, setReferenceScope] = useState(0);
    const referenceScopeRef = useRef(referenceScope);
    referenceScopeRef.current = referenceScope;
    useUnsavedGuard(readingReferences, uiText("参考图正在读取，离开可能中断上传。"));
    const [garmentEpoch, setGarmentEpoch] = useState(0);
    const [garmentDraft, setGarmentDraft] = useState<{ scope: string; dirty: boolean; appliedReferences: ReferenceImage[] | null } | null>(null);

    const toolMode = creativePreset?.tool || resolveImageToolMode(historyTool);
    const initialGarmentScenario = creativePreset?.garment;
    const garmentScope = `${user?.id || ""}:${toolMode}:${initialGarmentScenario || ""}:${garmentEpoch}`;
    const activeGarmentDraft = toolMode === "image-edit" && garmentDraft?.scope === garmentScope ? garmentDraft : null;
    const garmentNeedsApply = Boolean(activeGarmentDraft && (activeGarmentDraft.dirty || (activeGarmentDraft.appliedReferences && !garmentReferencesMatch(activeGarmentDraft.appliedReferences, references))));
    const incompleteCreativePrompt = Boolean(creativePreset && prompt.includes(CREATIVE_REQUIREMENT_PLACEHOLDER));
    const resetGarment = useCallback(() => {
        setGarmentEpoch(value => value + 1);
        setGarmentDraft(null);
    }, []);
    const replacePrompt = (text: string) => { inputRevision.current += 1; resetGarment(); setPrompt(text); };
    const reusePrompt = (next: string) => {
        if (!shouldConfirmPromptReuse(prompt, next)) { replacePrompt(next); return; }
        modal.confirm({ title: uiText("替换当前草稿？"), content: uiText("当前提示词已有内容，复用将替换现有输入；浏览结果不会更改草稿。"), okText: uiText("确认替换"), cancelText: uiText("保留草稿"), onOk: () => replacePrompt(next) });
    };
    const handleGarmentDraftChange = useCallback((dirty: boolean) => {
        if (dirty) inputRevision.current += 1;
        setGarmentDraft(current => ({ scope: garmentScope, dirty, appliedReferences: current?.scope === garmentScope ? current.appliedReferences : null }));
    }, [garmentScope]);
    const applyGarmentRecipe = (recipe: GarmentRecipe) => {
        inputRevision.current += 1;
        setPrompt(recipe.prompt);
        setOptimizedDraft({ prompt: recipe.prompt, input: recipe.promptInput, references: recipe.references });
        setReferences(recipe.references.map(item => references.find(reference => reference.id === item.id) || createImageReferenceItem(item, "template")));
        setGarmentDraft({ scope: garmentScope, dirty: false, appliedReferences: recipe.references });
        message.success(uiText("已套用到提示词；检查后点击开始编辑"));
    };
    const toolModeConfig = creativePreset ? { ...imageToolModes[toolMode], title: creativePreset.title, description: creativePreset.description, projectId: `creative-${creativePreset.id}` } : imageToolModes[toolMode];
    const operationType = toolModeOperation(toolMode) as "image_generation" | "inpaint" | "upscale";
    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const optimizationContext = JSON.stringify([model, operationType, toolKey]);
    useEffect(() => {
        setOptimizedDraft(current => !current?.input.compilationId || current.context === optimizationContext ? current
            : current.input.scene === "free-optimize" ? undefined : { ...current, input: { ...current.input, compilationId: undefined } });
    }, [optimizationContext]);
    const adminModelId = modelOptionName(model);
    const selectedModelProfile = useImageModelProfile(adminModelId);
    // The dedicated entry keeps its input contract even before a model is configured.
    const isBlend = !quickTool && (historyTool === "midjourney-blend" || selectedModelProfile.kind === "midjourney-blend");
    const requiresPrompt = !isBlend && !quickTool;
    const generationCount = quickTool ? 1 : Number(normalizeImageModelSettings(config, selectedModelProfile).count);
    const modelReferenceValidation = validateImageReferences(adminModelId, references, isBlend ? { ...selectedModelProfile, kind: "midjourney-blend" } : selectedModelProfile);
    const referenceValidation = quickTool && references.length > 1 ? { ...modelReferenceValidation, valid: false, message: uiText("请只添加一张原图") } : modelReferenceValidation;
    const estimatedUsage = estimate({ operationType, toolKey, modelId: adminModelId, quantity: generationCount });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimatedUsage.configured && user.creditBalance < estimatedUsage.credits);
    const missingReference = !isBlend && toolModeConfig.requiresReference && references.length === 0;
    const invalidBlendReferences = isBlend && (references.length < 2 || references.length > 4);
    const draftReady = configReady && referencesReady && promptReady;
    const canGenerate = draftReady && placementStatus === "ready" && !(quickTool && pendingImages.length) && !(placementToken && isBlend) && !readingReferences && !optimizingPrompt && Boolean(model) && Boolean(user && user.status === "active") && (!requiresPrompt || Boolean(prompt.trim())) && !quotaBlocked && !missingReference && !invalidBlendReferences && referenceValidation.valid && !garmentNeedsApply && !incompleteCreativePrompt;

    const appendReferences = (items: ReferenceImage[], origin: ImageReferenceOrigin) => { inputRevision.current += 1; setReferences((value) => dedupeImageReferences([...value, ...items.map((item) => createImageReferenceItem(item, origin))])); };
    const restoreReferences = (items: ReferenceImage[], origin: ImageReferenceOrigin = "template") => { inputRevision.current += 1; setReferences(dedupeImageReferences(items.map((item) => createImageReferenceItem(item, origin)))); };

    const handleMissingModelConfig = () => {
        if (canManageConfig) {
            message.warning(uiText("请先完成配置"));
            openConfigDialog(true);
            return;
        }
        message.warning(uiText("当前没有可用模型，请联系管理员统一配置模型和 API"));
    };

    useEffect(() => {
        let active = true;
        const restoreRevision = pendingRestoreRevision.current;
        mountedRef.current = true;
        const onSaved = (log: GenerationLog, preserveView = false) => {
            if (log.ownerId !== user?.id || log.tool !== historyTool) return;
            logRefreshRevision.current += 1;
            setLogs(current => upsertGenerationLog(current, log));
            if (preserveView && log.images.length) {
                removedPendingIds.current.add(log.id);
                setPendingImages(current => current.filter(record => record.id !== log.id));
                setResults(current => updateImageResultForRecord(current, log, { status: "success", image: log.images[0], recovery: undefined, error: undefined }));
            }
            if (!preserveView && !activeSubmissionRef.current && !resultViewPinnedRef.current && log.images.length) {
                pendingRestoreRevision.current += 1;
                previewRevision.current += 1;
                restoredInitialResultRef.current = true;
                setResults(log.images.map(image => ({ id: image.id, status: "success", image })));
            }
        };
        imageLogListeners.add(onSaved);
        void refreshLogs();
        const pending: PendingImage[] = [];
        void pendingImageStore.iterate<PendingImage, void>(value => { pending.push(value); }).then(() => {
            // StrictMode can replay this effect while its first IndexedDB read
            // is still pending. A per-effect lifetime rejects that stale read.
            if (!active || !mountedRef.current) return;
            const records = pendingImagesForWorkspace(pending, user?.id || "", historyTool).filter(record => !removedPendingIds.current.has(record.id));
            setPendingImages(current => [...records.filter(record => !current.some(item => item.id === record.id)), ...current]);
            // Restore only the untouched initial view. A slow browser database
            // must not replace a task or preview the user has started meanwhile.
            if (records.length && restoreRevision === pendingRestoreRevision.current && !activeSubmissionRef.current && !resultViewPinnedRef.current) {
                restoredInitialResultRef.current = true;
                setResults(records.map(record => ({ id: record.id, status: "paused", error: record.recovery === "investigate" ? submissionInvestigationMessage : record.stopped ? "已停止本页查询；可手动刷新原任务状态。" : "已找回原任务，正在核对已有结果，不会重新生成", recovery: record, snapshot: record.snapshot })));
            }
        }).catch(error => { if (active && mountedRef.current) message.warning(uiText("在途记录读取失败：{value1}", { value1: error instanceof Error ? error.message : "浏览器存储不可用" })); });
        return () => { active = false; mountedRef.current = false; for (const controller of observationControllers.current) controller.abort(); imageLogListeners.delete(onSaved); logRefreshRevision.current += 1; };
    }, []);

    useEffect(() => {
        if (restoredInitialResultRef.current || running || !logs.length || results.length) return;
        restoredInitialResultRef.current = true;
        const latest = logs.find((log) => log.status === "成功" && log.images.length);
        if (!latest) return;
        const revision = ++previewRevision.current;
        void hydrateImageLogMedia(latest, resolveImageUrl, false).then(log => {
            if (revision === previewRevision.current) setResults(log.images.map(image => ({ id: image.id, status: "success", image })));
        }).catch(() => undefined);
    }, [logs, results.length, running]);

    useEffect(() => () => { previewRevision.current += 1; }, []);

    useEffect(() => {
        inputRevision.current += 1;
        previewRevision.current += 1;
        setPreviewLoading(false);
        return () => { inputRevision.current += 1; previewRevision.current += 1; };
    }, [searchParams, user?.id]);

    useEffect(() => {
        loadedRecreateAssetsRef.current.clear();
        loadedReuseTokenRef.current.clear();
    }, [user?.id]);

    useEffect(() => { resetGarment(); }, [toolMode, user?.id, initialGarmentScenario, resetGarment]);

    useEffect(() => {
        if (!placementToken) return;
        let active = true;
        setPlacementStatus("loading");
        setPlacementError("");
        void consumePlacementAiHandoff(placementToken).then(payload => {
            if (!active) return;
            replacePrompt(payload.prompt);
            restoreReferences(payload.references, "upload");
            setDraftConfig(payload.settings);
            setPlacementStatus("ready");
        }).catch(error => {
            if (!active) return;
            setPlacementError(error instanceof Error ? error.message : "定位参考图带入失败，请重试。");
            setPlacementStatus("error");
        });
        return () => { active = false; };
    }, [placementToken, placementAttempt]);

    useEffect(() => {
        if (placementToken) return;
        const presetPrompt = searchParams.get("prompt");
        const presetModel = searchParams.get("model");
        if (presetPrompt) replacePrompt(presetPrompt);
        if (presetModel) updateConfig("imageModel", presetModel);
    }, [searchParams, updateConfig]);

    useEffect(() => {
        if (placementToken) return;
        const sourceAssetId = searchParams.get("sourceAssetId");
        if (!sourceAssetId || loadedRecreateAssetsRef.current.has(sourceAssetId)) return;
        loadedRecreateAssetsRef.current.add(sourceAssetId);
        const revision = inputRevision.current;
        let restored = false;
        void fetchServerAssetContent(sourceAssetId)
            .then(async (blob) => {
                if (revision !== inputRevision.current) return;
                const image = await uploadImage(blob);
                if (revision !== inputRevision.current) return;
                restored = true;
                appendReferences([{ id: nanoid(), name: "复刻来源.png", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, sourceAssetId }], "asset");
                const eventType = searchParams.get("sourceOwnerId") === user?.id ? "asset.edited" : "asset.reused";
                await recordServerAssetEvent(sourceAssetId, eventType, { channel: "one-click-recreate", destination: toolMode });
                message.success(uiText("已带入原素材、提示词和模型"));
            })
            .catch((error) => {
                loadedRecreateAssetsRef.current.delete(sourceAssetId);
                if (revision !== inputRevision.current) return;
                message.error(error instanceof Error ? uiText(error.message) : uiText("复刻来源加载失败"));
            });
        return () => { if (!restored) loadedRecreateAssetsRef.current.delete(sourceAssetId); };
    }, [message, searchParams, toolMode, user?.id]);

    useEffect(() => {
        if (placementToken) return;
        const token = searchParams.get("reuseToken");
        if (!token || loadedReuseTokenRef.current.has(token)) return;
        loadedReuseTokenRef.current.add(token);
        const revision = inputRevision.current;
        let restored = false;
        void hydratePromptReuse(token).then(async (payload) => {
            if (revision !== inputRevision.current) return;
            const nextReferences = await Promise.all(payload.template.referenceAssetIds.map(async (assetId) => {
                const blob = await fetchServerAssetContent(assetId);
                if (revision !== inputRevision.current) return null;
                const image = await uploadImage(blob);
                return { id: nanoid(), name: "模板参考图.png", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, sourceAssetId: assetId };
            }));
            if (revision !== inputRevision.current) return;
            // Apply a complete prompt/reference set in the same render, never half a template.
            restored = true;
            replacePrompt(payload.template.prompt);
            restoreReferences(nextReferences.filter((item): item is NonNullable<typeof item> => item !== null), "template");
            const parameters = payload.template.parameters;
            const selectedModel = payload.pricing.selectedModel?.modelId;
            if (selectedModel) updateConfig("imageModel", selectedModel);
            const settings = promptImageSettings(parameters, selectedModel || effectiveConfig.model);
            for (const key of ["size", "quality", "count", "imageOptions"] as const) updateConfig(key, settings[key]);
            payload.warnings.forEach((warning) => message.warning(uiText(warning)));
            if (payload.pricing.modelChanged) message.warning(payload.pricing.selectedModel ? uiText("模型已变更，当前使用 {name}", { name: payload.pricing.selectedModel.name }) : uiText("模型已变更，请先选择管理员当前启用的模型"));
            const cost = !deploymentFeatures.creditsEnabled ? "不计积分" : (payload.pricing.estimate ? `${payload.pricing.estimate.totalCredits} 积分` : "以当前选择为准");
            if (payload.mode === "fill_and_generate") {
                modal.confirm({ title: uiText("确认使用当前配置生成？"), content: !deploymentFeatures.creditsEnabled ? uiText("确认后将直接提交生成任务。") : uiText("当前实际预计消耗 {cost}。确认后才会提交任务并扣费。", { cost: cost }), okText: uiText("确认生成"), cancelText: uiText("仅保留填入"), onOk: () => generateRef.current() });
            } else message.success(uiText("模板已填入，当前预计 {cost}", { cost: cost }));
        }).catch((error) => { loadedReuseTokenRef.current.delete(token); if (revision === inputRevision.current) message.error(error instanceof Error ? uiText(error.message) : uiText("模板复用失败")); });
        return () => { if (!restored) loadedReuseTokenRef.current.delete(token); };
    }, [message, modal, searchParams, updateConfig, user?.id]);

    const addReferences = async (files?: FileList | File[] | null) => {
        if (readingReferences || !files?.length) return;
        const scope = referenceScopeRef.current;
        const stillCurrent = () => mountedRef.current && referenceScopeRef.current === scope;
        setReadingReferences(true);
        try {
        const imageFiles = Array.from(files || []);
        if (imageFiles.some(file => !file.type.startsWith("image/"))) throw new Error("请选择图片文件，其他格式无法作为参考图。");
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        if (!stillCurrent()) return;
        appendReferences(nextReferences, "upload");
        message.success(uiText("参考图已添加"));
        } catch (error) { if (stillCurrent()) message.error(uiText(generationErrorMessage(error))); }
        finally { if (mountedRef.current) setReadingReferences(false); }
    };

    const addReferencesFromClipboard = async () => {
        if (readingReferences) return;
        setReadingReferences(true);
        try {
            const blobs = await readClipboardImages(navigator.clipboard);
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            appendReferences(nextReferences, "clipboard");
            message.success(uiText("已读取 {length} 张参考图", { length: nextReferences.length }));
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("剪贴板图片读取失败"));
        } finally { setReadingReferences(false); }
    };

    const generate = async () => {
        if (quickTool && latestPendingImages.current.length) { message.warning(uiText("原任务状态待核查，请先刷新原任务状态")); return; }
        if (placementStatus !== "ready") {
            message.warning(uiText("请先完成定位参考图带入，再提交生成。"));
            return;
        }
        if (placementToken && isBlend) {
            message.warning(uiText("定位效果需要位置保持提示词，请选择支持文字要求的图片编辑模型。"));
            return;
        }
        const text = prompt.trim();
        if (!text && requiresPrompt) {
            message.error(uiText("请输入生图提示词"));
            return;
        }
        if (missingReference) {
            message.error(uiText("{title}需要先添加参考图", { title: uiText(toolModeConfig.title) }));
            return;
        }
        if (!user || user.status !== "active") {
            message.error(uiText("当前设计师账号不可用"));
            return;
        }
        if (quotaBlocked) {
            message.error(uiText("额度不足：预计需要 {credits} 积分，当前剩余 {creditBalance} 积分", { credits: estimatedUsage.credits, creditBalance: user.creditBalance }));
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;

        const release = workbenchSubmissions.acquire(`image:${user.id}`);
        if (!release) { message.info(uiText("图片任务正在处理，请勿重复提交")); return; }

        pendingRestoreRevision.current += 1;
        observationStopRequested.current = false;
        setRunning(true);
        setActiveTaskId(null);
        activeSubmissionRef.current = true;
        resultViewPinnedRef.current = false;
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending", createdAt: Date.now() })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));

        try {
            const result = await Promise.allSettled(tasks);
            const succeeded = result.filter(item => item.status === "fulfilled").length;
            if (mountedRef.current && succeeded) message.success(uiText("已生成并保存 {succeeded} 张图片", { succeeded: succeeded }));
        } finally {
            release();
            activeSubmissionRef.current = false;
            setRunning(false);
        }
    };
    generateRef.current = generate;

    const resultEditorNode = (image: GeneratedImage, index: number) => imageCopyEditorNode({ ...image, title: image.imageName || `生成结果 ${index + 1}` });

    const openResultEditor = (image: GeneratedImage, index: number) => {
        const sourceLog = logs.find(log => log.images.some(item => item.id === image.id));
        imageEditor.open({ node: resultEditorNode(image, index), originId: image.imageOriginId, sourceTaskId: image.sourceTaskId, prompt: image.prompt ?? sourceLog?.prompt ?? prompt, model: sourceLog?.model || model });
    };

    const selectResultPrompt = (image: GeneratedImage) => {
        const sourceLog = [...logs, ...unclassifiedLogs].find(log => log.images.some(item => item.id === image.id));
        reusePrompt(image.prompt ?? sourceLog?.prompt ?? "");
    };

    const downloadImage = async (image: GeneratedImage, index: number) => {
        try { saveAs(await resolveImageUrl(image.storageKey, image.dataUrl), canvasImageDownloadFileName(resultEditorNode(image, index))); }
        catch (error) { message.error(error instanceof Error ? uiText(error.message) : uiText("原图读取失败")); }
    };

    const shareResultDesign = (image: GeneratedImage, index: number) => {
        const sourceLog = [...logs, ...unclassifiedLogs].find(log => log.images.some(item => item.id === image.id));
        return libraryShare.share({ ownerId: user?.id || "", title: image.imageName ? `${image.imageName}_v${image.imageVersion || 1}` : `生成结果 ${index + 1}`,
            dataUrl: image.dataUrl, storageKey: image.storageKey, filename: canvasImageDownloadFileName(resultEditorNode(image, index)),
            prompt: image.prompt ?? sourceLog?.prompt ?? "", model: sourceLog?.model || "", tags: [] });
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        setReadingReferences(true);
        try {
        const stored = await uploadImage(image.dataUrl);
        appendReferences([{ id: nanoid(), name: image.imageName || `result-${index + 1}.png`, imageName: image.imageName, imageVersion: image.imageVersion, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }], "generated");
        message.success(uiText("已加入参考图"));
        } catch (error) { message.error(uiText(generationErrorMessage(error))); }
        finally { setReadingReferences(false); }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        try {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: image.imageName ? `${image.imageName}_v${image.imageVersion || 1}` : `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: {
                source: "image-page",
                imageName: image.imageName, imageVersion: image.imageVersion || 1,
                module: toolModeConfig.title,
                prompt: image.prompt ?? logs.find(log => log.images.some(item => item.id === image.id))?.prompt ?? "",
                toolMode,
                operationType,
                projectId: toolModeConfig.projectId,
                designerId: user?.id,
                model,
                modelId: adminModelId,
                recreatePath: `/image?tool=${toolMode}&prompt=${encodeURIComponent(image.prompt || "")}&model=${encodeURIComponent(model)}`,
            },
        });
        message.success(uiText("已加入我的素材"));
        } catch (error) { message.error(uiText(generationErrorMessage(error))); }
    };

    const saveResultPrompt = async (image: GeneratedImage) => {
        if (!image.sourceTaskId) {
            message.warning(uiText("旧记录没有服务端任务编号，请先保存到素材库后再保存提示词"));
            return;
        }
        try {
            await savePromptFromTask(image.sourceTaskId);
            message.success(uiText("已保存到我的提示词"));
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("保存提示词失败"));
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        setReadingReferences(true);
        try {
        if (payload.kind === "text") {
            reusePrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            appendReferences([{ id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, imageName: payload.imageName, imageVersion: payload.imageVersion }], "asset");
        } else {
            message.warning(uiText("生图工作台只能使用文本或图片素材"));
        }
        setAssetPickerOpen(false);
        } catch (error) { message.error(uiText(generationErrorMessage(error))); }
        finally { setReadingReferences(false); }
    };

    const createSession = () => {
        referenceScopeRef.current += 1;
        setReferenceScope(referenceScopeRef.current);
        resultViewPinnedRef.current = true;
        restoredInitialResultRef.current = true;
        previewRevision.current += 1;
        setPreviewLoading(false);
        replacePrompt(creativePreset?.prompt || "");
        setReferences([]);
        setResults([]);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const confirmDeleteSelected = () => {
        if (running || deletingLogs) return;
        const ids = logs.filter(log => selectedLogIds.includes(log.id)).map(log => log.id);
        if (!ids.length) return;
        setDeleteLogIds(ids); setLogsOpen(false); setDeleteConfirmOpen(true);
    };

    const deleteSelectedLogs = async () => {
        if (running) return;
        try {
            const deleted = await deleteSelectedHistory(async (selected) => {
                const receipt = await deleteHistoryEntries(selected, log => historyStore.removeItem(log.id));
                const imageKeys = selected.filter(log => receipt.deletedIds.includes(log.id)).flatMap(log => log.images.map(image => image.storageKey).filter((key): key is string => Boolean(key)));
                try { await deleteStoredImages(imageKeys); }
                catch { message.warning(uiText("记录已移除，但部分本地图片文件未能清理。")); }
                return receipt;
            }, deleteLogIds);
            if (deleted?.previewRemoved) setResults([]);
            if (deleted) {
                setDeleteLogIds(deleted.failedIds);
                if (deleted.failedIds.length) message.error(uiText("已删除 {deleted} 条，{failed} 条删除失败；失败记录仍保留并已选中，可重试。", { deleted: deleted.deletedIds.length, failed: deleted.failedIds.length }));
                else message.success(uiText("已删除 {count} 条生成记录", { count: deleted.deletedIds.length }));
            }
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("记录删除失败"));
        }
    };

    const saveLog = async (log: GenerationLog, preserveView = false, assertCurrent = () => {}) => {
        if (quickTool) log = { ...log, title: `${toolModeConfig.title} · ${log.references[0]?.name || "图片"}` };
        assertCurrent();
        if (!user || useUserStore.getState().user?.id !== user.id) throw new Error("员工会话已变化，未写入其他账号的记录");
        const scopedLog = { ...log, ownerId: user.id, tool: historyTool };
        await historyStore.setItem(log.id, serializeLog(scopedLog));
        assertCurrent();
        for (const onSaved of imageLogListeners) onSaved(scopedLog, preserveView);
    };

    const refreshLogs = async () => {
        const revision = ++logRefreshRevision.current;
        try {
            const next = await readStoredLogs(historyStore, { ownerId: user?.id || "", tool: historyTool });
            if (revision === logRefreshRevision.current) { setLogs(next.logs); setUnclassifiedLogs(next.unclassified); }
        } catch (error) {
            if (revision === logRefreshRevision.current) message.error(error instanceof Error ? uiText(error.message) : uiText("历史记录读取失败，请检查浏览器存储"));
        }
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        if (running) return;
        pendingRestoreRevision.current += 1;
        resultViewPinnedRef.current = true;
        const revision = ++previewRevision.current;
        setPreviewLoading(true);
        try {
        const hydrated = await hydrateImageLogMedia(log, resolveImageUrl, false);
        if (revision !== previewRevision.current) return;
        log = hydrated;
        setPreviewLog(log);
        setLogsOpen(false);
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
        } catch (error) {
            if (revision === previewRevision.current) message.error(error instanceof Error ? uiText(error.message) : uiText("生成记录读取失败，请重试"));
        } finally { if (revision === previewRevision.current) setPreviewLoading(false); }
    };

    const restoreHistoryDraft = async () => {
        if (!previewLog || running || restoreBusy.current) return;
        const taskId = previewLog.images.find(image => image.sourceTaskId)?.sourceTaskId;
        if (!taskId) { message.warning(uiText("这条旧记录没有完整输入归档，无法完整恢复；可复制提示词后新建草稿")); return; }
        const settingsBeforeRestore = draftConfig;
        const revision = inputRevision.current;
        const preview = previewRevision.current;
        restoreBusy.current = true; setRestoringHistory(true);
        try {
            const draft = await restoreGenerationDraft(taskId);
            if (draft.maskReferenceIndex !== undefined) throw new Error("历史包含蒙版，请在支持蒙版的原编辑入口恢复；未套用任何输入");
            if (draft.tool && requireToolKey(draft.operationType, draft.tool) !== toolKey) throw new Error(`请先切换到历史原工具“${imageToolModes[draft.tool as GenerationToolMode]?.title || draft.tool}”再恢复，当前草稿未改变`);
            if (revision !== inputRevision.current || preview !== previewRevision.current || settingsBeforeRestore !== draftConfig) throw new Error("草稿或所选记录已改变，已取消恢复");
            replacePrompt(draft.prompt);
            setOptimizedDraft(draft.userInput ? { prompt: draft.prompt, input: { ...draft.userInput, compilationId: undefined }, references: draft.references } : undefined);
            setReferences(draft.references.map(item => createImageReferenceItem(item, "template")));
            updateConfig("imageModel", draft.config.imageModel);
            updateConfig("size", draft.config.size); updateConfig("quality", draft.config.quality);
            updateConfig("imageOptions", draft.config.imageOptions || "");
            updateConfig("count", previewLog.config.count); updateConfig("systemPrompt", draft.config.systemPrompt);
            message.success(uiText("已完整恢复为草稿，可继续修改；尚未生成或扣费，AI 再次生成不保证结果相同"));
        } catch (error) { message.error(error instanceof Error ? uiText(error.message) : uiText("历史恢复失败，当前草稿未改变")); }
        finally { restoreBusy.current = false; setRestoringHistory(false); }
    };

    const buildRequestSnapshot = (): ImageRequestSnapshot | null => {
        previewRevision.current += 1;
        setPreviewLoading(false);
        if (!model) {
            handleMissingModelConfig();
            return null;
        }
        if (garmentNeedsApply || incompleteCreativePrompt) {
            message.warning(garmentNeedsApply ? uiText("服装要求或参考图已改变，请重新套用到提示词") : uiText("请先把提示词中的填写位置替换成你的设计要求"));
            return null;
        }
        const text = prompt.trim();
        if (!text && requiresPrompt) {
            message.error(uiText("请输入生图提示词"));
            return null;
        }
        if (invalidBlendReferences) {
            message.error(uiText("当前合成模型需要 2–4 张参考图。"));
            return null;
        }
        if (!referenceValidation.valid) {
            message.error(uiText(referenceValidation.message || ""));
            return null;
        }
        let promptInput = optimizedDraft?.prompt === text && garmentReferencesMatch(optimizedDraft.references, references) ? optimizedDraft.input
            : creativePreset ? { scene: creativePreset.id as PromptScene, userText: text, fields: {}, mode: operationType === "image_generation" ? "generate" as const : "edit" as const, referenceRoles: references.map(image => image.name) } : undefined;
        if (promptInput?.compilationId && optimizedDraft?.context !== optimizationContext) {
            promptInput = promptInput.scene === "free-optimize" ? undefined : { ...promptInput, compilationId: undefined };
        }
        // Upscaling accepts plain instructions, not the image compiler contract.
        if (operationType === "upscale" || isBlend || quickTool) promptInput = undefined;
        return { text: quickTool ? "" : text || "Blend reference images", promptInput, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const persistPending = async (record: PendingImage) => {
        if (useUserStore.getState().user?.id !== record.ownerId) throw new Error("员工会话已变化，未写入其他账号记录");
        record = { ...record, stopped: record.stopped || manuallyStoppedIds.current.has(record.id) || (activeSubmissionRef.current && observationStopRequested.current) };
        await pendingImageStore.setItem(record.id, record);
        if (useUserStore.getState().user?.id !== record.ownerId) return;
        removedPendingIds.current.delete(record.id);
        if (mountedRef.current) setPendingImages(current => [...current.filter(item => item.id !== record.id), record]);
    };

    const removePending = async (record: PendingImage) => {
        if (useUserStore.getState().user?.id !== record.ownerId) return;
        await pendingImageStore.removeItem(record.id);
        removedPendingIds.current.add(record.id);
        if (mountedRef.current) setPendingImages(current => current.filter(item => item.id !== record.id));
    };

    const finishImage = async (record: PendingImage, image: { id: string; dataUrl: string; sourceTaskId?: string; prompt?: string; optimized?: boolean; userInput?: PromptInputData }) => {
        const commitKey = JSON.stringify([record.ownerId, record.tool, record.id]);
        const existing = finishingImages.current.get(commitKey);
        if (existing?.promise && !existing.stopped) return existing.promise;
        const commit: { stopped: boolean; record: PendingImage; promise?: Promise<GeneratedImage> } = { stopped: false, record };
        const assertCurrent = () => {
            // Leaving a view ends observation, not persistence of an already
            // confirmed result. Explicit stop and employee changes still win.
            if (commit.stopped || manuallyStoppedIds.current.has(record.id) || observationStopRequested.current || useUserStore.getState().user?.id !== record.ownerId) throw new DOMException("结果保存已停止或员工会话已变化", "AbortError");
        };
        const finish = (async () => {
            assertCurrent();
            const stored = await uploadImage(image.dataUrl);
            assertCurrent();
            const nextImage: GeneratedImage = { ...image, dataUrl: stored.url, storageKey: stored.storageKey, prompt: image.prompt ?? record.snapshot.text, durationMs: Date.now() - record.createdAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType, ...canvasImageReferenceIdentity(record.snapshot.references[0]) };
            // Stable ID makes a crash between saving the result and deleting the
            // in-flight marker idempotent on the next recovery.
            await saveLog({ ...buildLog({ prompt: image.prompt ?? record.snapshot.text, model: record.snapshot.config.model, config: record.snapshot.config, references: record.snapshot.references, durationMs: nextImage.durationMs, successCount: 1, failCount: 0, status: "成功", images: [nextImage] }), id: record.id, createdAt: record.createdAt, userInput: image.userInput || record.snapshot.promptInput, optimized: image.optimized }, true, assertCurrent);
            assertCurrent();
            if (mountedRef.current) setResults(value => updateImageResultForRecord(value, record, { status: "success", image: nextImage, recovery: undefined, error: undefined, snapshot: record.snapshot }));
            await removePending(record);
            return nextImage;
        })();
        commit.promise = finish;
        finishingImages.current.set(commitKey, commit);
        try { return await finish; }
        finally { if (finishingImages.current.get(commitKey) === commit) finishingImages.current.delete(commitKey); }
    };

    const runGenerationSlot = async (index: number, snapshot: ImageRequestSnapshot) => {
        const controller = new AbortController();
        observationControllers.current.add(controller);
        const record: PendingImage = { id: nanoid(), requestId: nanoid(), ownerId: user!.id, tool: historyTool, createdAt: Date.now(), snapshot: snapshotImageRequest(snapshot) };
        let submissionStarted = false;
        try {
            const snapshotIsBlend = historyTool === "midjourney-blend" || imageModelProfile(modelOptionName(snapshot.config.model), businessModels).kind === "midjourney-blend";
            const requestOptions = {
                operationType: snapshotIsBlend ? "image_generation" as const : operationType, tool: historyTool,
                promptInput: snapshot.promptInput,
                onOptimizing: () => { if (mountedRef.current) setOptimizingPrompt(true); },
                onCompiled: () => { if (mountedRef.current) setOptimizingPrompt(false); },
                requestId: record.requestId, signal: controller.signal, cancelOnAbort: () => false,
                onSubmissionStarted: async () => { if (mountedRef.current) setResults(value => updateResultAt(value, index, { id: record.id })); await persistPending(record); submissionStarted = true; },
                onSubmitted: async (taskIds: string[]) => { record.taskId = taskIds[0]; await persistPending(record); if (mountedRef.current) { setActiveTaskId(record.taskId || null); setResults(current => updateResultAt(current, index, { taskId: record.taskId, createdAt: record.createdAt })); } },
            };
            const result = snapshotIsBlend || operationType === "image_generation"
                ? await requestGeneration(snapshot.config, snapshot.text, requestOptions, snapshot.references)
                : await requestEdit(snapshot.config, snapshot.text, snapshot.references, undefined, requestOptions);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            return await finishImage(record, image);
        } catch (error) {
            if (mountedRef.current) setOptimizingPrompt(false);
            const taskId = error instanceof QueuedTaskFailedError || error instanceof QueuedTaskPausedError || error instanceof QueuedTaskSubmissionUncertainError ? error.taskId || record.taskId : record.taskId;
            const requestId = error instanceof QueuedTaskFailedError || error instanceof QueuedTaskPausedError || error instanceof QueuedTaskSubmissionUncertainError ? error.requestId || `${record.requestId}:0` : `${record.requestId}:0`;
            record.diagnostic = generationErrorDiagnostic(error);
            const uncertain = submissionStarted && !(error instanceof QueuedTaskFailedError) && (Boolean(record.taskId) || error instanceof QueuedTaskSubmissionUncertainError || controller.signal.aborted || error instanceof TaskObservationStoppedError || error instanceof QueuedTaskPausedError);
            if (!uncertain && submissionStarted) await removePending(record);
            if (uncertain) {
                record.recovery = error instanceof QueuedTaskPausedError ? error.recovery : "observe";
                record.stopped = record.stopped || manuallyStoppedIds.current.has(record.id) || observationStopRequested.current;
                await persistPending(record);
            }
            if (mountedRef.current) setResults((value) => updateResultAt(value, index, { status: uncertain ? "paused" : "failed", error: record.recovery === "investigate" ? submissionInvestigationMessage : controller.signal.aborted ? "已停止本页查询；服务端任务可能继续，可查询原任务。" : error instanceof Error ? error.message : "生成失败", diagnostic: record.diagnostic, taskId, requestId, recovery: uncertain ? record : undefined, snapshot }));
            throw error;
        } finally { observationControllers.current.delete(controller); }
    };

    const resumePendingImages = async (records: PendingImage[], resumePaused = false) => {
        if (activeSubmissionRef.current || !records.length) return;
        const release = workbenchSubmissions.acquire(`image:${user?.id}`);
        if (!release) return;
        pendingRestoreRevision.current += 1;
        observationStopRequested.current = false;
        activeSubmissionRef.current = true;
        resultViewPinnedRef.current = false;
        setRunning(true); setStartedAt(performance.now());
        setResults(records.map(record => ({ id: record.id, status: "pending", snapshot: record.snapshot, diagnostic: record.diagnostic, taskId: record.taskId, requestId: `${record.requestId}:0` })));
        try {
            await Promise.allSettled(records.map(async record => {
                const controller = new AbortController();
                observationControllers.current.add(controller);
                try {
                    manuallyStoppedIds.current.delete(record.id);
                    record = { ...record, stopped: false };
                    let task = await findPendingImageTask(record, { byId: id => getQueuedTask(id, controller.signal), byRequest: id => getQueuedTaskByRequestId(id, controller.signal) });
                    if (useUserStore.getState().user?.id !== record.ownerId) throw new Error("员工会话已变化");
                    record = { ...record, taskId: task.id };
                    await persistPending(record);
                    if (mountedRef.current) setActiveTaskId(task.id);
                    if (task.status === "paused") {
                        if (!resumePaused || classifyTaskRecovery(task) !== "resume") throw new QueuedTaskPausedError(task);
                        task = await recoverQueuedTask(task.id, controller.signal);
                    }
                    const [completed] = ["success", "failed", "cancelled"].includes(task.status) ? [task] : await waitForTasks([task.id], controller.signal, undefined, true);
                    if (!completed || completed.status !== "success") throw new QueuedTaskFailedError(completed || task);
                    if (!completed.resultUrls[0]) throw new Error("原任务尚无可读取结果，请稍后继续查询");
                    await finishImage(record, { id: record.id, dataUrl: completed.resultUrls[0], sourceTaskId: completed.id, prompt: completed.prompt, optimized: completed.optimized, userInput: completed.userInput });
                } catch (error) {
                    const terminal = error instanceof QueuedTaskFailedError;
                    const diagnostic = terminal ? generationErrorDiagnostic(error) : record.diagnostic || generationErrorDiagnostic(error);
                    if (terminal) await removePending(record);
                    else {
                        record = { ...record, diagnostic, recovery: error instanceof QueuedTaskPausedError ? error.recovery : "observe", stopped: record.stopped || manuallyStoppedIds.current.has(record.id) || observationStopRequested.current };
                        await persistPending(record);
                    }
                    if (mountedRef.current) setResults(value => updateImageResultForRecord(value, record, { status: terminal ? "failed" : "paused", error: record.recovery === "investigate" ? submissionInvestigationMessage : controller.signal.aborted ? "已停止本页查询；可手动刷新原任务状态。" : error instanceof Error ? error.message : "原任务查询暂不可用", diagnostic, taskId: record.taskId, requestId: `${record.requestId}:0`, recovery: terminal ? undefined : record, snapshot: record.snapshot }));
                } finally { observationControllers.current.delete(controller); }
            }));
        } finally { release(); activeSubmissionRef.current = false; if (mountedRef.current) setRunning(false); }
    };

    const retryResult = async (index: number) => {
        const previous = results[index];
        if (previous?.recovery) { await resumePendingImages([previous.recovery], previous.recovery.recovery === "resume"); return; }
        const snapshot = previous?.snapshot;
        if (!snapshot) return;
        const release = workbenchSubmissions.acquire(`image:${user?.id}`);
        if (!release) { message.info(uiText("图片任务正在处理，请勿重复提交")); return; }
        pendingRestoreRevision.current += 1;
        observationStopRequested.current = false;
        setRunning(true);
        setActiveTaskId(null);
        activeSubmissionRef.current = true;
        resultViewPinnedRef.current = false;
        setStartedAt(performance.now());
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        try {
            await runGenerationSlot(index, snapshot);
        } catch (error) {
            message.error(error instanceof Error ? uiText(error.message) : uiText("重试未完成"));
        } finally { release(); activeSubmissionRef.current = false; setRunning(false); }
    };

    const reconcilePendingImage = async (original: PendingImage, signal: AbortSignal) => {
        if (removedPendingIds.current.has(original.id)) return;
        let record = original;
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (!mountedRef.current || activeSubmissionRef.current || manuallyStoppedIds.current.has(record.id) || useUserStore.getState().user?.id !== record.ownerId) throw new DOMException("原任务核对已停止", "AbortError");
        };
        try {
            assertCurrent();
            const querySignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
            const task = await findPendingImageTask(record, { byId: id => getQueuedTask(id, querySignal), byRequest: id => getQueuedTaskByRequestId(id, querySignal) });
            assertCurrent();
            record = { ...record, taskId: task.id };
            if (task.status === "success") {
                if (!task.resultUrls[0]) throw new Error("原任务已完成但没有可用图片，结果待核查，请联系管理员。");
                await finishImage(record, { id: record.id, dataUrl: task.resultUrls[0], sourceTaskId: task.id, prompt: task.prompt, optimized: task.optimized, userInput: task.userInput });
                return;
            }
            if (task.status === "failed" || task.status === "cancelled") {
                assertCurrent();
                setResults(value => updateImageResultForRecord(value, record, { status: "failed", recovery: undefined, error: task.failureReason || "原任务已结束，未生成图片", diagnostic: generationErrorDiagnostic(new QueuedTaskFailedError(task)), taskId: task.id, requestId: task.requestId, snapshot: record.snapshot }));
                await removePending(record);
                return;
            }
            const recovery = classifyTaskRecovery(task);
            record = { ...record, recovery: recovery === "terminal" ? "investigate" : recovery };
            // Saving the discovered identity may rebuild the watch; do it only
            // after terminal results have been committed, never mid-import.
            if (record.taskId !== original.taskId || record.recovery !== original.recovery) await persistPending(record);
            assertCurrent();
            const error = record.recovery === "investigate" ? submissionInvestigationMessage : record.recovery === "resume" ? "原任务的上游查询已暂停；可明确恢复查询，不会重新生成。" : "原任务仍在处理中，完成后会自动取回结果；也可刷新状态。";
            setResults(value => updateImageResultForRecord(value, record, { status: "paused", recovery: record, error, diagnostic: record.diagnostic || task.failureReason || undefined, taskId: task.id, requestId: task.requestId, snapshot: record.snapshot }));
        } catch (error) {
            if (signal.aborted || !mountedRef.current || activeSubmissionRef.current || manuallyStoppedIds.current.has(record.id) || useUserStore.getState().user?.id !== record.ownerId) return;
            setResults(value => updateImageResultForRecord(value, record, { status: "paused", recovery: record, error: record.recovery === "investigate" ? submissionInvestigationMessage : error instanceof Error ? error.message : "暂时无法核对原任务，稍后将自动刷新", diagnostic: record.diagnostic || generationErrorDiagnostic(error), taskId: record.taskId, requestId: `${record.requestId}:0`, snapshot: record.snapshot }));
        }
    };

    const reconciliationKey = pendingImages.filter(record => !record.stopped).map(record => `${record.id}:${record.taskId || ""}`).sort().join("|");
    useEffect(() => {
        if (running || !reconciliationKey || user?.status !== "active") return;
        const controller = new AbortController();
        observationControllers.current.add(controller);
        const records = latestPendingImages.current.filter(record => !record.stopped);
        void watchTaskReconciliation({
            taskIds: records.flatMap(record => record.taskId ? [record.taskId] : []),
            signal: controller.signal,
            reconcile: async () => {
                if (activeSubmissionRef.current) return;
                await Promise.allSettled(latestPendingImages.current.filter(record => !record.stopped && !removedPendingIds.current.has(record.id)).map(record => reconcilePendingImage(record, controller.signal)));
            },
        }).catch(() => { /* A disposed view or changed employee cannot keep observing. */ });
        return () => { controller.abort(); observationControllers.current.delete(controller); };
    }, [reconciliationKey, running, user?.id, user?.status]);

    const stopPendingQueries = () => {
        observationStopRequested.current = true;
        const records = latestPendingImages.current.filter(record => !removedPendingIds.current.has(record.id)).map(record => ({ ...record, stopped: true }));
        for (const record of records) {
            manuallyStoppedIds.current.add(record.id);
            const commit = finishingImages.current.get(JSON.stringify([record.ownerId, record.tool, record.id]));
            if (commit) { commit.stopped = true; commit.record.stopped = true; }
        }
        for (const controller of observationControllers.current) controller.abort();
        setPendingImages(records);
        setResults(value => value.map(result => result.recovery ? { ...result, recovery: { ...result.recovery, stopped: true }, error: result.recovery.recovery === "investigate" ? submissionInvestigationMessage : "已停止本页查询；可手动刷新原任务状态。" } : result));
        void Promise.all(records.map(persistPending)).catch(error => message.warning(error instanceof Error ? error.message : "停止状态保存失败"));
    };

    useEffect(() => {
        const toolbar = submitToolbarRef.current;
        if (!toolbar || typeof ResizeObserver === "undefined") return;
        const measure = () => setSubmitToolbarHeight(Math.ceil(toolbar.getBoundingClientRect().height));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(toolbar);
        return () => observer.disconnect();
    }, []);

    const imageDrop = useImageDrop({
        onFiles: addReferences,
        scopeKey: `${historyTool}:${referenceScope}`,
        disabled: !draftReady || placementStatus !== "ready" || readingReferences || running || restoringHistory || user?.status !== "active",
    });

    return (
        <div className="wb-page image-workbench generation-workbench flex h-full flex-col overflow-hidden" style={{ "--generation-submit-height": `${submitToolbarHeight}px` } as CSSProperties}>
            <main className="image-workbench-layout grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-[228px_minmax(0,1fr)] lg:overflow-hidden">
                <aside className="wb-surface thin-scrollbar hidden min-h-0 overflow-y-auto p-4 lg:block">
                    <LogPanel
                        logs={logs}
                        unclassifiedLogs={unclassifiedLogs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        disabled={running || deletingLogs}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={confirmDeleteSelected}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]">
                    <div {...imageDrop.dropProps} aria-busy={imageDrop.reading || readingReferences} className={`wb-surface generation-form flex min-w-0 flex-col p-6 lg:min-h-0 lg:overflow-hidden${imageDrop.dragging ? " outline outline-2 outline-offset-2 outline-primary" : ""}`}>
                        {imageDrop.dragging || imageDrop.reading ? <p role="status" className="mb-3 rounded-lg bg-primary/10 p-3 text-sm text-foreground">{uiText(imageDrop.dragging ? "松开以添加参考图片，不会自动生成。" : "正在读取拖入图片，请稍候。")}</p> : null}
                        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
                        <div>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    {creativePreset ? <Link className="wb-eyebrow inline-flex items-center gap-1" to="/creative"><ArrowLeft className="size-3" />{uiText("创意设计")}</Link> : <p className="wb-eyebrow">{uiText("图像工作室")}</p>}<h1 className="wb-title">{uiText(toolModeConfig.title || "")}</h1>
                                    <p className="wb-description">{uiText(toolModeConfig.description || "")}</p>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                        {uiText("记录")}</Button>
                                    {!quickTool && <Button disabled={placementStatus !== "ready"} icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        {uiText("参数")}</Button>}
                                </div>
                            </div>
                        </div>

                        {placementToken ? <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm leading-6" role={placementStatus === "error" ? "alert" : "status"}>
                            <strong>{uiText("服装定位 · AI 效果图")}</strong>
                            <p className="!mb-1">{placementStatus === "loading" ? uiText("正在带入定位合成图、服装原图和图案原稿…") : placementStatus === "error" ? uiText(placementError) : uiText("参考图与位置保持要求已带入独立草稿。检查模型与输出比例后点“开始编辑”提交；原图片编辑草稿未改动。AI 结果仍需核对定位。")}</p>
                            <div className="flex flex-wrap gap-3">
                                <Link to="/creative/pattern-placement">{uiText("返回调整定位")}</Link>
                                <Link to="/image?tool=image-edit">{uiText("打开原图片编辑草稿")}</Link>
                                {placementStatus === "error" ? <Button size="small" onClick={() => setPlacementAttempt(value => value + 1)}>{uiText("重试带入")}</Button> : null}
                            </div>
                        </div> : null}
                        <fieldset disabled={placementStatus !== "ready"} className="mt-6 min-w-0 space-y-5 border-0 p-0">
                            {initialGarmentScenario ? <GarmentRecipePanel key={garmentScope} references={references} disabled={running || !requiresPrompt} initialScenario={initialGarmentScenario} onApply={applyGarmentRecipe} onDraftChange={handleGarmentDraftChange} /> : null}
                            {requiresPrompt ? <div>
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{uiText("提示词")}</span>
                                    <div className="flex flex-wrap gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {uiText("查看提示词库")}</Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {uiText("查看我的素材")}</Button>
                                    </div>
                                </div>
                                <Input.TextArea aria-label={uiText("图像提示词")} showCount value={prompt} onPaste={event => { const files = pastedImageFiles(event.clipboardData); if (files.length) { event.preventDefault(); void addReferences(files); } }} onChange={(event) => { inputRevision.current += 1; setPrompt(event.target.value); }} onKeyDown={(event) => handleSubmitShortcut(event, canGenerate && !running, () => void generate())} rows={5} disabled={!requiresPrompt} placeholder={requiresPrompt ? uiText("{placeholder}（Ctrl/⌘ + Enter 提交）", { placeholder: uiText(toolModeConfig.placeholder) }) : uiText("这个模型直接合成参考图，不需要填写文字")} />
                            </div> : <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">{uiText(quickTool ? "内置配方 · Nano 2.1，无需填写提示词或选择模型。" : "请选择 2–4 张参考图。此模型不会提交提示词；生成结果取决于图片内容及下方融合参数。")}</p>}

                            {requiresPrompt ? <PromptOptimizeButton config={effectiveConfig} prompt={prompt} references={references} operationType={operationType} scene={creativePreset?.id as PromptScene | undefined} toolKey={toolKey} disabled={running} onBusyChange={setOptimizingPrompt} onApply={(value, _compilation, input) => { replacePrompt(value); setOptimizedDraft({ prompt: value, input, references: [...references], context: optimizationContext }); }} /> : null}
                            <ReferenceImageTray
                                references={references}
                                loading={readingReferences}
                                validation={referenceValidation}
                                onChange={(next) => { inputRevision.current += 1; setReferences(dedupeImageReferences(next)); }}
                                onRequestUpload={() => fileInputRef.current?.click()}
                                onRequestAssets={() => setReferenceAssetPickerOpen(true)}
                                onRequestClipboard={() => void addReferencesFromClipboard()}
                            />

                        </fieldset>
                        </div>
                        <div ref={submitToolbarRef} className="generation-submit shrink-0 pt-4">
                            {!quickTool && <div className="mb-2 flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {imageSizeLabel(effectiveConfig.size)} · {imageQualityLabel(effectiveConfig.quality)}
                                </span>
                                <Button size="small" type="text" disabled={placementStatus !== "ready"} icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {uiText("调整")}</Button>
                            </div>}

                            <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <span>{!deploymentFeatures.creditsEnabled ? uiText("不计积分") : uiText("预计消耗 {credits} 积分", { credits: estimatedUsage.credits })}</span>
                                    <span>{deploymentFeatures.authenticationEnabled ? uiText("个人工作区") : uiText("本机试用")}</span>
                                </div>
                                {missingReference ? <div className="mt-1 text-amber-600 dark:text-amber-300">{uiText(toolModeConfig.title || "")}{uiText("需要先添加至少一张参考图。")}</div> : null}
                                {!referenceValidation.valid ? <div className="mt-1 text-red-500">{referenceValidation.message}</div> : null}
                                {quotaBlocked ? <div className="mt-1 text-red-500">{uiText("额度不足，无法提交生成任务。")}</div> : null}
                                {placementToken && isBlend ? <div className="mt-1 text-red-500">{uiText("定位效果需要位置保持提示词，请选择支持文字要求的图片编辑模型。")}</div> : null}
                                {garmentNeedsApply ? <div className="mt-1" role="status">{uiText("服装要求或参考图已改变，请重新套用。")}<Button size="small" type="link" className="!h-auto !p-0" onClick={resetGarment}>{uiText("改用当前提示词")}</Button></div> : null}
                                {incompleteCreativePrompt ? <div className="mt-1" role="status">{uiText("请把「")}{CREATIVE_REQUIREMENT_PLACEHOLDER}{uiText("」替换成你的设计要求。")}</div> : null}
                                {!draftReady || readingReferences || optimizingPrompt || !model || (requiresPrompt && !prompt.trim()) || invalidBlendReferences || !user || user.status !== "active" ? <div role="status">{!draftReady ? uiText("正在恢复草稿…") : readingReferences ? uiText("正在读取参考图，请稍候") : optimizingPrompt ? uiText("正在优化提示词，请稍候") : !model ? uiText("还差：选择模型") : requiresPrompt && !prompt.trim() ? uiText("还差：填写提示词") : invalidBlendReferences ? uiText("还差：添加 2–4 张参考图") : uiText("当前设计师账号不可用")}</div> : null}
                                {running ? <div role="status">{uiText(quickTool ? "当前图片正在处理，结果将另存，原图不会覆盖。" : "当前任务正在处理，可先编辑下一条提示词。")}</div> : null}
                                {quickTool && !running && pendingImages.length > 0 ? <div role="status">{uiText("原任务状态待核查，请先刷新原任务状态")}</div> : null}
                            </div>
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                                {optimizingPrompt ? uiText("正在优化提示词…") : running ? uiText("正在生成，请稍候…") : uiText(toolModeConfig.button)}
                            </Button>
                            {running ? <Button block onClick={stopPendingQueries}>{uiText("停止本页查询（不取消服务端任务）")}</Button> : pendingImages.length ? <><Button block onClick={() => void resumePendingImages(pendingImages)}>{uiText("刷新原任务状态（")}{pendingImages.length}）</Button>{pendingImages.some(record => !record.stopped) && <Button block onClick={stopPendingQueries}>{uiText("停止自动核对")}</Button>}</> : null}
                        </div>
                    </div>

                    <div className="wb-surface thin-scrollbar min-w-0 p-6 lg:min-h-0 lg:overflow-y-auto">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">{uiText("生成结果")}</h2>
                            </div>
                            {previewLog && !quickTool ? <div className="flex flex-wrap gap-2"><Button size="small" disabled={running || previewLoading} loading={restoringHistory} onClick={() => modal.confirm({ title: uiText("恢复为草稿？"), content: uiText("将替换当前提示词、参数与参考图，不会提交生成任务。"), okText: uiText("确认恢复"), cancelText: uiText("保留草稿"), onOk: restoreHistoryDraft })}>{uiText("恢复为草稿继续改")}</Button><Button size="small" onClick={() => reusePrompt(previewLog.prompt)}>{uiText("复用提示词")}</Button></div> : null}
                            {previewLoading ? <span role="status" className="text-sm text-muted-foreground">{uiText("正在读取记录…")}</span> : running ? <Tag className="m-0 px-2 py-1">{uiText("等待 ")}<GenerationElapsed startedAt={startedAt} /></Tag> : null}
                        </div>
                        <GenerationQueueProgress taskId={activeTaskId} active={running} />
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} hidePromptActions={quickTool} onSelect={selectResultPrompt} onEdit={addResultToReferences} onEditOriginal={openResultEditor} onDownload={downloadImage} onSaveAsset={saveResultToAssets} onSavePrompt={saveResultPrompt} onPlaceCanvas={resultCanvas.enabled ? image => { const source = logs.find(log => log.images.some(item => item.id === image.id)); void resultCanvas.place({ id: image.id, kind: "image", url: image.dataUrl, storageKey: image.storageKey, title: image.imageName || "图像生成结果", width: image.width, height: image.height, prompt: image.prompt || source?.prompt, model: source?.model, sourceTaskId: image.sourceTaskId }); } : undefined} placingCanvas={resultCanvas.busy} onShareDesign={libraryShare.canShare ? shareResultDesign : undefined} sharingDesign={libraryShare.busy} />
                                    ) : result.status === "failed" || result.status === "paused" ? (
                                        <FailedImageCard key={result.id} error={result.error || uiText("生成失败")} diagnostic={result.diagnostic} recovery={result.recovery} taskId={result.taskId || result.recovery?.taskId} requestId={result.requestId || (result.recovery ? `${result.recovery.requestId}:0` : undefined)} disabled={running || (!result.recovery && !result.snapshot)} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} createdAt={result.createdAt || result.recovery?.createdAt} taskId={result.taskId || result.recovery?.taskId} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="wb-empty lg:min-h-[480px]">
                                <ImagePlus size={42} strokeWidth={1.2} />
                                <strong>{quickTool ? uiText("上传原图，一键完成处理") : requiresPrompt ? uiText("第一张作品，从一句描述开始") : uiText("上传参考图，开始多图融合")}</strong><p>{quickTool ? uiText("添加一张图片") : requiresPrompt ? uiText("在左侧写下画面内容，选择模型和参数") : uiText("在左侧上传 2–4 张参考图，选择融合参数")}{uiText("，点击「")}{uiText(toolModeConfig.button || "")}{uiText("」。结果会出现在这里。")}</p>
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple={!quickTool}
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={uiText("生成记录")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    unclassifiedLogs={unclassifiedLogs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    disabled={running || deletingLogs}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={confirmDeleteSelected}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={uiText("参数")} placement="bottom" size="82vh" open={!quickTool && settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings toolKey={toolKey} config={effectiveConfig} model={model} referenceCount={references.length} updateConfig={updateInputConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={reusePrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <AssetPickerModal
                open={referenceAssetPickerOpen}
                defaultTab="my-assets"
                selectionMode="multiple-images"
                onInsertMany={(payloads) => {
                    setReadingReferences(true);
                    void Promise.all(payloads.filter((payload): payload is Extract<InsertAssetPayload, { kind: "image" }> => payload.kind === "image").map(async (payload) => {
                        const stored = await uploadImage(payload.dataUrl);
                        return { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, imageName: payload.imageName, imageVersion: payload.imageVersion };
                    })).then((items) => appendReferences(items, "asset")).catch(error => message.error(uiText(generationErrorMessage(error)))).finally(() => setReadingReferences(false));
                    setReferenceAssetPickerOpen(false);
                }}
                onClose={() => setReferenceAssetPickerOpen(false)}
            />
            <Modal title={uiText("批量删除生成记录")} open={deleteConfirmOpen} onCancel={() => { if (!deletingLogs) setDeleteConfirmOpen(false); }} onOk={deleteSelectedLogs} confirmLoading={deletingLogs} cancelButtonProps={{ disabled: deletingLogs }} okText={uiText("确认删除")} okButtonProps={{ danger: true, disabled: running || !deleteLogIds.length }} cancelText={uiText("取消")}>
                <p>{uiText("确定删除选中的")}{deleteLogIds.length} {uiText("条生成记录吗？")}</p>
                <p className="mt-2 text-xs text-muted-foreground">{uiText("将移除本机生成记录及其本地结果图片，不会删除服务端任务或取消生成。")}</p>
            </Modal>
            {imageEditor.node ? <Suspense fallback={<Modal title={uiText("编辑原图")} open footer={null} onCancel={imageEditor.close}><p role="status">{uiText("正在读取图片编辑器…")}</p></Modal>}>
                <CanvasImageEditorDialog node={imageEditor.node} onClose={imageEditor.close} onConfirm={imageEditor.confirm}
                    saveHint="另存到我的素材 · 原图和生成历史保持不变 · 不调用 AI"
                    successMessage="新版本已保存到我的素材，原图和生成历史保持不变"
                    cancelDescription="原图和生成历史不会改变，未保存的修改将丢弃。" />
            </Suspense> : null}
        </div>
    );
}

function GenerationSettings({ config, model, referenceCount, updateConfig, openConfigDialog, toolKey }: { config: AiConfig; model: string; referenceCount: number; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void; toolKey: ReturnType<typeof requireToolKey> }) {
    useUiText();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const profile = useImageModelProfile(model);

    return (
        <>
            <label className="col-span-2 block min-w-0">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{uiText("模型")}</span>
                <ModelPicker toolKey={toolKey} config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" modelsSource="server" fullWidth className="h-10 rounded-lg" onMissingConfig={() => openConfigDialog(false)} />
                {profile.verified ? <span className="mt-2 block text-xs leading-5" style={{ color: "var(--wb-muted)" }}>{uiText(profile.tip || "")}</span> : null}
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={{ ...config, model, imageModel: model }} referenceCount={referenceCount} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

function ResultImageCard({
    hidePromptActions,
    image,
    index,
    onSelect,
    onEdit,
    onEditOriginal,
    onDownload,
    onSaveAsset,
    onSavePrompt,
    onShareDesign,
    sharingDesign,
    onPlaceCanvas,
    placingCanvas,
}: {
    hidePromptActions?: boolean;
    image: GeneratedImage;
    index: number;
    onSelect: (image: GeneratedImage) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onEditOriginal: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onSavePrompt: (image: GeneratedImage) => void;
    onShareDesign?: (image: GeneratedImage, index: number) => Promise<void>;
    sharingDesign?: boolean;
    onPlaceCanvas?: (image: GeneratedImage) => void;
    placingCanvas?: boolean;
}) {
    useUiText();
    const previewUrl = useImagePreview(image);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrl || undefined} preview={{ src: image.dataUrl }} alt={uiText("生成结果 {value1}", { value1: index + 1 })} loading="lazy" decoding="async" className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                {image.imageName ? <div className="truncate text-xs font-medium" title={`${image.imageName}_v${image.imageVersion || 1}`}>{image.imageName}_v{image.imageVersion || 1}</div> : null}
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2">
                    {!hidePromptActions && <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" onClick={() => onSelect(image)}>{uiText("复用提示词")}</Button>}
                    {onPlaceCanvas ? <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" loading={placingCanvas} onClick={() => onPlaceCanvas(image)}>{uiText("放入画布")}</Button> : null}
                    <Tooltip title={uiText("直接编辑原始图片，另存为新版本，不调用 AI")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => onEditOriginal(image, index)}>
                            {uiText("编辑原图")}</Button>
                    </Tooltip>
                    <Tooltip title={uiText("添加到素材")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {uiText("保存到素材库")}</Button>
                    </Tooltip>
                    <Tooltip title={uiText("加入参考图")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {uiText("加入参考图")}</Button>
                    </Tooltip>
                    <Tooltip title={uiText("下载")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {uiText("下载")}</Button>
                    </Tooltip>
                    {!hidePromptActions && <Tooltip title={uiText("保存为个人提示词模板")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<BookmarkPlus className="size-3.5" />} onClick={() => void onSavePrompt(image)}>
                            {uiText("存为提示词")}</Button>
                    </Tooltip>}
                    {onShareDesign && <Tooltip title={uiText("复用或保存本人私有原图，再核对公开内容；不会自动发布")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Share2 className="size-3.5" />} loading={sharingDesign} onClick={() => void onShareDesign(image, index)}>{uiText("分享到灵感库")}</Button>
                    </Tooltip>}
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ createdAt, taskId }: { createdAt?: number; taskId?: string }) {
    useUiText();
    return (
        <div role="status" className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{uiText("已等待 ")}<GenerationElapsed startedAt={createdAt ? performance.now() - (Date.now() - createdAt) : 0} /></span>
                <GenerationQueueProgress taskId={taskId} active />
                <GenerationTaskCancel taskId={taskId} />
            </div>
        </div>
    );
}

function FailedImageCard({ error, diagnostic, recovery, taskId, requestId, disabled, onRetry }: { error: string; diagnostic?: string; recovery?: PendingImage; taskId?: string; requestId?: string; disabled?: boolean; onRetry: () => void }) {
    useUiText();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{recovery?.recovery === "investigate" ? uiText("提交结果待核查") : recovery?.recovery === "resume" ? uiText("原任务查询暂停") : recovery ? uiText("原任务状态核对") : uiText("生成失败")}</div>
                <GenerationDiagnostic error={error} details={[diagnostic, taskId ? `taskId: ${taskId}` : "", requestId ? `requestId: ${requestId}` : ""].filter(Boolean).join("\n")} />
                {recovery && !recovery.stopped && recovery.recovery !== "investigate" && <GenerationTaskCancel taskId={taskId} />}
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger={!recovery} disabled={disabled} onClick={onRetry}>
                    {recovery?.recovery === "resume" ? uiText("恢复原任务查询") : recovery ? uiText("刷新状态") : uiText("按原参数重试")}
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    unclassifiedLogs,
    selectedLogIds,
    activeLogId,
    disabled,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    unclassifiedLogs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    disabled?: boolean;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    useUiText();
    const selectedCount = logs.filter(log => selectedLogIds.includes(log.id)).length;
    const allSelected = Boolean(logs.length) && selectedCount === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{uiText("生成记录")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={onCreateSession}>
                    {uiText("新建")}</Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={disabled || !logs.length} onClick={toggleAll}>
                    {allSelected ? uiText("取消全选") : uiText("全选")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={disabled || !selectedCount} onClick={onDeleteSelected}>
                    {uiText("批量删除")}{selectedCount ? `（${selectedCount}）` : ""}</Button>
            </div>
            <div className="space-y-3">
                <PracticeExampleRecord />
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        disabled={disabled}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{uiText("暂无生成记录")}</div> : null}
                {!!unclassifiedLogs.length && <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer py-2">{uiText("未分类记录（")}{unclassifiedLogs.length}）</summary>
                    <p className="mb-2">{uiText("以下记录的原任务来源无法确认，保留查看，不自动归入当前板块。")}</p>
                    <div className="space-y-3">{unclassifiedLogs.map(log => <LogCard key={log.id} log={log} active={activeLogId === log.id} onClick={() => onPreviewLog(log)} />)}</div>
                </details>}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, disabled, onSelectedChange, onClick }: { log: GenerationLog; selected?: boolean; active: boolean; disabled?: boolean; onSelectedChange?: (checked: boolean) => void; onClick: () => void }) {
    useUiText();
    const thumbnails = log.images.slice(0, 4);

    return (
        <button
            type="button"
            disabled={disabled}
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    {onSelectedChange && <Checkbox className="mt-0.5" aria-label={uiText("选择记录：{title}", { title: log.title })} disabled={disabled} checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />}
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    <ImageLogThumbnail key={`${log.id}-${index}`} image={image} />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {uiText("成功")}{log.successCount ?? log.imageCount}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {uiText("失败")}{log.failCount}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.imageCount} {uiText(" 张")}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{formatBeijingDateTime(log.createdAt)} {uiText("北京时间")}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs(store: typeof logStore, scope: { ownerId: string; tool: string }) {
    if (typeof window === "undefined" || !scope.ownerId) return { logs: [], unclassified: [] };
    try {
        const values: GenerationLog[] = [];
        await store.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = values.map(normalizeLog);
        return partitionImageLogs(logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), scope, getQueuedTask);
    } catch (error) {
        throw new Error(`图片历史读取失败：${error instanceof Error ? error.message : "浏览器存储不可用"}`);
    }
}

function normalizeLog(log: Partial<GenerationLog>): GenerationLog {
    const references = log.references || [];
    const images = log.images || [];
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        ownerId: log.ownerId,
        tool: log.tool,
        createdAt: log.createdAt ?? Number.NaN,
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || "—",
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        imageOptions: log.config?.imageOptions || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
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
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        imageOptions: config.imageOptions || "",
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString(getUiLocale(), { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
