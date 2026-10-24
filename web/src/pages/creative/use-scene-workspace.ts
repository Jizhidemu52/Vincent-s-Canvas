import { useEffect, useMemo, useRef, useState } from "react";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { canvasImageDownloadFileName, canvasImageReferenceIdentity } from "@/lib/canvas/canvas-image-filename";
import { imageCopyEditorNode } from "@/lib/image-edit-copy";
import { deploymentFeatures } from "@/lib/deployment-features";
import { normalizeImageModelSettings, useImageModelProfile } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { workbenchSubmissions } from "@/lib/submission-gate";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { freezeLocalInput, restoreLocalInput } from "@/services/generation-local-inputs";
import { restoreGenerationDraft } from "@/services/api/generation-history";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { scenePromptInput, cloneSceneForm, createSceneForm, getSceneSlots, validateSceneForm, type SceneForm, type SceneSlotId } from "./scene-form-model";
import { compositeSelectedImage, createSelectionGuide } from "./image-processing-browser";
import { preferredSelectionSize, selectionSizeMatches } from "./image-processing";
import { useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { useModuleEnabled } from "@/stores/use-module-store";
import type { ToolKey } from "../../../../shared/feature-catalog";
import { createSceneHistory, summarizeSceneLog, type SceneLogSummary } from "./scene-history";
import { requestQueuedImages, QueuedTaskFailedError } from "@/services/api/generation-tasks";
import { canRetrySceneResult, prepareSceneRetry, sceneFailure } from "./scene-retry";
import { createSceneResultActions } from "./scene-result-actions";
import { canQuerySceneResult, readSceneRequest, sceneInputMatchesLog, sceneRootRequestId } from "./scene-recovery";

export type SceneImage = ReferenceImage & {
    inputSha256?: string;
    width: number; height: number; bytes: number; mimeType: string;
    sourceTaskId?: string; durationMs?: number;
};
export type SceneImages = Partial<Record<SceneSlotId, SceneImage>>;
export type SceneParameters = Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "imageOptions">;
export type SceneSelection = { sourceId: string; mask: SceneImage };
export type SceneResult = { id: string; status: "pending" | "success" | "failed"; image?: SceneImage; uncompositedImage?: SceneImage; error?: string;
    taskId?: string; requestId?: string; compilationId?: string; failureKind?: "terminal" | "uncertain" | "local"; retryLogId?: string };
export type SceneLog = {
    inputArchiveVersion?: 1;
    userInput?: import("../../../../shared/prompt-contracts").PromptInputData;
    optimized?: boolean;
    submittedReferences?: SceneImage[];
    id: string; ownerId: string; sceneId: string; createdAt: number; prompt: string;
    form: SceneForm; referenceImages: SceneImages; config: SceneParameters;
    results: SceneResult[]; images: SceneImage[]; durationMs: number; successCount: number; failCount: number;
    selection?: SceneSelection | null; operation?: "ai" | "recolor";
    retryOf?: { logId: string; resultId: string; taskId: string };
};
type SceneDraft = { form: SceneForm; images: SceneImages; config: SceneParameters; selection?: SceneSelection | null; systemPromptOverride?: string };

const storage = createWorkspaceStorage("creative_scene_workspaces");
const draftWrites = new Map<string, Promise<void>>();
const slots: SceneSlotId[] = ["primary", "secondary"];
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";

/** Only these image settings may enter a local draft or history record. */
export function sceneParameters(config: SceneParameters): SceneParameters {
    return { model: config.model, imageModel: config.imageModel, size: config.size, quality: config.quality, count: config.count, ...(config.imageOptions !== undefined ? { imageOptions: config.imageOptions } : {}) };
}

function storedImage(image: SceneImage): SceneImage {
    return { ...image, dataUrl: image.storageKey || image.dataUrl.startsWith("blob:") ? "" : image.dataUrl, url: undefined };
}

function mapImages(images: SceneImages, map: (image: SceneImage) => SceneImage): SceneImages {
    return Object.fromEntries(slots.flatMap(slot => images[slot] ? [[slot, map(images[slot]!)]] : []));
}

export function serializeSceneDraft(draft: SceneDraft): SceneDraft {
    return { form: cloneSceneForm(draft.form), images: mapImages(draft.images, storedImage), config: sceneParameters(draft.config),
        selection: draft.selection ? { ...draft.selection, mask: storedImage(draft.selection.mask) } : null };
}

export function serializeSceneLog(log: SceneLog): SceneLog {
    return {
        ...log, form: cloneSceneForm(log.form), config: sceneParameters(log.config),
        referenceImages: mapImages(log.referenceImages, storedImage),
        submittedReferences: log.submittedReferences?.map(storedImage),
        images: log.images.map(storedImage),
        selection: log.selection ? { ...log.selection, mask: storedImage(log.selection.mask) } : null,
        results: log.results.map(result => ({ ...result, image: result.image ? storedImage(result.image) : undefined,
            uncompositedImage: result.uncompositedImage ? storedImage(result.uncompositedImage) : undefined })),
    };
}

async function hydrateImage(image: SceneImage): Promise<SceneImage> {
    const dataUrl = await resolveImageUrl(image.storageKey, image.dataUrl);
    if (!dataUrl) throw new Error(`图片“${image.name}”的本地文件已不可用，请重新上传`);
    return { ...image, dataUrl };
}

async function hydrateImages(images: SceneImages): Promise<SceneImages> {
    return Object.fromEntries(await Promise.all(slots.flatMap(slot => images[slot] ? [hydrateImage(images[slot]!).then(image => [slot, image])] : [])));
}

async function hydrateLog(log: SceneLog): Promise<SceneLog> {
    const results = await Promise.all(log.results.map(async result => ({ ...result, image: result.image ? await hydrateImage(result.image) : undefined,
        uncompositedImage: result.uncompositedImage ? await hydrateImage(result.uncompositedImage) : undefined })));
    return { ...log, results, images: results.flatMap(result => result.image ? [result.image] : []) };
}

export function selectionMatchesSource(selection: SceneSelection | null | undefined, source: SceneImage | undefined) {
    return Boolean(selection && source && selection.sourceId === source.id && selection.mask.width === source.width && selection.mask.height === source.height);
}

async function hydrateSelection(selection: SceneSelection | null | undefined, images: SceneImages) {
    if (!selection) return null;
    if (!selectionMatchesSource(selection, images.primary)) throw new Error("选区与原图不匹配，请重新涂选");
    return { ...selection, mask: await hydrateImage(selection.mask) };
}

async function storeSceneResult(item: SceneResult, source: Awaited<ReturnType<typeof requestGeneration>>[number] | undefined, index: number, sceneId: string, snapshot: Pick<SceneDraft, "images" | "selection">, warning: (message: string) => void): Promise<SceneResult> {
    if (!source) throw new Error("接口没有返回图片");
    let image: SceneImage;
    const identity = canvasImageReferenceIdentity(snapshot.images.primary || snapshot.images.secondary);
    try {
        const stored = await uploadImage(source.dataUrl);
        image = { ...source, ...stored, dataUrl: stored.url, name: `设计结果-${index + 1}`, type: stored.mimeType, ...identity };
    } catch (caught) {
        const meta = await readImageMeta(source.dataUrl);
        image = { ...source, ...meta, name: `设计结果-${index + 1}`, type: meta.mimeType, bytes: getDataUrlByteSize(source.dataUrl), ...identity };
        warning(`第 ${index + 1} 张原图未能保存到本地：${errorText(caught)}`);
    }
    if (sceneId === "local-restyle" && snapshot.selection && snapshot.images.primary) {
        const raw = image;
        try {
            const composited = await compositeSelectedImage(snapshot.images.primary.dataUrl, image.dataUrl, snapshot.selection.mask.dataUrl);
            const stored = await uploadImage(composited);
            image = { ...image, ...stored, dataUrl: stored.url, type: stored.mimeType, name: `选区合成-${index + 1}.png` };
        } catch (caught) {
            return { ...item, status: "failed", failureKind: "local", uncompositedImage: raw, error: `选区合成未完成：${errorText(caught)}。AI 原始结果已保留，可下载检查。` };
        }
    }
    return { ...item, status: "success", image };
}

/** Dedicated scene state; never mutates the original image workbench's settings. */
export function useSceneWorkspace(sceneId: string) {
    const effectiveConfig = useEffectiveConfig();
    const configRef = useRef(effectiveConfig);
    configRef.current = effectiveConfig;
    const user = useUserStore(state => state.user);
    const models = useBusinessConfigStore(state => state.models);
    const businessStatus = useBusinessConfigStore(state => state.status);
    const refreshBusinessConfig = useBusinessConfigStore(state => state.refresh);
    const estimate = useBusinessConfigStore(state => state.estimate);
    const scope = user ? `${encodeURIComponent(user.id)}:${encodeURIComponent(sceneId)}` : null;
    const history = useMemo(() => user ? createSceneHistory(storage, user.id, sceneId) : null, [user?.id, sceneId]);
    const resultActions = useMemo(() => user ? createSceneResultActions(user.id) : null, [user?.id, sceneId]);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const epoch = useRef(0);
    const inputEpoch = useRef<Record<SceneSlotId, number>>({ primary: 0, secondary: 0 });
    const viewEpoch = useRef(0);
    const [loadedScope, setLoadedScope] = useState<string | null>();
    const [draftReady, setDraftReady] = useState(false);
    const [form, setForm] = useState(() => createSceneForm(sceneId));
    const [images, setImages] = useState<SceneImages>({});
    const imagesRef = useRef(images); imagesRef.current = images;
    const [selection, setSelection] = useState<SceneSelection | null>(null);
    const [parameters, setParameters] = useState(() => sceneParameters(effectiveConfig));
    const [systemPromptOverride, setSystemPromptOverride] = useState<string | undefined>();
    const [logs, setLogs] = useState<SceneLogSummary[]>([]);
    const knownLogIds = useRef(new Set<string>());
    const [recoveredRequestId, setRecoveredRequestId] = useState<string | null>(null);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const historyLoadingRef = useRef(false);
    const [activeLog, setActiveLog] = useState<SceneLog | null>(null);
    const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const [results, setResults] = useState<SceneResult[]>([]);
    const [running, setRunning] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [uploadCount, setUploadCount] = useState(0);
    const [startedAt, setStartedAt] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [resultActionBusy, setResultActionBusy] = useState(false);
    const resultActionGate = useRef(false);
    const loading = loadedScope !== scope || restoring;
    const toolKey = `creative-${sceneId}` as ToolKey;
    const toolEnabled = useToolEnabled(toolKey);
    const selectionEnabled = useModuleEnabled("creative-selection");
    const selectedConfig = useToolConfig({ ...effectiveConfig, ...parameters, model: parameters.imageModel || parameters.model || effectiveConfig.imageModel || effectiveConfig.model }, toolKey);
    const model = selectedConfig.model;
    const profile = useImageModelProfile(model);
    const normalized = normalizeImageModelSettings(parameters, profile);
    const config = useMemo(() => ({ ...effectiveConfig, ...parameters, ...normalized, model, imageModel: model, systemPrompt: systemPromptOverride ?? effectiveConfig.systemPrompt }),
        [effectiveConfig, parameters, normalized.size, normalized.quality, normalized.count, model, systemPromptOverride]);
    const count = Number(normalized.count);
    const sceneSlots = getSceneSlots(sceneId, form);
    const references = sceneSlots.flatMap(slot => images[slot.id] ? [images[slot.id]!] : []);
    const editing = sceneSlots.length > 0;
    const operationType = editing ? "inpaint" as const : "image_generation" as const;
    const selectedModel = models.find(item => item.id === model || item.modelId === modelOptionName(model) || item.name === model);
    const estimateValue = estimate({ toolKey, modelId: modelOptionName(model), operationType, quantity: count });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimateValue.configured && user.creditBalance < estimateValue.credits);
    const referenceValidation = validateImageReferences(model, references);
    const validation = loading ? "正在读取当前板块的数据"
        : !toolEnabled ? "当前创意场景已停用，原有草稿和结果仍保留"
        : selection && !selectionEnabled ? "选区绘制已停用，请清除选区后再生成"
        : uploadCount ? "图片正在保存，请稍候"
        : !user || user.status !== "active" ? "当前设计师账号不可用"
        : businessStatus === "error" ? "模型配置加载失败，请刷新页面重试"
        : businessStatus !== "ready" ? "正在加载可用模型"
        : !selectedModel ? "请选择当前已启用的图像模型"
        : !profile.requiresPrompt ? "当前场景需要理解设计描述，请选择支持提示词的模型"
        : editing && (profile.kind === "midjourney" || !selectedModel.capabilities.includes("edit")) ? "当前场景需要支持图像编辑的模型"
        : !editing && !selectedModel.capabilities.includes("generate") ? "当前模型不支持从文字生成图片"
        : !referenceValidation.valid ? referenceValidation.message || "参考图不符合模型要求"
        : references.some(image => !image.dataUrl) ? "部分参考图的本地文件已不可用，请重新上传"
        : selection && (!selectionMatchesSource(selection, images.primary) || !selection.mask.dataUrl) ? "选区与原图不匹配或文件不可用，请清除后重新涂选"
        : selection && images.primary && !selectionSizeMatches(config.size, images.primary) ? "选区合成需要保持原图比例，请在出图设置中选择相同比例或自适应"
        : deploymentFeatures.creditsEnabled && !estimateValue.configured ? "当前模型或操作的计费配置不可用"
        : quotaBlocked ? `额度不足，预计需要 ${estimateValue.credits} 积分`
        : validateSceneForm(sceneId, form, images);

    useEffect(() => {
        if (businessStatus === "idle") void refreshBusinessConfig().catch(() => undefined);
    }, [businessStatus, refreshBusinessConfig]);

    useEffect(() => {
        const revision = ++epoch.current;
        knownLogIds.current.clear(); setRecoveredRequestId(null);
        setForm(createSceneForm(sceneId)); setImages({}); setSelection(null); setLogs([]); setResults([]); setActiveLog(null); setSelectedPrompt(null); setPreviewing(false);
        setHistoryTotal(0); setHistoryHasMore(false); setHistoryLoading(false); historyLoadingRef.current = false;
        setSystemPromptOverride(undefined);
        setParameters(sceneParameters(configRef.current)); setRunning(false); setRestoring(false); setUploadCount(0); setStartedAt(0); setError(null); setNotice(null); setDraftReady(false);
        if (!scope) { setLoadedScope(null); return () => { epoch.current += 1; }; }
        void (async () => {
            try {
                await draftWrites.get(scope);
                const [draft, page, pendingLogs] = await Promise.all([storage.getItem<SceneDraft>(`draft:${scope}`), history!.page(), history!.pending()]);
                if (revision !== epoch.current) return;
                setLogs(page.entries); setHistoryTotal(page.total); setHistoryHasMore(page.hasMore);
                knownLogIds.current = new Set([...page.entries, ...pendingLogs].map(entry => entry.id));
                if (draft) {
                    setSystemPromptOverride(draft.systemPromptOverride);
                    setForm(cloneSceneForm({ ...createSceneForm(sceneId), ...draft.form })); setParameters(sceneParameters(draft.config)); setImages(draft.images); setSelection(draft.selection || null);
                    try {
                        const restoredImages = await hydrateImages(draft.images);
                        if (revision === epoch.current) setImages(restoredImages);
                        const restoredSelection = await hydrateSelection(draft.selection, restoredImages);
                        if (revision === epoch.current) setSelection(restoredSelection);
                    } catch (caught) { if (revision === epoch.current) setError(errorText(caught)); }
                }
                if (pendingLogs[0]) {
                    const pendingLog = await hydrateLog(await history!.read(pendingLogs[0].id));
                    if (revision === epoch.current) {
                        setActiveLog(pendingLog); setResults(pendingLog.results); setSelectedPrompt(pendingLog.prompt); setRecoveredRequestId(pendingLog.id);
                        setNotice("已恢复未结束的原请求。请查询原请求，不会自动重新生成或扣费；修改设计输入可开始新任务。");
                    }
                }
                if (revision === epoch.current) setDraftReady(true);
            } catch (caught) {
                if (revision === epoch.current) setError(`本地草稿或记录读取失败：${errorText(caught)}`);
            } finally { if (revision === epoch.current) setLoadedScope(scope); }
        })();
        return () => { epoch.current += 1; };
    }, [scope, sceneId]);

    useEffect(() => {
        if (!scope || loadedScope !== scope || !draftReady) return;
        const draft = serializeSceneDraft({ form, images, config, selection, systemPromptOverride });
        const write = (draftWrites.get(scope) || Promise.resolve()).then(() => storage.setItem(`draft:${scope}`, draft)).then(() => undefined).catch(caught => {
            if (scopeRef.current === scope) setError(`草稿保存失败：${errorText(caught)}`);
        });
        draftWrites.set(scope, write);
        void write.then(() => { if (draftWrites.get(scope) === write) draftWrites.delete(scope); });
    }, [scope, loadedScope, draftReady, form, images, config, selection, systemPromptOverride]);

    const updateConfig = (key: keyof SceneParameters, value: string) => {
        viewEpoch.current += 1; setRestoring(false); setPreviewing(false);
        setParameters(current => key === "model" || key === "imageModel" ? { ...current, model: value, imageModel: value } : { ...current, [key]: value });
    };

    const setImage = async (slot: SceneSlotId, file: File | null) => {
        if (loading || running) return;
        const revision = epoch.current;
        const uploadRevision = ++inputEpoch.current[slot];
        if (!file) { if (slot === "primary") setSelection(null); setImages(current => { const next = { ...current }; delete next[slot]; return next; }); return; }
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("请上传 PNG、JPG 或 WebP 图片"); return; }
        setError(null); setUploadCount(value => value + 1);
        try {
            const stored = await uploadImage(file);
            if (revision !== epoch.current || uploadRevision !== inputEpoch.current[slot]) return;
            if (slot === "primary") setSelection(null);
            setImages(current => ({ ...current, [slot]: { id: nanoid(), name: file.name, originalFileName: file.name, type: stored.mimeType,
                mimeType: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes } }));
        } catch (caught) { if (revision === epoch.current) setError(`图片保存失败：${errorText(caught)}`); }
        finally { if (revision === epoch.current) setUploadCount(value => Math.max(0, value - 1)); }
    };

    const reset = () => {
        if (running) return;
        viewEpoch.current += 1; setRestoring(false);
        inputEpoch.current.primary += 1; inputEpoch.current.secondary += 1;
        setForm(createSceneForm(sceneId)); setImages({}); setSelection(null); setResults([]); setActiveLog(null); setSelectedPrompt(null); setPreviewing(false); setError(null); setNotice(null); setStartedAt(0);
    };

    const loadMoreHistory = async () => {
        if (!history || historyLoadingRef.current || !historyHasMore) return;
        historyLoadingRef.current = true; setHistoryLoading(true);
        const revision = epoch.current;
        try {
            const page = await history.page(logs.length);
            if (revision === epoch.current) { setLogs(current => [...current, ...page.entries.filter(entry => !current.some(item => item.id === entry.id))]); setHistoryTotal(page.total); setHistoryHasMore(page.hasMore); }
        } catch (caught) { if (revision === epoch.current) setError(`历史加载失败：${errorText(caught)}`); }
        finally { if (revision === epoch.current) { historyLoadingRef.current = false; setHistoryLoading(false); } }
    };

    const rememberLog = (log: SceneLog) => {
        const summary = summarizeSceneLog(log);
        setLogs(current => [summary, ...current.filter(item => item.id !== log.id)]);
        if (!knownLogIds.current.has(log.id)) { knownLogIds.current.add(log.id); setHistoryTotal(current => current + 1); }
    };

    const previewLog = async (log: SceneLogSummary) => {
        if (running || restoring || log.ownerId !== user?.id || log.sceneId !== sceneId) return;
        const revision = epoch.current;
        const viewRevision = ++viewEpoch.current;
        setActiveLog(null); setSelectedPrompt(null);
        setResults([]); setPreviewing(true); setError(null); setNotice(null);
        try {
            const restored = await hydrateLog(await history!.read(log.id));
            if (revision !== epoch.current || viewRevision !== viewEpoch.current) return;
            setActiveLog(restored); setSelectedPrompt(restored.prompt); setResults(restored.results); setStartedAt(0);
        } catch (caught) { if (revision === epoch.current && viewRevision === viewEpoch.current) setError(`结果读取失败：${errorText(caught)}；当前草稿未改变`); }
        finally { if (revision === epoch.current && viewRevision === viewEpoch.current) setPreviewing(false); }
    };

    const selectResultPrompt = (result: SceneResult) => {
        if (!result.image) return;
        const log = activeLog?.results.some(stored => stored.id === result.id && stored.image?.id === result.image?.id) ? activeLog : null;
        if (log && typeof log.prompt === "string") setSelectedPrompt(log.prompt);
    };

    const restoreLog = async (log: SceneLog) => {
        if (running || restoring || log.ownerId !== user?.id || log.sceneId !== sceneId) return;
        const revision = epoch.current;
        const viewRevision = ++viewEpoch.current;
        inputEpoch.current.primary += 1; inputEpoch.current.secondary += 1;
        setRestoring(true); setPreviewing(false); setError(null);
        try {
            if (log.inputArchiveVersion !== 1) throw new Error("旧记录未保存完整输入归档，无法安全恢复参考图与选区");
            if (log.operation !== "recolor" && !models.some(model => model.id === log.config.imageModel)) throw new Error("历史模型已停用，未恢复任何输入");
            const taskResult = log.results.find(result => result.taskId || result.image?.sourceTaskId);
            const taskId = taskResult?.taskId || taskResult?.image?.sourceTaskId;
            if (log.operation !== "recolor" && !taskId) throw new Error("记录缺少原任务，无法校验完整生成参数");
            const draft = taskId ? await restoreGenerationDraft(taskId) : null;
            const restoredImages: SceneImages = Object.fromEntries(await Promise.all(slots.flatMap(slot => log.referenceImages[slot] ? [restoreLocalInput(log.referenceImages[slot]!).then(image => [slot, image])] : [])));
            const restoredSelection = log.selection ? { ...log.selection, mask: await restoreLocalInput(log.selection.mask) } : null;
            if (restoredSelection && !selectionMatchesSource(restoredSelection, restoredImages.primary)) throw new Error("历史选区与原图不匹配");
            const restored = await hydrateLog(log);
            if (revision !== epoch.current || viewRevision !== viewEpoch.current) return;
            setForm(cloneSceneForm({ ...createSceneForm(sceneId), ...log.form })); setImages(restoredImages); setParameters(sceneParameters(draft ? { ...draft.config, count: log.config.count } : log.config));
            setSystemPromptOverride(draft?.config.systemPrompt);
            setSelection(restoredSelection);
            setActiveLog(restored); setSelectedPrompt(log.prompt); setResults(restored.results); setStartedAt(0);
        } catch (caught) { if (revision === epoch.current && viewRevision === viewEpoch.current) setError(`记录恢复失败：${errorText(caught)}`); }
        finally { if (revision === epoch.current && viewRevision === viewEpoch.current) setRestoring(false); }
    };

    const saveSelection = async (sourceId: string, blob: Blob) => {
        if (loading || running || uploadCount || imagesRef.current.primary?.id !== sourceId) throw new Error("原图状态已变化，请重新涂选");
        const revision = epoch.current;
        const stored = await uploadImage(blob);
        if (revision !== epoch.current || imagesRef.current.primary?.id !== sourceId) throw new Error("原图已切换，请在新原图上重新涂选");
        const mask: SceneImage = { ...stored, id: nanoid(), name: "修改区域.png", type: stored.mimeType, dataUrl: stored.url };
        if (!selectionMatchesSource({ sourceId, mask }, imagesRef.current.primary)) throw new Error("选区尺寸与原图不一致");
        setParameters(current => ({ ...current, size: preferredSelectionSize(imagesRef.current.primary!, profile.sizes) }));
        setSelection({ sourceId, mask }); setError(null);
    };

    const saveLocalResult = async (sourceId: string, blob: Blob, description: string) => {
        if (!user || user.status !== "active" || !scope || loading || running || uploadCount || imagesRef.current.primary?.id !== sourceId) throw new Error("当前图片或账号状态已变化，请重新打开换色工具");
        const revision = epoch.current, start = performance.now();
        viewEpoch.current += 1;
        setRunning(true); setSelectedPrompt(null); setPreviewing(false); setError(null); setStartedAt(start);
        try {
            const original = images.primary ? await freezeLocalInput(images.primary) : undefined;
            const stored = await uploadImage(blob);
            const image: SceneImage = { ...stored, id: nanoid(), name: "精确换色结果.png", dataUrl: stored.url, type: stored.mimeType, ...canvasImageReferenceIdentity(images.primary) };
            const result: SceneResult = { id: nanoid(), status: "success", image };
            const log: SceneLog = { id: nanoid(), ownerId: user.id, sceneId, createdAt: Date.now(), prompt: description,
                form: cloneSceneForm(form), referenceImages: { primary: original }, config: sceneParameters(config), operation: "recolor", inputArchiveVersion: 1,
                results: [result], images: [image], durationMs: performance.now() - start, successCount: 1, failCount: 0 };
            if (revision === epoch.current) { setResults([result]); rememberLog(log); setActiveLog(log); }
            try {
                await history!.save(serializeSceneLog(log));
            } catch (caught) { if (revision === epoch.current) setError(`换色结果仍保留在页面，但本地记录保存失败：${errorText(caught)}`); }
        } finally { if (revision === epoch.current) setRunning(false); }
    };

    const [optimizing, setOptimizing] = useState(false);
    const generate = async () => {
        if (validation || !user || !scope) { setError(validation || "当前账号不可用"); return; }
        if (activeLog?.results.some(canQuerySceneResult) && sceneInputMatchesLog(activeLog, form, images, config, selection)) {
            setError("相同输入已有未结束的原请求，请先查询原请求。修改设计输入后才会创建新任务。"); setRecoveredRequestId(activeLog.id); return;
        }
        let prompt = form.description.trim() || form.change.trim();
        const promptInput = scenePromptInput(sceneId, form);
        let optimized = false;
        const release = workbenchSubmissions.acquire(`creative:${user.id}:${sceneId}`);
        if (!release) { setError("图片任务正在处理，请勿重复提交"); return; }
        const revision = epoch.current;
        try {
            for (const summary of await history!.pending()) {
                const prior = await history!.read(summary.id);
                if (revision !== epoch.current) { release(); return; }
                if (sceneInputMatchesLog(prior, form, images, config, selection)) {
                    const restored = await hydrateLog(prior);
                    if (revision === epoch.current) { setActiveLog(restored); setResults(restored.results); setRecoveredRequestId(restored.id); setError("相同输入已有未结束的原请求，请先查询原请求。修改设计输入后才会创建新任务。"); }
                    release(); return;
                }
            }
        } catch (caught) { release(); if (revision === epoch.current) setError(`无法核对原请求，未提交新任务：${errorText(caught)}`); return; }
        const requestConfig = { ...config, count: "1" };
        const snapshot: SceneDraft = { form: cloneSceneForm(form), images: { ...images }, config: sceneParameters(config), selection };
        const pending: SceneResult[] = Array.from({ length: count }, () => ({ id: nanoid(), requestId: `${nanoid()}:0`, status: "pending" }));
        const logId = nanoid(), createdAt = Date.now();
        const start = performance.now();
        const storageWarnings: string[] = [];
        viewEpoch.current += 1;
        setRunning(true); setError(null); setNotice(null); setActiveLog(null); setSelectedPrompt(null); setPreviewing(false); setResults(pending); setStartedAt(start);
        const updateResult = (index: number, result: SceneResult) => {
            if (revision === epoch.current) setResults(current => current.map((item, itemIndex) => itemIndex === index ? result : item));
        };
        try {
            snapshot.images = Object.fromEntries(await Promise.all(slots.flatMap(slot => snapshot.images[slot] ? [freezeLocalInput(snapshot.images[slot]!).then(image => [slot, image])] : [])));
            if (snapshot.selection) snapshot.selection = { ...snapshot.selection, mask: await freezeLocalInput(snapshot.selection.mask) };
            snapshot.config = { ...snapshot.config, model: selectedModel?.id || model, imageModel: selectedModel?.id || model };
            let requestReferences: SceneImage[] = sceneSlots.flatMap(slot => snapshot.images[slot.id] ? [snapshot.images[slot.id]!] : []);
            if (sceneId === "local-restyle" && snapshot.selection && snapshot.images.primary) {
                const guideBlob = await createSelectionGuide(snapshot.images.primary.dataUrl, snapshot.selection.mask.dataUrl);
                const guide = await uploadImage(guideBlob);
                requestReferences = [snapshot.images.primary, await freezeLocalInput({ id: nanoid(), name: "蓝色选区示意.png", dataUrl: guide.url, storageKey: guide.storageKey, type: guide.mimeType, mimeType: guide.mimeType, width: guide.width, height: guide.height, bytes: guide.bytes })];
                promptInput.fields = { ...promptInput.fields, selectionGuide: true };
                promptInput.referenceRoles = ["服装主图", "蓝色局部修改选区示意图"];
            }
            const preparedValidation = validateImageReferences(model, requestReferences);
            if (!preparedValidation.valid) throw new Error(preparedValidation.message || "参考图数量不受当前模型支持");
            // Preparing a guide is local and may outlive navigation or an account change.
            // Do not start a paid request for a workspace that is no longer active.
            if (revision !== epoch.current) return;
            const runLog: SceneLog = { id: logId, ownerId: user.id, sceneId, createdAt, prompt, userInput: promptInput, optimized, form: snapshot.form, referenceImages: snapshot.images,
                submittedReferences: requestReferences, config: snapshot.config, selection: snapshot.selection, operation: "ai", inputArchiveVersion: 1, results: pending, images: [], durationMs: 0, successCount: 0, failCount: 0 };
            const persistRun = async () => {
                if (revision !== epoch.current || useUserStore.getState().user?.id !== user.id) throw new Error("员工或场景已变化，未继续提交");
                await history!.save(serializeSceneLog(runLog));
                if (revision !== epoch.current || useUserStore.getState().user?.id !== user.id) throw new Error("员工或场景已变化，未继续提交");
                rememberLog(runLog); setActiveLog({ ...runLog });
            };
            const completed = await Promise.all(pending.map(async (item, index) => {
                const itemStart = performance.now();
                const tracked = item;
                let submitted = false;
                try {
                    const options = { operationType, tool: `creative-${sceneId}`, promptInput, onOptimizing: () => { if (revision === epoch.current) setOptimizing(true); }, onCompiled: (finalPrompt: string, wasOptimized: boolean) => { prompt = finalPrompt; optimized = wasOptimized; runLog.prompt = finalPrompt; runLog.optimized = wasOptimized; if (revision === epoch.current) setOptimizing(false); }, requestId: sceneRootRequestId(tracked), onSubmissionStarted: async () => { await persistRun(); submitted = true; }, onSubmitted: async (ids: string[]) => { tracked.taskId = ids[0]; await persistRun(); } };
                    const generated = requestReferences.length ? await requestEdit(requestConfig, prompt, requestReferences, undefined, options) : await requestGeneration(requestConfig, prompt, options);
                    const result = await storeSceneResult(tracked, generated[0], index, sceneId, snapshot, message => storageWarnings.push(message));
                    if (result.image) result.image.durationMs = performance.now() - itemStart;
                    updateResult(index, result);
                    return result;
                } catch (caught) {
                    const result: SceneResult = { id: item.id, ...sceneFailure(caught, submitted, tracked.taskId, tracked.requestId) };
                    updateResult(index, result); return result;
                }
            }));
            const successes = completed.flatMap(result => result.image ? [result.image] : []);
            const log: SceneLog = { ...runLog, prompt, userInput: promptInput, optimized, form: snapshot.form, referenceImages: snapshot.images,
                config: snapshot.config, selection: snapshot.selection, operation: "ai", inputArchiveVersion: 1, results: completed, images: successes, durationMs: performance.now() - start, successCount: successes.length, failCount: count - successes.length };
            if (revision === epoch.current) {
                setResults(completed); rememberLog(log); setActiveLog(log);
                if (!successes.length) setError(completed[0]?.error || "生成失败");
                else if (storageWarnings.length) setError(storageWarnings.join("；"));
            }
            try {
                await history!.save(serializeSceneLog(log));
            } catch (caught) { if (revision === epoch.current) setError(`生成结果仍保留在页面，但本地记录保存失败：${errorText(caught)}`); }
        } catch (caught) { if (revision === epoch.current) { setError(errorText(caught)); setResults(pending.map(item => ({ ...item, status: "failed", error: errorText(caught) }))); } }
        finally { release(); if (revision === epoch.current) { setRunning(false); setOptimizing(false); } }
    };

    const retryResult = async (result: SceneResult) => {
        if (!user || !history || !activeLog || running || loading || !toolEnabled || !canRetrySceneResult(result)) return;
        const release = workbenchSubmissions.acquire(`creative:${user.id}:${sceneId}`);
        if (!release) { setError("当前场景正在处理任务，请勿重复提交"); return; }
        const revision = epoch.current, originalId = activeLog.id, start = performance.now(), retryId = nanoid();
        const pending: SceneResult = { id: nanoid(), status: "pending", requestId: `${nanoid()}:0` };
        let submitted = false;
        setRunning(true); setError(null); setNotice(null); setStartedAt(start); viewEpoch.current += 1;
        try {
            const original = await history.read(originalId);
            const storedResult = original.results.find(item => item.id === result.id);
            if (!storedResult) throw new Error("原失败记录已变化，请重新打开历史");
            const prepared = await prepareSceneRetry(original, storedResult, models, user.id);
            const submittedReferences = await Promise.all(prepared.input.references.map((reference, index) => freezeLocalInput({ ...reference, width: original.submittedReferences?.[index]?.width || 0, height: original.submittedReferences?.[index]?.height || 0, bytes: original.submittedReferences?.[index]?.bytes || 0, mimeType: reference.type })));
            if (revision !== epoch.current) return;
            // Persist consumption of this failure before POST. Returning to the old log must
            // never replay an uncertain retry; the new retry record becomes the next link.
            const consumed = { ...original, results: original.results.map(item => item.id === result.id ? { ...item, retryLogId: retryId } : item) };
            await history.save(serializeSceneLog(consumed));
            if (revision !== epoch.current) return;
            setActiveLog(null); setResults([pending]); setSelectedPrompt(original.prompt);
            const warnings: string[] = [];
            const retryLog: SceneLog = { ...original, id: retryId, createdAt: Date.now(), config: { ...original.config, count: "1" }, results: [pending], images: [], successCount: 0, failCount: 0, durationMs: 0,
                referenceImages: prepared.referenceImages, selection: prepared.selection, userInput: prepared.input.promptInput,
                submittedReferences,
                retryOf: { logId: original.id, resultId: result.id, taskId: result.taskId! } };
            const persistRetry = async () => {
                if (revision !== epoch.current || useUserStore.getState().user?.id !== user.id) throw new Error("员工或场景已变化，未继续重试");
                await history.save(serializeSceneLog(retryLog));
                if (revision !== epoch.current || useUserStore.getState().user?.id !== user.id) throw new Error("员工或场景已变化，未继续重试");
                rememberLog(retryLog); setActiveLog({ ...retryLog });
            };
            let completed: SceneResult;
            try {
                const generated = await requestQueuedImages({ ...prepared.input, requestId: sceneRootRequestId(pending), onOptimizing: () => { if (revision === epoch.current) setOptimizing(true); }, onCompiled: (prompt, optimized) => { retryLog.prompt = prompt; retryLog.optimized = optimized; if (revision === epoch.current) setOptimizing(false); },
                    onSubmissionStarted: async () => { await persistRetry(); submitted = true; }, onSubmitted: async ids => { pending.taskId = ids[0]; await persistRetry(); } });
                completed = await storeSceneResult(pending, generated[0], 0, sceneId, { images: prepared.referenceImages, selection: prepared.selection }, message => warnings.push(message));
            } catch (caught) { completed = { id: pending.id, ...sceneFailure(caught, submitted, pending.taskId, pending.requestId) }; }
            const log: SceneLog = { ...retryLog, results: [completed],
                images: completed.image ? [completed.image] : [], successCount: completed.image ? 1 : 0, failCount: completed.image ? 0 : 1, durationMs: performance.now() - start,
                retryOf: { logId: original.id, resultId: result.id, taskId: result.taskId! } };
            if (revision === epoch.current) { setResults(log.results); setActiveLog(log); rememberLog(log); if (completed.error || warnings.length) setError(completed.error || warnings.join("；")); }
            try { await history.save(serializeSceneLog(log)); }
            catch (caught) { if (revision === epoch.current) setError(`重试结果仍保留在页面，但本地记录保存失败：${errorText(caught)}`); }
        } catch (caught) { if (revision === epoch.current) setError(`未提交重试：${errorText(caught)}`); }
        finally { release(); if (revision === epoch.current) { setRunning(false); setOptimizing(false); } }
    };

    const queryResult = async (result: SceneResult, continueSubmission = false) => {
        if (!user || !history || !activeLog || running || loading || !canQuerySceneResult(result)) return;
        const release = workbenchSubmissions.acquire(`creative:${user.id}:${sceneId}`);
        if (!release) return;
        const revision = epoch.current, originalId = activeLog.id;
        const assertCurrent = () => { if (revision !== epoch.current || useUserStore.getState().user?.id !== user.id) throw new Error("员工或场景已变化，未继续原请求"); };
        setRunning(true); setOptimizing(false); setError(null); setNotice(null);
        try {
            let log = await history.read(originalId);
            let currentResult = log.results.find(item => item.id === result.id);
            if (!currentResult) throw new Error("原结果记录已变化，请重新打开历史");
            const original = await readSceneRequest(log, currentResult, user.id);
            assertCurrent();
            const commit = async (next: SceneResult, patch: Partial<SceneLog> = {}) => {
                assertCurrent();
                const results = log.results.map(item => item.id === next.id ? next : item);
                log = { ...log, ...patch, results, images: results.flatMap(item => item.image ? [item.image] : []), successCount: results.filter(item => item.status === "success").length, failCount: results.filter(item => item.status === "failed" && item.failureKind !== "uncertain").length };
                await history.save(serializeSceneLog(log)); assertCurrent(); currentResult = next;
                setActiveLog(log); setResults(results); setSelectedPrompt(log.prompt); rememberLog(log);
            };
            const restoreSnapshot = async () => {
                if (!log.selection) return { images: log.referenceImages, selection: null };
                const restoredImages: SceneImages = Object.fromEntries(await Promise.all(Object.entries(log.referenceImages).map(async ([slot, image]) => [slot, await restoreLocalInput(image!)])));
                const restoredSelection = { ...log.selection, mask: await restoreLocalInput(log.selection.mask) };
                if (!selectionMatchesSource(restoredSelection, restoredImages.primary)) throw new Error("原选区与参考图不匹配，未恢复或提交");
                assertCurrent(); return { images: restoredImages, selection: restoredSelection };
            };
            if (original.task) {
                const task = original.task;
                const patch = { prompt: task.prompt || log.prompt, userInput: task.userInput || log.userInput, optimized: task.optimized === true };
                if (task.status === "success") {
                    if (!task.resultUrls[0]) throw new Error("原任务成功但未返回结果图片，请勿重新生成");
                    const snapshot = await restoreSnapshot(); assertCurrent();
                    const completed = await storeSceneResult({ ...currentResult, taskId: task.id, failureKind: undefined, error: undefined, compilationId: undefined }, { id: `${task.id}:0`, dataUrl: task.resultUrls[0], sourceTaskId: task.id, prompt: patch.prompt, userInput: patch.userInput, optimized: patch.optimized }, 0, sceneId, snapshot, text => setNotice(text));
                    await commit(completed, patch); setNotice("已找回原任务结果，没有重新生成或扣费。");
                } else if (task.status === "failed" || task.status === "cancelled") {
                    await commit({ id: currentResult.id, ...sceneFailure(new QueuedTaskFailedError(task), true, task.id, task.requestId) }, patch);
                } else {
                    await commit({ ...currentResult, taskId: task.id, requestId: task.requestId, status: "pending", failureKind: "uncertain", compilationId: undefined, error: task.failureReason || "原图片任务仍在执行，可稍后查询；不会重新提交。" }, patch);
                    setNotice("原图片任务尚未结束，本次仅查询了原任务。");
                }
                return;
            }
            const compilation = original.compilation;
            if (compilation?.status === "failed") {
                await commit({ ...currentResult, status: "failed", failureKind: "local", compilationId: undefined, error: compilation.message || "原提示词优化已失败，未创建图片任务。" });
                return;
            }
            if (compilation?.status !== "success" || !compilation.prompt?.trim()) {
                await commit({ ...currentResult, status: "failed", failureKind: "uncertain", compilationId: undefined, error: compilation?.message || "原请求仍在优化或状态待核查。可稍后查询，不会自动重新提交。" });
                return;
            }
            await commit({ ...currentResult, status: "failed", failureKind: "uncertain", compilationId: compilation.id, error: "原提示词已优化完成，图片任务尚未查到。可明确点击继续原请求；仍使用原请求编号，不会重复优化或创建两张图片。" }, { prompt: compilation.prompt, optimized: compilation.optimized });
            if (!continueSubmission) return;
            if (!toolEnabled || !log.userInput || !log.submittedReferences || !sceneRootRequestId(currentResult)) throw new Error("缺少原始提交归档或场景已停用，无法安全继续原请求");
            const restoredReferences = await Promise.all(log.submittedReferences.map(restoreLocalInput));
            const snapshot = await restoreSnapshot(); assertCurrent();
            const promptInput = { ...log.userInput, compilationId: compilation.id };
            const requestConfig = { ...effectiveConfig, ...log.config, count: "1" };
            let submitted = false;
            try {
                const options = { operationType, tool: `creative-${sceneId}`, requestId: sceneRootRequestId(currentResult), promptInput,
                    onSubmissionStarted: async () => { await commit({ ...currentResult!, status: "pending", error: "正在继续原图片任务…" }); submitted = true; },
                    onSubmitted: async (ids: string[]) => { await commit({ ...currentResult!, taskId: ids[0], status: "pending" }); } };
                const generated = restoredReferences.length ? await requestEdit(requestConfig, compilation.prompt, restoredReferences, undefined, options) : await requestGeneration(requestConfig, compilation.prompt, options);
                assertCurrent();
                const completed = await storeSceneResult({ ...currentResult!, failureKind: undefined, error: undefined, compilationId: undefined }, generated[0], 0, sceneId, snapshot, text => setNotice(text));
                await commit(completed, { prompt: generated[0]?.prompt || compilation.prompt, userInput: generated[0]?.userInput || promptInput, optimized: generated[0]?.optimized ?? compilation.optimized });
            } catch (caught) {
                assertCurrent();
                await commit({ id: currentResult!.id, ...sceneFailure(caught, submitted, currentResult!.taskId, currentResult!.requestId) });
            }
        } catch (caught) { if (revision === epoch.current) setError(errorText(caught)); }
        finally { release(); if (revision === epoch.current) { setRunning(false); setOptimizing(false); } }
    };

    const resultAction = async (action: "saveAsset" | "canvas" | "reference", image: SceneImage) => {
        if (!resultActions || !activeLog || resultActionGate.current || running) return;
        const revision = epoch.current;
        resultActionGate.current = true; setResultActionBusy(true); setError(null); setNotice(null);
        try {
            const value = await resultActions[action](image, activeLog);
            if (revision !== epoch.current) return;
            if (action === "saveAsset") { setNotice("原图已保存到素材库。"); return; }
            return value;
        } catch (caught) { if (revision === epoch.current) setError(errorText(caught)); }
        finally { resultActionGate.current = false; if (revision === epoch.current) setResultActionBusy(false); }
    };

    const download = async (image: SceneImage, index = 0) => {
        try {
            const url = await resolveImageUrl(image.storageKey, image.dataUrl);
            if (!url) throw new Error("原图已不可用");
            const response = await fetch(url);
            if (!response.ok) throw new Error(`原图读取失败（${response.status}）`);
            const blob = await response.blob();
            const node = imageCopyEditorNode({ ...image, title: image.name || `设计结果-${index + 1}`, mimeType: blob.type || image.mimeType });
            saveAs(blob, canvasImageDownloadFileName(node));
        } catch (caught) { setError(errorText(caught)); }
    };

    const updateForm: typeof setForm = (value) => { viewEpoch.current += 1; setRestoring(false); setPreviewing(false); setSelectedPrompt(null); setForm(value); };
    return { form, setForm: updateForm, images, setImage, selection, saveSelection, clearSelection: () => { if (!running) { viewEpoch.current += 1; setRestoring(false); setPreviewing(false); setSelectedPrompt(null); setSelection(null); setError(null); } }, saveLocalResult, config, updateConfig, model, profile, count, running, optimizing, loading,
        uploading: uploadCount > 0, logs, historyTotal, historyHasMore, historyLoading, loadMoreHistory, activeLog, selectedPrompt, previewing, previewLog, selectResultPrompt, results, generate, restoreLog, reset, error, validation,
        quotaBlocked, estimatedCredits: estimateValue.credits, download, startedAt, notice, resultActionBusy, resultAction, retryResult, queryResult, recoveredRequestId };
}
