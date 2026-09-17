import { useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";
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
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { buildScenePrompt, createSceneForm, getSceneSlots, validateSceneForm, type SceneForm, type SceneSlotId } from "./scene-form-model";
import { compositeSelectedImage, createSelectionGuide } from "./image-processing-browser";
import { preferredSelectionSize, selectionPrompt, selectionSizeMatches } from "./image-processing";

export type SceneImage = ReferenceImage & {
    width: number; height: number; bytes: number; mimeType: string;
    sourceTaskId?: string; durationMs?: number;
};
export type SceneImages = Partial<Record<SceneSlotId, SceneImage>>;
export type SceneParameters = Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count">;
export type SceneSelection = { sourceId: string; mask: SceneImage };
export type SceneResult = { id: string; status: "pending" | "success" | "failed"; image?: SceneImage; uncompositedImage?: SceneImage; error?: string };
export type SceneLog = {
    id: string; ownerId: string; sceneId: string; createdAt: number; prompt: string;
    form: SceneForm; referenceImages: SceneImages; config: SceneParameters;
    results: SceneResult[]; images: SceneImage[]; durationMs: number; successCount: number; failCount: number;
    selection?: SceneSelection | null; operation?: "ai" | "recolor";
};
type SceneDraft = { form: SceneForm; images: SceneImages; config: SceneParameters; selection?: SceneSelection | null };

const storage = localforage.createInstance({ name: "wireless-canvas", storeName: "creative_scene_workspaces" });
const draftWrites = new Map<string, Promise<void>>();
const slots: SceneSlotId[] = ["primary", "secondary"];
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";

/** Only these image settings may enter a local draft or history record. */
export function sceneParameters(config: SceneParameters): SceneParameters {
    return { model: config.model, imageModel: config.imageModel, size: config.size, quality: config.quality, count: config.count };
}

function storedImage(image: SceneImage): SceneImage {
    return { ...image, dataUrl: image.storageKey || image.dataUrl.startsWith("blob:") ? "" : image.dataUrl, url: undefined };
}

function mapImages(images: SceneImages, map: (image: SceneImage) => SceneImage): SceneImages {
    return Object.fromEntries(slots.flatMap(slot => images[slot] ? [[slot, map(images[slot]!)]] : []));
}

export function serializeSceneDraft(draft: SceneDraft): SceneDraft {
    return { form: { ...draft.form }, images: mapImages(draft.images, storedImage), config: sceneParameters(draft.config),
        selection: draft.selection ? { ...draft.selection, mask: storedImage(draft.selection.mask) } : null };
}

export function serializeSceneLog(log: SceneLog): SceneLog {
    return {
        ...log, form: { ...log.form }, config: sceneParameters(log.config),
        referenceImages: mapImages(log.referenceImages, storedImage),
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
    const [logs, setLogs] = useState<SceneLog[]>([]);
    const [activeLog, setActiveLog] = useState<SceneLog | null>(null);
    const [results, setResults] = useState<SceneResult[]>([]);
    const [running, setRunning] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [uploadCount, setUploadCount] = useState(0);
    const [startedAt, setStartedAt] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const loading = loadedScope !== scope || restoring;
    const model = parameters.imageModel || parameters.model || effectiveConfig.imageModel || effectiveConfig.model;
    const profile = useImageModelProfile(model);
    const normalized = normalizeImageModelSettings(parameters, profile);
    const config = useMemo(() => ({ ...effectiveConfig, ...parameters, ...normalized, model, imageModel: model }),
        [effectiveConfig, parameters, normalized.size, normalized.quality, normalized.count, model]);
    const count = Number(normalized.count);
    const sceneSlots = getSceneSlots(sceneId, form);
    const references = sceneSlots.flatMap(slot => images[slot.id] ? [images[slot.id]!] : []);
    const editing = sceneSlots.length > 0;
    const operationType = editing ? "inpaint" as const : "image_generation" as const;
    const selectedModel = models.find(item => item.id === model || item.modelId === modelOptionName(model) || item.name === model);
    const estimateValue = estimate({ modelId: modelOptionName(model), operationType, quantity: count });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimateValue.configured && user.creditBalance < estimateValue.credits);
    const referenceValidation = validateImageReferences(model, references);
    const validation = loading ? "正在读取当前板块的数据"
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
        setForm(createSceneForm(sceneId)); setImages({}); setSelection(null); setLogs([]); setResults([]); setActiveLog(null);
        setParameters(sceneParameters(configRef.current)); setRunning(false); setRestoring(false); setUploadCount(0); setStartedAt(0); setError(null); setDraftReady(false);
        if (!scope) { setLoadedScope(null); return () => { epoch.current += 1; }; }
        void (async () => {
            try {
                await draftWrites.get(scope);
                const [draft, history] = await Promise.all([storage.getItem<SceneDraft>(`draft:${scope}`), storage.getItem<SceneLog[]>(`history:${scope}`)]);
                const ownHistory = (history || []).filter(log => log.sceneId === sceneId && log.ownerId === user?.id);
                const restoredHistory = await Promise.all(ownHistory.map(async log => {
                    try { return await hydrateLog(log); } catch { return log; }
                }));
                if (revision !== epoch.current) return;
                setLogs(restoredHistory);
                if (draft) {
                    setForm({ ...createSceneForm(sceneId), ...draft.form }); setParameters(sceneParameters(draft.config)); setImages(draft.images); setSelection(draft.selection || null);
                    try {
                        const restoredImages = await hydrateImages(draft.images);
                        if (revision === epoch.current) setImages(restoredImages);
                        const restoredSelection = await hydrateSelection(draft.selection, restoredImages);
                        if (revision === epoch.current) setSelection(restoredSelection);
                    } catch (caught) { if (revision === epoch.current) setError(errorText(caught)); }
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
        const draft = serializeSceneDraft({ form, images, config, selection });
        const write = (draftWrites.get(scope) || Promise.resolve()).then(() => storage.setItem(`draft:${scope}`, draft)).then(() => undefined).catch(caught => {
            if (scopeRef.current === scope) setError(`草稿保存失败：${errorText(caught)}`);
        });
        draftWrites.set(scope, write);
        void write.then(() => { if (draftWrites.get(scope) === write) draftWrites.delete(scope); });
    }, [scope, loadedScope, draftReady, form, images, config, selection]);

    const updateConfig = (key: keyof SceneParameters, value: string) => setParameters(current =>
        key === "model" || key === "imageModel" ? { ...current, model: value, imageModel: value } : { ...current, [key]: value });

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
        setForm(createSceneForm(sceneId)); setImages({}); setSelection(null); setResults([]); setActiveLog(null); setError(null); setStartedAt(0);
    };

    const restoreLog = async (log: SceneLog) => {
        if (running || log.ownerId !== user?.id || log.sceneId !== sceneId) return;
        const revision = epoch.current;
        const viewRevision = ++viewEpoch.current;
        inputEpoch.current.primary += 1; inputEpoch.current.secondary += 1;
        setRestoring(true); setError(null);
        try {
            const [restored, restoredImages] = await Promise.all([hydrateLog(log), hydrateImages(log.referenceImages)]);
            const restoredSelection = await hydrateSelection(log.selection, restoredImages);
            if (revision !== epoch.current || viewRevision !== viewEpoch.current) return;
            setForm({ ...createSceneForm(sceneId), ...log.form }); setImages(restoredImages); setParameters(sceneParameters(log.config));
            setSelection(restoredSelection);
            setActiveLog(restored); setResults(restored.results); setStartedAt(0);
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
        setRunning(true); setError(null); setStartedAt(start);
        try {
            const stored = await uploadImage(blob);
            const image: SceneImage = { ...stored, id: nanoid(), name: "精确换色结果.png", dataUrl: stored.url, type: stored.mimeType, ...canvasImageReferenceIdentity(images.primary) };
            const result: SceneResult = { id: nanoid(), status: "success", image };
            const log: SceneLog = { id: nanoid(), ownerId: user.id, sceneId, createdAt: Date.now(), prompt: description,
                form: { ...form }, referenceImages: { primary: images.primary }, config: sceneParameters(config), operation: "recolor",
                results: [result], images: [image], durationMs: performance.now() - start, successCount: 1, failCount: 0 };
            if (revision === epoch.current) { setResults([result]); setLogs(current => [log, ...current]); setActiveLog(log); }
            try {
                const previous = await storage.getItem<SceneLog[]>(`history:${scope}`) || [];
                await storage.setItem(`history:${scope}`, [serializeSceneLog(log), ...previous]);
            } catch (caught) { if (revision === epoch.current) setError(`换色结果仍保留在页面，但本地记录保存失败：${errorText(caught)}`); }
        } finally { if (revision === epoch.current) setRunning(false); }
    };

    const generate = async () => {
        if (validation || !user || !scope) { setError(validation || "当前账号不可用"); return; }
        let prompt: string;
        try { prompt = buildScenePrompt(sceneId, form); }
        catch (caught) { setError(errorText(caught)); return; }
        const release = workbenchSubmissions.acquire(`image:${user.id}`);
        if (!release) { setError("图片任务正在处理，请勿重复提交"); return; }
        const revision = epoch.current;
        const requestConfig = { ...config, count: "1" };
        const snapshot: SceneDraft = { form: { ...form }, images: { ...images }, config: sceneParameters(config), selection };
        const pending: SceneResult[] = Array.from({ length: count }, () => ({ id: nanoid(), status: "pending" }));
        const start = performance.now();
        const storageWarnings: string[] = [];
        setRunning(true); setError(null); setActiveLog(null); setResults(pending); setStartedAt(start);
        const updateResult = (index: number, result: SceneResult) => {
            if (revision === epoch.current) setResults(current => current.map((item, itemIndex) => itemIndex === index ? result : item));
        };
        try {
            let requestReferences: ReferenceImage[] = references;
            if (sceneId === "local-restyle" && snapshot.selection && snapshot.images.primary) {
                const guideBlob = await createSelectionGuide(snapshot.images.primary.dataUrl, snapshot.selection.mask.dataUrl);
                const guide = await uploadImage(guideBlob);
                requestReferences = [snapshot.images.primary, { id: nanoid(), name: "蓝色选区示意.png", dataUrl: guide.url, storageKey: guide.storageKey, type: guide.mimeType }];
                prompt += `\n\n${selectionPrompt}`;
            }
            const preparedValidation = validateImageReferences(model, requestReferences);
            if (!preparedValidation.valid) throw new Error(preparedValidation.message || "参考图数量不受当前模型支持");
            // Preparing a guide is local and may outlive navigation or an account change.
            // Do not start a paid request for a workspace that is no longer active.
            if (revision !== epoch.current) return;
            const settled = await Promise.allSettled(pending.map(async (item, index) => {
                const itemStart = performance.now();
                try {
                    const options = { operationType, tool: `creative-${sceneId}` };
                    const generated = requestReferences.length ? await requestEdit(requestConfig, prompt, requestReferences, undefined, options) : await requestGeneration(requestConfig, prompt, options);
                    const source = generated[0];
                    if (!source) throw new Error("接口没有返回图片");
                    let image: SceneImage;
                    try {
                        const stored = await uploadImage(source.dataUrl);
                        image = { ...source, ...stored, dataUrl: stored.url, name: `设计结果-${index + 1}`, type: stored.mimeType, ...canvasImageReferenceIdentity(references[0]) };
                    } catch (caught) {
                        const meta = await readImageMeta(source.dataUrl);
                        image = { ...source, ...meta, name: `设计结果-${index + 1}`, type: meta.mimeType, bytes: getDataUrlByteSize(source.dataUrl), ...canvasImageReferenceIdentity(references[0]) };
                        storageWarnings.push(`第 ${index + 1} 张原图未能保存到本地：${errorText(caught)}`);
                    }
                    if (sceneId === "local-restyle" && snapshot.selection && snapshot.images.primary) {
                        const raw = image;
                        try {
                            const composited = await compositeSelectedImage(snapshot.images.primary.dataUrl, image.dataUrl, snapshot.selection.mask.dataUrl);
                            const stored = await uploadImage(composited);
                            image = { ...image, ...stored, dataUrl: stored.url, type: stored.mimeType, name: `选区合成-${index + 1}.png` };
                        } catch (caught) {
                            const result: SceneResult = { id: item.id, status: "failed", uncompositedImage: raw, error: `选区合成未完成：${errorText(caught)}。AI 原始结果已保留，可下载检查。` };
                            updateResult(index, result); return result;
                        }
                    }
                    image.durationMs = performance.now() - itemStart;
                    const result: SceneResult = { id: item.id, status: "success", image };
                    updateResult(index, result);
                    return result;
                } catch (caught) {
                    updateResult(index, { id: item.id, status: "failed", error: errorText(caught) });
                    throw caught;
                }
            }));
            const completed: SceneResult[] = settled.map((result, index) => result.status === "fulfilled" ? result.value : { id: pending[index]!.id, status: "failed", error: errorText(result.reason) });
            const successes = completed.flatMap(result => result.image ? [result.image] : []);
            const log: SceneLog = { id: nanoid(), ownerId: user.id, sceneId, createdAt: Date.now(), prompt, form: snapshot.form, referenceImages: snapshot.images,
                config: snapshot.config, selection: snapshot.selection, operation: "ai", results: completed, images: successes, durationMs: performance.now() - start, successCount: successes.length, failCount: count - successes.length };
            if (revision === epoch.current) {
                setResults(completed); setLogs(current => [log, ...current]); setActiveLog(log);
                if (!successes.length) setError(completed[0]?.error || "生成失败");
                else if (storageWarnings.length) setError(storageWarnings.join("；"));
            }
            try {
                const previous = await storage.getItem<SceneLog[]>(`history:${scope}`) || [];
                await storage.setItem(`history:${scope}`, [serializeSceneLog(log), ...previous.filter(item => item.id !== log.id)]);
            } catch (caught) { if (revision === epoch.current) setError(`生成结果仍保留在页面，但本地记录保存失败：${errorText(caught)}`); }
        } catch (caught) { if (revision === epoch.current) { setError(errorText(caught)); setResults(pending.map(item => ({ ...item, status: "failed", error: errorText(caught) }))); } }
        finally { release(); if (revision === epoch.current) setRunning(false); }
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

    return { form, setForm, images, setImage, selection, saveSelection, clearSelection: () => { if (!running) { setSelection(null); setError(null); } }, saveLocalResult, config, updateConfig, model, profile, count, running, loading,
        uploading: uploadCount > 0, logs, activeLog, results, generate, restoreLog, reset, error, validation,
        quotaBlocked, estimatedCredits: estimateValue.credits, download, startedAt };
}
