import { BookmarkPlus, Check, Copy, Download, LoaderCircle, PencilLine, Plus, RotateCcw, Search, Share2, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Card, DatePicker, Drawer, Empty, Form, Image, Input, Modal, Segmented, Select, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { saveAs } from "file-saver";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useModuleEnabled } from "@/stores/use-module-store";
import { InfiniteLoadMore } from "@/components/infinite-load-more";

import { useCopyText } from "@/hooks/use-copy-text";
import { imageModelDisplayName } from "@/lib/model-display";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useWorkbenchField } from "@/hooks/use-workbench-field";
import { useImageCopyEditor } from "@/hooks/use-image-copy-editor";
import { imageCopyEditorNode } from "@/lib/image-edit-copy";
import { needsCanvasAssetPreviewResolution, resolveCanvasAssetPreview } from "@/lib/canvas/canvas-asset-preview";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { createClientId } from "@/lib/client-id";
import { createZip } from "@/lib/zip";
import { loadCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { cn } from "@/lib/utils";
import { isSupportedServerAsset, serverAssetToLocal } from "@/lib/server-asset-local";
import { canUserAccessAsset, serverAssetIdFromAsset, useAssetStore, type Asset, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { useDesignLibraryShare } from "@/pages/design-library/use-design-library-share";
import { useUserStore } from "@/stores/use-user-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import { buildAssetSearchIndex, searchAssetIndex } from "./asset-search";
import { assetCanvasNodes, assetCanvasViewport, selectAssetRange } from "./asset-batch";
import { compareAssetCreatedAt, filterLocalAssets, patchAssetProjection, uploadAssetBatch, type AssetUploadJob } from "./asset-library-state";
import {
    deleteServerAsset,
    updateServerAssetMetadata,
    fetchServerAssetContent,
    fetchServerAsset,
    batchServerAssets,
    listServerAssets,
    listDeletedServerAssets,
    restoreServerAsset,
    listServerProjects,
    recordServerAssetDownload,
    recordServerAssetEvent,
    setServerAssetVisibility,
    shareServerAssetWithDepartment,
    unshareServerAssetWithDepartment,
    uploadServerAsset,
    type AssetEventType,
    type ServerAsset,
    type UserProject,
    type AssetListQuery,
    type ServerAssetPage,
} from "@/services/api/server-assets";
import { savePromptFromAsset } from "@/services/api/prompts";

const CanvasImageEditorDialog = lazy(() => import("@/components/canvas/canvas-image-editor-dialog").then(module => ({ default: module.CanvasImageEditorDialog })));

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

export default function AssetsPage() {
    const { message, modal } = App.useApp();
    const libraryShare = useDesignLibraryShare();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const referenceImportEnabled = useModuleEnabled("reference-import");
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const batchImageInputRef = useRef<HTMLInputElement>(null);
    const localAssets = useAssetStore((state) => state.assets);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const selectionAnchor = useRef<string | null>(null);
    const [batchTarget, setBatchTarget] = useState<"canvas" | "project" | null>(null);
    const [targetId, setTargetId] = useState<string>();
    const canvasProjects = useCanvasStore(state => state.projects);
    const unloadedCanvasProjects = useCanvasStore(state => state.unloadedProjects);
    const [assetAction, setAssetAction] = useState("");
    const assetActionRef = useRef(false);
    const [serverProjects, setServerProjects] = useState<UserProject[]>([]);
    const user = useUserStore((state) => state.user);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useWorkbenchField("assets:keyword", "");
    const deferredKeyword = useDeferredValue(keyword);
    const [kindFilter, setKindFilter] = useWorkbenchField<AssetKind | "all">("assets:kind", "all");
    const [libraryView, setLibraryView] = useState<"active" | "trash">("active");
    const [tagFilter, setTagFilter] = useState("");
    const deferredTag = useDeferredValue(tagFilter.trim());
    const [projectFilter, setProjectFilter] = useState<string>();
    const [dateRange, setDateRange] = useState<[string, string] | null>(null);
    const [sort, setSort] = useState<"newest" | "oldest">("newest");
    const [failedUploads, setFailedUploads] = useState<AssetUploadJob[]>([]);
    const uploadAbort = useRef<AbortController | null>(null);
    const assetQuery: AssetListQuery = { q: deferredKeyword || undefined, kind: kindFilter === "all" ? undefined : kindFilter,
        tag: deferredTag || undefined, projectId: projectFilter, createdFrom: dateRange?.[0], createdBefore: dateRange?.[1], sort };
    const assetQueryKey = ["asset-library", user?.id, libraryView, assetQuery] as const;
    const hasFilters = Boolean(keyword || kindFilter !== "all" || tagFilter || projectFilter || dateRange);
    const clearFilters = () => { setKeyword(""); setKindFilter("all"); setTagFilter(""); setProjectFilter(undefined); setDateRange(null); };
    const assetPages = useInfiniteQuery({
        queryKey: assetQueryKey,
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) => (libraryView === "trash" ? listDeletedServerAssets : listServerAssets)({ ...assetQuery, limit: 60, cursor: pageParam }, signal),
        getNextPageParam: last => last.hasMore ? last.nextCursor || undefined : undefined,
        enabled: Boolean(user?.id),
        staleTime: 10_000,
        gcTime: 60_000,
        retry: false,
        refetchOnWindowFocus: false,
    });
    const serverAssets = useMemo(() => {
        const unique = new Map<string, ServerAsset>();
        for (const page of assetPages.data?.pages || []) for (const asset of page.assets) {
            if (isSupportedServerAsset(asset)) unique.set(asset.id, asset);
        }
        return [...unique.values()];
    }, [assetPages.data]);
    const serverAssetIds = useMemo(() => new Set(serverAssets.map(asset => asset.id)), [serverAssets]);
    const serverAssetResponse = assetPages.data?.pages.at(-1);
    const serverLoading = assetPages.isFetching;
    const serverError = assetPages.error instanceof Error ? assetPages.error.message : assetPages.isError ? "公司素材加载失败" : "";
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const editingServerAsset = Boolean(editingAsset && serverAssetIds.has(editingAsset.id));
    const { pending: savingAsset, run: runSave } = useAsyncAction(`asset-save:${editingAsset?.id || "new"}`);
    const { pending: deleting, run: runDelete } = useAsyncAction("asset-delete");
    const { run: runSavePrompt } = useAsyncAction("asset-save-prompt");
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const imageEditor = useImageCopyEditor(copy => {
        const saved = useAssetStore.getState().assets.find(asset => asset.id === copy.assetId);
        if (saved) setPreviewAsset(saved);
    });
    const openImageEditor = (asset: Asset) => {
        if (asset.kind !== "image") return;
        imageEditor.open({
            node: imageCopyEditorNode({ id: asset.id, title: asset.title, ...asset.data,
                imageName: typeof asset.metadata?.imageName === "string" ? asset.metadata.imageName : undefined,
                imageVersion: typeof asset.metadata?.imageVersion === "number" ? asset.metadata.imageVersion : undefined,
                originalFileName: typeof asset.metadata?.originalFileName === "string" ? asset.metadata.originalFileName : undefined }),
            originId: metadataString(asset, "imageOriginId") || undefined,
            sourceAssetId: metadataString(asset, "serverAssetId") || asset.id,
            sourceTaskId: metadataString(asset, "sourceTaskId") || undefined,
            prompt: metadataString(asset, "prompt"), model: metadataString(asset, "model"), tags: asset.tags, note: asset.note,
        });
        setPreviewAsset(null);
    };
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [projectAsset, setProjectAsset] = useState<Asset | null>(null);
    const [selectedProjectId, setSelectedProjectId] = useState<string>();
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const refreshServerAssets = async (cursor?: string) => {
        if (!user?.id) return;
        if (cursor) await assetPages.fetchNextPage();
        else await assetPages.refetch();
    };
    useEffect(() => {
        setPreviewAsset(null);
        setEditingAsset(null);
        setDeletingAsset(null);
        setProjectAsset(null);
        setIsAssetOpen(false);
        setSelectedIds(new Set()); selectionAnchor.current = null;
        setBatchTarget(null);
    }, [user?.id, deferredKeyword, kindFilter, libraryView, deferredTag, projectFilter, dateRange, sort]);
    useEffect(() => {
        setFailedUploads([]);
        return () => uploadAbort.current?.abort();
    }, [user?.id]);
    useEffect(() => {
        const controller = new AbortController();
        setServerProjects([]);
        void listServerProjects(controller.signal).then((result) => {
            if (!controller.signal.aborted) setServerProjects(result.projects);
        }).catch(() => undefined);
        return () => controller.abort();
    }, [user?.id]);
    const assets = useMemo(() => libraryView === "trash" ? [] : [...serverAssets.map(serverAssetToLocal), ...localAssets.filter((asset) => !serverAssetIds.has(asset.id) && !serverAssetIds.has(metadataString(asset, "serverAssetId")))], [localAssets, serverAssetIds, serverAssets, libraryView]);
    const validAssets = useMemo(() => assets.filter((asset) => canUserAccessAsset(asset, user, serverAssetIds.has(asset.id)) && (asset.kind === "text" || asset.kind === "image" || asset.kind === "video")), [assets, user, serverAssetIds]);

    const searchIndex = useMemo(() => buildAssetSearchIndex(validAssets.filter(asset => !serverAssetIds.has(asset.id))), [validAssets, serverAssetIds]);
    const filteredAssets = useMemo(() => [...validAssets.filter(asset => serverAssetIds.has(asset.id)), ...filterLocalAssets(searchAssetIndex(searchIndex, deferredKeyword, kindFilter), {
        tag: deferredTag || undefined, projectId: projectFilter, createdFrom: dateRange?.[0], createdBefore: dateRange?.[1],
    })].sort((a, b) => (sort === "oldest" ? 1 : -1) * (compareAssetCreatedAt(a.createdAt, b.createdAt) || a.id.localeCompare(b.id))),
    [validAssets, serverAssetIds, searchIndex, deferredKeyword, kindFilter, deferredTag, projectFilter, dateRange, sort]);

    const visibleAssets = filteredAssets;

    const runAssetAction = async (label: string, run: () => Promise<void>) => {
        if (assetActionRef.current) return;
        assetActionRef.current = true;
        setAssetAction(label);
        try { await run(); }
        catch (error) { message.error(error instanceof Error ? error.message : "素材操作未完成，请重试"); }
        finally { assetActionRef.current = false; setAssetAction(""); }
    };

    const readAssetDetail = async (asset: Asset) => {
        if (!serverAssetIds.has(asset.id)) return asset;
        const ownerId = user?.id;
        const result = await fetchServerAsset(asset.id);
        if (useUserStore.getState().user?.id !== ownerId) throw new Error("账号已切换，请重新打开素材");
        return serverAssetToLocal(result.asset);
    };
    const openDetail = (asset: Asset) => void runAssetAction("正在读取素材详情…", async () => setPreviewAsset(await readAssetDetail(asset)));
    const toggleSelection = (id: string, shift: boolean) => {
        try { setSelectedIds(selectAssetRange(selectedIds, filteredAssets.map(asset => asset.id), id, selectionAnchor.current, shift)); selectionAnchor.current = id; }
        catch (error) { message.warning(error instanceof Error ? error.message : "无法选择素材"); }
    };
    const selectedAssets = validAssets.filter(asset => selectedIds.has(asset.id));
    const executeBatch = async (action: "delete" | "download" | "add-to-canvas" | "move-project") => {
        const requestOwnerId = user?.id;
        const selected = [...selectedAssets];
        if (!selected.length || selected.length > 50) throw new Error("请选择 1 至 50 个素材");
        const serverIds = selected.filter(asset => serverAssetIds.has(asset.id)).map(asset => asset.id);
        if (action === "move-project" && serverIds.length !== selected.length) throw new Error("本地素材请先上传后再移动到项目");
        const result = serverIds.length ? await batchServerAssets(action, serverIds, action === "move-project" ? targetId : undefined) : null;
        if (useUserStore.getState().user?.id !== requestOwnerId) throw new Error("账号已切换，已停止后续操作");
        if (action === "delete") {
            selected.filter(asset => !serverAssetIds.has(asset.id)).forEach(asset => removeAsset(asset.id));
            setSelectedIds(new Set()); await refreshServerAssets(); message.success(`已删除 ${selected.length} 个素材`);
        } else if (action === "move-project") {
            setSelectedIds(new Set()); await refreshServerAssets(); setBatchTarget(null); message.success(`已移动 ${selected.length} 个素材`);
        } else if (action === "download") {
            const files: { name: string; data: Blob }[] = [];
            for (const [index, asset] of selected.entries()) {
                setAssetAction(`正在下载 ${index + 1} / ${selected.length}…`);
                const descriptor = result?.assets.find(item => item.id === asset.id);
                let blob: Blob;
                if (descriptor) blob = await fetchServerAssetContent(asset.id);
                else if (asset.kind === "text") blob = new Blob([asset.data.content], { type: "text/plain" });
                else { const url = await resolveCanvasAssetPreview(asset, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl }); if (!url) throw new Error("本地素材文件不可用"); const response = await fetch(url); if (!response.ok) throw new Error("本地素材读取失败"); blob = await response.blob(); }
                if (useUserStore.getState().user?.id !== requestOwnerId) throw new Error("账号已切换，下载已停止");
                const filename = descriptor?.filename || `${asset.title}.${asset.kind === "text" ? "txt" : blob.type.split("/")[1] || "bin"}`;
                files.push({ name: `${index + 1}-${filename.replace(/[\\/\x00-\x1f]/g, "_")}`, data: blob });
            }
            const zip = await createZip(files);
            if (useUserStore.getState().user?.id !== requestOwnerId) throw new Error("账号已切换，下载已停止");
            saveAs(zip, "选中素材.zip"); message.success(`已打包 ${files.length} 个原始文件`);
        } else {
            const detailed = selected.map(asset => { const full = result?.assets.find(item => item.id === asset.id); return full ? serverAssetToLocal(full) : asset; });
            const target = targetId && targetId !== "new" ? await loadCanvasProject(targetId) : null;
            if (targetId && targetId !== "new" && !target) throw new Error("目标画布不存在或无权访问");
            if (useUserStore.getState().user?.id !== requestOwnerId) throw new Error("账号已切换，已停止加入画布");
            const offsetY = target?.nodes.length ? Math.max(...target.nodes.map(node => node.position.y + node.height)) + 60 : 0;
            const nodes = assetCanvasNodes(detailed, offsetY);
            const store = useCanvasStore.getState();
            const canvasId = target?.id || store.importProject({ title: "素材选集", nodes,
                viewport: assetCanvasViewport(nodes, { width: window.innerWidth, height: window.innerHeight }) });
            if (target) store.updateProject(target.id, { nodes: [...target.nodes, ...nodes] });
            setBatchTarget(null); navigate(`/canvas/${canvasId}`);
        }
    };

    const openCreate = () => {
        setEditingAsset(null);
        setImageDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: "手动添加", note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        const base = {
            title: values.title.trim(),
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (editingAsset && editingServerAsset) {
            await updateServerAssetMetadata(editingAsset.id, { title: base.title, tags: base.tags, source: base.source || "", note: base.note || "" });
            await refreshServerAssets();
        } else if (!editingAsset && values.kind === "text") {
            const file = new File([(values.content || "").trim()], `${values.title.trim() || "text"}.txt`, { type: "text/plain;charset=utf-8" });
            await uploadServerAsset(file, { title: values.title.trim(), tags: values.tags || [], source: values.source || "手动添加", note: values.note || "", content: (values.content || "").trim() });
            await refreshServerAssets();
        } else if (!editingAsset && values.kind === "image" && imageDraft) {
            const blob = await fetch(imageDraft.dataUrl).then((response) => response.blob());
            await uploadServerAsset(new File([blob], values.title.trim() || "image.png", { type: imageDraft.mimeType || blob.type || "image/png" }), { title: values.title.trim(), tags: values.tags || [], source: values.source || "手动上传", note: values.note || "" });
            await refreshServerAssets();
        } else if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageDraft) {
                message.error("请选择图片文件");
                return;
            }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        message.success(editingAsset ? "素材已更新" : "素材已保存");
        setIsAssetOpen(false);
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const dataUrl = await readFileAsDataUrl(file);
        form.setFieldValue("coverUrl", dataUrl);
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        const image = await uploadImage(file);
        const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
        setImageDraft(draft);
        if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
        if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        await runAssetAction("正在读取文本…", async () => { const full = await readAssetDetail(asset); if (full.kind === "text") copyText(full.data.content, "文本已复制"); });
    };

    const downloadImage = async (asset: Asset) => {
        if (asset.kind !== "image" && asset.kind !== "video") return;
        const filename = `${asset.title || "asset"}.${asset.data.mimeType.split("/")[1] || "png"}`;
        if (!serverAssetIds.has(asset.id)) {
            try {
                const source = await resolveCanvasAssetPreview(asset, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl });
                if (!source) {
                    message.error("素材文件不存在或尚未完成同步");
                    return;
                }
                saveAs(source, filename);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "素材读取失败，请重试");
            }
            return;
        }
        try {
            const ownerId = user?.id;
            const receiptKey = `asset.downloaded:${asset.id}:${createClientId()}`;
            const blob = await fetchServerAssetContent(asset.id);
            if (useUserStore.getState().user?.id !== ownerId) throw new Error("账号已切换，下载已停止");
            saveAs(blob, filename);
            try {
                const { projection } = await recordServerAssetDownload(asset.id, filename, receiptKey);
                if (useUserStore.getState().user?.id !== ownerId) return;
                queryClient.setQueriesData<InfiniteData<ServerAssetPage>>({ queryKey: ["asset-library", ownerId] }, data => patchAssetProjection(data, asset.id, projection));
                setPreviewAsset(current => current?.id === asset.id ? { ...current, metadata: { ...current.metadata, ...projection } } : current);
                message.success("下载已开始，下载记录已更新");
            } catch {
                if (useUserStore.getState().user?.id === ownerId) message.warning("下载已开始，但下载记录暂未更新；无需重复下载");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材下载失败");
        }
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning("暂无素材可导出");
            return;
        }
        const ownerId = user?.id;
        const detailed = new Map<string, Asset>();
        const serverIds = validAssets.filter(asset => serverAssetIds.has(asset.id)).map(asset => asset.id);
        for (let start = 0; start < serverIds.length; start += 50) {
            const result = await batchServerAssets("add-to-canvas", serverIds.slice(start, start + 50));
            if (useUserStore.getState().user?.id !== ownerId) throw new Error("账号已切换，导出已停止");
            result.assets.forEach(asset => detailed.set(asset.id, serverAssetToLocal(asset)));
        }
        await exportAssets(validAssets.map(asset => detailed.get(asset.id) || asset));
        const recorded = await Promise.allSettled(
            validAssets.filter((asset) => serverAssetIds.has(asset.id)).map((asset) => recordServerAssetEvent(asset.id, "asset.exported", { channel: "asset-package" })),
        );
        if (recorded.some((result) => result.status === "rejected")) message.warning("素材已导出，部分导出记录同步失败");
        await refreshServerAssets();
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        try {
            const importedAssets = await readAssetPackage(file);
            importedAssets.forEach((asset) => {
                const payload = { ...asset } as Record<string, unknown>;
                delete payload.id;
                delete payload.ownerId;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
            });
            message.success(`已导入 ${importedAssets.length} 个素材`);
        } catch {
            message.error("导入失败，请选择有效的素材压缩包");
        } finally {
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const importImageFiles = async (files: File[] | AssetUploadJob[]) => {
        const imageFiles = files.map(file => file instanceof File ? { file, clientReferenceId: `asset-upload:${createClientId()}` } : file).filter(job => job.file.type.startsWith("image/"));
        if (!imageFiles.length) {
            message.warning("请选择图片文件");
            return;
        }
        const ownerId = user?.id;
        const controller = new AbortController(); uploadAbort.current = controller;
        const result = await uploadAssetBatch(imageFiles, async job => {
            if (controller.signal.aborted || useUserStore.getState().user?.id !== ownerId) throw new Error("账号已切换，上传已停止");
            return uploadServerAsset(job.file, { title: job.file.name, tags: ["手动上传"], source: "manual-upload", module: "素材库", originalFileName: job.file.name },
                { clientReferenceId: job.clientReferenceId, expectedOwnerId: ownerId, signal: controller.signal });
        }, (completed, total) => { if (!controller.signal.aborted) setAssetAction(`已处理 ${completed} / ${total} 张图片…`); });
        if (controller.signal.aborted || useUserStore.getState().user?.id !== ownerId) return;
        setFailedUploads(previous => [...previous.filter(job => !imageFiles.some(attempt => attempt.clientReferenceId === job.clientReferenceId)), ...result.failed]);
        if (result.succeeded) await refreshServerAssets();
        if (result.failed.length) message.warning(`已上传 ${result.succeeded} 张，${result.failed.length} 张失败；可重试失败项`);
        else message.success(`已上传 ${result.succeeded} 张图片`);
    };

    const replicateAsset = async (asset: Asset) => {
        const url = buildRecreateUrl(await readAssetDetail(asset));
        if (!url) {
            message.warning("这个素材没有可复刻的提示词记录");
            return;
        }
        navigate(url);
    };

    const saveAssetPrompt = async (asset: Asset) => {
        try {
            await savePromptFromAsset(asset.id);
            message.success("已保存到我的提示词");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存提示词失败");
        }
    };

    const recordResultAction = async (asset: Asset, eventType: AssetEventType) => {
        try {
            await recordServerAssetEvent(asset.id, eventType, { channel: "asset-library" });
            await refreshServerAssets();
            message.success("成果状态已更新");
        } catch (error) { message.error(error instanceof Error ? error.message : "成果状态更新失败"); }
    };

    const shareWithDepartment = async (asset: Asset, remove = false) => {
        if (!user?.departmentId) { message.warning("账号尚未归属部门"); return; }
        try {
            await (remove ? unshareServerAssetWithDepartment(asset.id, user.departmentId) : shareServerAssetWithDepartment(asset.id, user.departmentId));
            await refreshServerAssets();
            const refreshed = await readAssetDetail(asset);
            setPreviewAsset(current => current?.id === asset.id ? refreshed : current);
            message.success(remove ? "已取消部门共享" : "已共享到部门素材库");
        } catch (error) { message.error(error instanceof Error ? error.message : "共享设置失败"); }
    };

    const setCompanyVisibility = async (asset: Asset, visibility: "private" | "company") => {
        try {
            await setServerAssetVisibility(asset.id, visibility);
            await refreshServerAssets();
            message.success(visibility === "company" ? "已加入公司素材库" : "已撤出公司素材库");
        } catch (error) { message.error(error instanceof Error ? error.message : "共享设置失败"); }
    };

    const addToProject = async () => {
        if (!projectAsset || !selectedProjectId) { message.warning("请先选择项目"); return; }
        try {
            await recordServerAssetEvent(projectAsset.id, "asset.project_added", { channel: "asset-library" }, selectedProjectId);
            await refreshServerAssets();
            setProjectAsset(null);
            setSelectedProjectId(undefined);
            message.success("已加入正式项目");
        } catch (error) { message.error(error instanceof Error ? error.message : "加入项目失败"); }
    };

    const confirmDelete = async () => {
        if (!deletingAsset) return;
        if (serverAssetIds.has(deletingAsset.id)) { await deleteServerAsset(deletingAsset.id); await refreshServerAssets(); }
        else removeAsset(deletingAsset.id);
        message.success("素材已删除");
        setDeletingAsset(null);
    };

    return (
        <div className="wb-page flex h-full flex-col overflow-hidden" tabIndex={0} aria-label="素材库" onKeyDown={event => {
            const target = event.target as HTMLElement;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !target.closest('input:not([type="checkbox"]),textarea,[contenteditable="true"],[role="dialog"]') && !isAssetOpen && !previewAsset && !batchTarget) {
                event.preventDefault(); setSelectedIds(new Set(visibleAssets.slice(0, 50).map(asset => asset.id)));
                if (visibleAssets.length > 50) message.info("当前页超过 50 个素材，已选择前 50 个");
            }
        }}>
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
                <div className="mx-auto max-w-7xl pb-6">
                    <header className="wb-header">
                        <div>
                            <p className="wb-eyebrow">素材工作台</p>
                            <h1 className="wb-title">{libraryView === "trash" ? "最近删除" : "我的素材"}</h1>
                            <p className="wb-description">{libraryView === "trash" ? "仅展示你有权管理、删除未满 30 天的公司素材。原始文件仍保留时可恢复，归属、项目与共享设置保持不变。" : "把文本、图片和视频整理在一起。收藏、下载，或带着原提示词继续创作。"}</p>
                        </div>
                        <div className="wb-toolbar">
                            <Segmented aria-label="素材库视图" value={libraryView} onChange={value => setLibraryView(value as "active" | "trash")} options={[{ label: "我的素材", value: "active" }, { label: "最近删除", value: "trash" }]} />
                            {libraryView === "active" ? <>
                            <Button size="large" icon={<Plus className="size-4" />} onClick={openCreate}>新增素材</Button>
                            <Button size="large" type="primary" icon={<Upload className="size-4" />} disabled={Boolean(assetAction)} onClick={() => batchImageInputRef.current?.click()}>上传图片</Button>
                            </> : null}
                        </div>
                    </header>

                    <div className="w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder="搜索标题、内容、标签或来源"
                            onChange={(event) => {
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mt-5 grid gap-3 text-left">
                        <div className="flex flex-wrap items-center gap-2" aria-label="素材筛选">
                            <Input aria-label="按标签筛选" placeholder="标签（精确匹配）" allowClear value={tagFilter} onChange={event => setTagFilter(event.target.value)} style={{ width: 180 }} />
                            <Select aria-label="按项目筛选" placeholder="全部项目" allowClear showSearch optionFilterProp="label" value={projectFilter} onChange={setProjectFilter} options={serverProjects.map(project => ({ value: project.id, label: project.name }))} style={{ minWidth: 180 }} />
                            <DatePicker.RangePicker aria-label="按创建日期筛选" placeholder={["创建开始日期", "创建结束日期"]} value={dateRange ? [dayjs(dateRange[0]), dayjs(dateRange[1]).subtract(1, 'day')] : null} onChange={range => setDateRange(range?.[0] && range?.[1] ? [range[0].startOf('day').toISOString(), range[1].add(1, 'day').startOf('day').toISOString()] : null)} />
                            <Select aria-label="素材排序" value={sort} onChange={setSort} options={[{ value: "newest", label: libraryView === "trash" ? "最近删除优先" : "最新创建优先" }, { value: "oldest", label: libraryView === "trash" ? "最早删除优先" : "最早创建优先" }]} style={{ width: 154 }} />
                            {hasFilters ? <Button onClick={clearFilters}>清除筛选</Button> : null}
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">类型</div>
                                <div className="flex flex-wrap gap-2">
                                    {kindOptions.map((option) => (
                                        <Tag.CheckableTag
                                            key={option.value}
                                            checked={kindFilter === option.value}
                                            className={cn("prompt-filter-tag", kindFilter === option.value && "is-active")}
                                            onChange={() => {
                                                setKindFilter(option.value as AssetKind | "all");
                                            }}
                                        >
                                            {option.label}
                                        </Tag.CheckableTag>
                                    ))}
                                </div>
                            </div>
                            <div className="wb-toolbar">
                                <span className="text-sm text-muted-foreground">已加载 {libraryView === "trash" ? serverAssets.length : filteredAssets.length} 个素材{serverAssetResponse?.hasMore ? " · 还有更多" : ""}</span>
                                {libraryView === "active" ? <>
                                {referenceImportEnabled ? <Button onClick={() => navigate("/reference-import")}>网页采集</Button> : null}
                                <Button icon={<Download className="size-4" />} disabled={Boolean(assetAction) || !validAssets.length} onClick={() => void runAssetAction("正在整理导出文件…", exportAllAssets)}>导出已加载素材</Button>
                                <Button icon={<Upload className="size-4" />} disabled={Boolean(assetAction)} onClick={() => assetInputRef.current?.click()}>导入素材包</Button>
                                </> : null}
                            </div>
                        </div>
                    </div>
                    {assetAction || serverLoading ? <div role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{assetAction || "正在同步素材列表…"}</div> : null}
                    {failedUploads.length ? <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{failedUploads.length} 张图片上传失败</strong><Space><Button disabled={Boolean(assetAction)} onClick={() => void runAssetAction("正在重试失败图片…", () => importImageFiles(failedUploads))}>重试失败项</Button><Button disabled={Boolean(assetAction)} onClick={() => setFailedUploads([])}>清除失败记录</Button></Space></div>
                        <ul className="mt-2 max-h-36 overflow-y-auto">{failedUploads.map(job => <li key={job.clientReferenceId}>{job.file.name}：{job.error}</li>)}</ul>
                    </div> : null}
                    {serverError ? <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><span>{serverError}；已保留当前本地素材。</span><Button onClick={() => void refreshServerAssets()}>重试加载</Button></div> : null}
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {libraryView === "trash" ? serverAssets.map(asset => <Card key={asset.id} className="h-full" title={typeof asset.metadata.title === "string" ? asset.metadata.title : asset.filename}>
                            <div className="flex flex-col gap-3"><div className="flex items-center gap-2 text-muted-foreground"><Trash2 className="size-5" /><span>{asset.kind} · {formatBytes(asset.byteSize)}</span></div>
                                <p className="text-sm">删除于 {asset.deletedAt ? new Date(asset.deletedAt).toLocaleString() : "—"}<br />可恢复至 {asset.purgeAfter ? new Date(asset.purgeAfter).toLocaleDateString() : "—"}</p>
                                <p className="truncate text-xs text-muted-foreground">{asset.ownerName}{asset.projectName ? ` · ${asset.projectName}` : ""}</p>
                                <Button icon={<RotateCcw className="size-4" />} disabled={Boolean(assetAction)} onClick={() => void runAssetAction("正在恢复素材…", async () => {
                                    const ownerId = user?.id; await restoreServerAsset(asset.id);
                                    if (useUserStore.getState().user?.id !== ownerId) return;
                                    await queryClient.invalidateQueries({ queryKey: ["asset-library", ownerId] }); message.success("素材已恢复到我的素材");
                                })}>恢复素材</Button>
                            </div>
                        </Card>) : null}
                        {visibleAssets.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                selected={selectedIds.has(asset.id)}
                                onSelect={shift => toggleSelection(asset.id, shift)}
                                onOpen={() => openDetail(asset)}
                                onEdit={() => void runAssetAction("正在读取素材详情…", async () => openEdit(await readAssetDetail(asset)))}
                                onCopy={copyAssetText}
                                onDownload={downloadImage}
                                onReplicate={() => void runAssetAction("正在读取复刻参数…", () => replicateAsset(asset))}
                                onDelete={() => setDeletingAsset(asset)}
                            />
                        ))}
                    </div>

                    {!(libraryView === "trash" ? serverAssets.length : visibleAssets.length) && !serverLoading ? <div className="wb-surface wb-empty"><Upload className="size-8" /><strong>{hasFilters ? "没有找到匹配素材" : libraryView === "trash" ? "暂无可恢复素材" : "先收好你的第一份素材"}</strong><p>{hasFilters ? "试试更短的关键词，或清除筛选查看全部内容。" : libraryView === "trash" ? "删除未满 30 天且你有权管理的公司素材会显示在这里。本地素材不进入最近删除。" : "上传常用参考图，或新增文本素材。生成的作品也会出现在这里。"}</p>{hasFilters ? <Button onClick={clearFilters}>清除筛选</Button> : libraryView === "active" ? <Button type="primary" disabled={Boolean(assetAction)} onClick={() => batchImageInputRef.current?.click()}>上传图片</Button> : null}</div> : null}
                    <InfiniteLoadMore hasMore={Boolean(assetPages.hasNextPage)} loading={serverLoading} error={assetPages.error}
                        disabled={Boolean(assetAction)} resetKey={JSON.stringify(assetQueryKey)}
                        pageKey={serverAssetResponse?.nextCursor} label="加载更多素材" endLabel="已显示全部已加载素材"
                        onLoadMore={() => assetPages.fetchNextPage({ cancelRefetch: false })} />
                </div>
            </main>
            {selectedIds.size ? <div role="toolbar" aria-label="素材批量操作" className="flex flex-wrap items-center justify-center gap-2 border-t bg-background px-4 py-3">
                <span className="mr-2 text-sm">已选 {selectedIds.size} / 50</span>
                <Button disabled={Boolean(assetAction)} onClick={() => setSelectedIds(new Set())}>取消选择</Button>
                <Button disabled={Boolean(assetAction)} icon={<Download className="size-4" />} onClick={() => void runAssetAction("正在准备批量下载…", () => executeBatch("download"))}>批量下载</Button>
                <Button disabled={Boolean(assetAction)} onClick={() => { setBatchTarget("canvas"); setTargetId("new"); }}>加入画布</Button>
                <Button disabled={Boolean(assetAction) || selectedAssets.some(asset => !serverAssetIds.has(asset.id))} onClick={() => { setBatchTarget("project"); setTargetId(undefined); }}>移动到项目</Button>
                <Button danger disabled={Boolean(assetAction)} icon={<Trash2 className="size-4" />} onClick={() => modal.confirm({ title: `删除选中的 ${selectedIds.size} 个素材？`, content: "公司素材将移入最近删除，30 天内原始文件仍保留时可恢复；本地素材会从素材库永久移除。任一公司素材无权限时整批不执行。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => runAssetAction("正在批量删除…", () => executeBatch("delete")) })}>批量删除</Button>
            </div> : null}
            <Modal title={batchTarget === "canvas" ? "批量加入画布" : "批量移动到项目"} open={Boolean(batchTarget)} confirmLoading={Boolean(assetAction)} okButtonProps={{ disabled: !targetId }} onCancel={() => { if (!assetAction) setBatchTarget(null); }} onOk={() => void runAssetAction("正在批量处理…", () => executeBatch(batchTarget === "canvas" ? "add-to-canvas" : "move-project"))} okText="确认" cancelText="取消">
                <Select className="w-full" aria-label="批量操作目标" value={targetId} onChange={setTargetId} options={batchTarget === "canvas" ? [{ value: "new", label: "创建新画布" }, ...[...canvasProjects, ...unloadedCanvasProjects].map(project => ({ value: project.id, label: project.title }))] : serverProjects.map(project => ({ value: project.id, label: project.name }))} placeholder="请选择目标项目" />
            </Modal>

            <Modal title={editingAsset ? "编辑素材" : "新增素材"} open={isAssetOpen} width={980} onCancel={() => { if (!savingAsset) setIsAssetOpen(false); }} onOk={() => void runSave(saveAsset)} confirmLoading={savingAsset} cancelButtonProps={{ disabled: savingAsset }} closable={!savingAsset} keyboard={!savingAsset} maskClosable={!savingAsset} okText="保存" cancelText="取消" destroyOnHidden>
                {editingServerAsset ? <p className="mb-4 text-sm text-muted-foreground">修改标题、标签、来源说明和备注将保存到服务端；原始文件和生成记录保持不变。</p> : null}
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} disabled={savingAsset} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label="类型">
                            <Select
                                disabled={editingServerAsset || savingAsset}
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, max: 255, message: "请输入标题（最多255字）" }]}>
                            <Input size="large" maxLength={255} placeholder="给素材起一个容易检索的名字" />
                        </Form.Item>
                        <Form.Item name="coverUrl" label="封面 URL">
                            <Space.Compact className="w-full">
                                <Input disabled={editingServerAsset || savingAsset} placeholder="可粘贴图片 URL，也可以上传本地封面" />
                                <Button disabled={editingServerAsset || savingAsset} icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    上传
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label="标签">
                            <Select mode="tags" maxCount={20} tokenSeparators={[",", "，"]} placeholder="输入标签后回车" />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label="来源">
                                <Input maxLength={120} placeholder="手动添加 / 画布 / 提示词库" />
                            </Form.Item>
                            <Form.Item name="note" label="备注">
                                <Input maxLength={2000} placeholder="可选" />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label="文本内容" rules={[{ required: !editingServerAsset, whitespace: true, message: "请输入文本内容" }]}>
                                <Input.TextArea disabled={editingServerAsset || savingAsset} rows={8} placeholder="保存提示词、说明文案、参考描述等文本素材" />
                            </Form.Item>
                        ) : (
                            <Form.Item label="图片内容" required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button disabled={editingServerAsset || savingAsset} icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        选择图片文件
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            未选择图片
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>预览</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <img src={coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || "暂无封面"}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || "未命名素材"}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">未打标签</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer
                asset={previewAsset}
                currentUserId={user?.id || ""}
                currentUserRole={user?.role || "designer"}
                isServerAsset={Boolean(previewAsset && serverAssetIds.has(previewAsset.id))}
                onClose={() => setPreviewAsset(null)}
                onCopy={copyAssetText}
                onDownload={downloadImage}
                onEditOriginal={openImageEditor}
                onReplicate={replicateAsset}
                onSavePrompt={(asset) => runSavePrompt(() => saveAssetPrompt(asset))}
                onResultAction={recordResultAction}
                onAddProject={(asset) => { setProjectAsset(asset); setSelectedProjectId(metadataString(asset, "projectId") || undefined); }}
                onShareDepartment={shareWithDepartment}
                onSetCompanyVisibility={setCompanyVisibility}
                onShareDesign={libraryShare.canShare ? async asset => {
                    if (asset.kind !== "image") return;
                    await libraryShare.share({ ownerId: asset.ownerId, assetId: serverAssetIdFromAsset(asset), title: asset.title,
                        prompt: metadataString(asset, "prompt"), thought: asset.note || "", tags: asset.tags, model: metadataString(asset, "model"),
                        dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey });
                } : undefined}
                sharingDesign={libraryShare.busy}
            />
            {imageEditor.node ? <Suspense fallback={<Modal title="编辑原图" open footer={null} onCancel={imageEditor.close}><p role="status">正在读取图片编辑器…</p></Modal>}>
                <CanvasImageEditorDialog node={imageEditor.node} onClose={imageEditor.close} onConfirm={imageEditor.confirm}
                    saveHint="另存到我的素材 · 原始素材保持不变 · 不调用 AI"
                    successMessage="新版本已保存到我的素材，原始素材保持不变"
                    cancelDescription="原始素材不会改变，未保存的修改将丢弃。" />
            </Suspense> : null}

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" disabled={Boolean(assetAction)} onChange={(event) => { const file = event.target.files?.[0]; void runAssetAction("正在导入素材包…", () => importAssetZip(file)); }} />
            <input ref={batchImageInputRef} type="file" accept="image/*" multiple className="hidden" disabled={Boolean(assetAction)} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; void runAssetAction("正在准备上传…", () => importImageFiles(files)); }} />

            <Modal title="删除素材" open={Boolean(deletingAsset)} onCancel={() => { if (!deleting) setDeletingAsset(null); }} onOk={() => void runDelete(confirmDelete)} confirmLoading={deleting} cancelButtonProps={{ disabled: deleting }} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除「{deletingAsset?.title}」吗？删除后会从我的素材中移除。
                {deletingAsset && serverAssetIds.has(deletingAsset.id) ? "公司素材可在最近删除中恢复，期限为 30 天且原始文件须仍保留。" : "本地素材不会进入最近删除，删除后无法从此处恢复。"}
            </Modal>
            <Modal title="加入正式项目" open={Boolean(projectAsset)} onCancel={() => setProjectAsset(null)} onOk={() => void addToProject()} okText="确认加入" cancelText="取消">
                <Select
                    className="w-full"
                    value={selectedProjectId}
                    placeholder={serverProjects.length ? "选择项目" : "暂无可加入项目，请先创建项目"}
                    options={serverProjects.map((project) => ({ label: project.name, value: project.id }))}
                    onChange={setSelectedProjectId}
                />
            </Modal>
        </div>
    );
}

function useResolvedAssetMedia(asset: Asset | null) {
    const fallback = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? asset.data.url : "") : "";
    const [source, setSource] = useState(() => (asset && (asset.kind === "image" || asset.kind === "video") && needsCanvasAssetPreviewResolution(asset) ? "" : fallback));

    useEffect(() => {
        let active = true;
        if (!asset || (asset.kind !== "image" && asset.kind !== "video")) {
            setSource("");
            return;
        }
        if (!needsCanvasAssetPreviewResolution(asset)) {
            setSource(fallback);
            return;
        }
        setSource("");
        void resolveCanvasAssetPreview(asset, { resolveImage: resolveImageUrl, resolveMedia: resolveMediaUrl })
            .then((url) => {
                if (active) setSource(url);
            })
            .catch(() => {
                if (active) setSource("");
            });
        return () => { active = false; };
    }, [asset, fallback]);

    return source;
}

function AssetPlaceholder({ asset }: { asset: Asset }) {
    return <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted p-6 text-center text-sm leading-7 text-muted-foreground"><p className="line-clamp-6 break-words">{asset.kind === "text" ? asset.data.content.slice(0, 600) : "暂无封面"}</p></div>;
}

function AssetCover({ asset }: { asset: Asset }) {
    const source = useResolvedAssetMedia(asset);
    if (!source) return <AssetPlaceholder asset={asset} />;
    if (asset.kind === "video") return <video src={source} muted playsInline preload="metadata" className="aspect-[4/3] w-full object-cover" />;
    return <img src={source} alt={asset.title} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />;
}

function AssetDetailPreview({ asset }: { asset: Asset }) {
    const source = useResolvedAssetMedia(asset);
    if (!source) return <AssetPlaceholder asset={asset} />;
    if (asset.kind === "video") return <AssetPlaceholder asset={asset} />;
    return <Image src={metadataString(asset, "previewUrl") || source} preview={{ src: asset.kind === "image" ? asset.data.dataUrl : source }} alt={asset.title} className="rounded-lg" />;
}

function ResolvedAssetVideo({ asset, className, controls = false }: { asset: Extract<Asset, { kind: "video" }>; className?: string; controls?: boolean }) {
    const source = useResolvedAssetMedia(asset);
    return source ? <video src={source} controls={controls} preload="metadata" className={className} /> : null;
}

function AssetCard({
    asset,
    selected,
    onSelect,
    onOpen,
    onEdit,
    onCopy,
    onDownload,
    onReplicate,
    onDelete,
}: {
    asset: Asset;
    selected: boolean;
    onSelect: (shift: boolean) => void;
    onOpen: () => void;
    onEdit: () => void;
    onCopy: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onReplicate: () => void;
    onDelete: () => void;
}) {
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className={cn("wb-surface relative overflow-hidden", selected && "ring-2 ring-primary")}
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="block w-full text-left" onClick={onOpen}>
                    {asset.kind === "image" || asset.kind === "video" ? (
                        <AssetCover asset={asset} />
                    ) : (
                        <AssetPlaceholder asset={asset} />
                    )}
                </button>
            }
        >
            <label className="absolute left-3 top-3 z-10 flex size-7 items-center justify-center rounded bg-background/90" onClick={event => event.stopPropagation()}>
                <input type="checkbox" aria-label={`选择${asset.title}`} checked={selected} onChange={() => undefined} onClick={event => onSelect(event.shiftKey)} className="size-4 cursor-pointer accent-primary" />
            </label>
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-base font-semibold text-foreground">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || "未标注来源"}
                            </Typography.Text>
                        </div>
                        <Tag className="m-0 shrink-0 text-[11px]">{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-3 !text-sm !leading-6">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        <Tag color="orange" className="m-0 text-[11px]">{resultStatusLabel(metadataString(asset, "resultStatus"))}</Tag>
                        <Tag className="m-0 text-[11px]">可用性 {metadataNumber(asset, "usabilityScore")}/100</Tag>
                        <Tag className="m-0 text-[11px]">下载 {metadataNumber(asset, "downloadCount")}</Tag>
                        {(asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {!asset.tags?.length ? <Tag className="m-0 text-[11px]">无标签</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                <Button className="shrink-0" size="small" onClick={onOpen}>
                    查看
                </Button>
                {asset.kind !== "video" ? (
                    <Button className="shrink-0" size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                        编辑
                    </Button>
                ) : null}
                {asset.kind === "text" ? (
                    <Button className="shrink-0" size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                        复制
                    </Button>
                ) : null}
                {asset.kind === "image" || asset.kind === "video" ? (
                    <Button className="shrink-0" size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                        下载
                    </Button>
                ) : null}
                {canReplicate(asset) ? (
                    <Button className="shrink-0" size="small" icon={<RotateCcw className="size-3.5" />} onClick={onReplicate}>
                        复刻
                    </Button>
                ) : null}
                <Button className="shrink-0" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    删除
                </Button>
            </div>
        </Card>
    );
}

function AssetDrawer({
    asset,
    currentUserId,
    currentUserRole,
    isServerAsset,
    onClose,
    onCopy,
    onDownload,
    onEditOriginal,
    onReplicate,
    onSavePrompt,
    onResultAction,
    onAddProject,
    onShareDepartment,
    onSetCompanyVisibility,
    onShareDesign,
    sharingDesign,
}: {
    asset: Asset | null;
    currentUserId: string;
    currentUserRole: string;
    isServerAsset: boolean;
    onClose: () => void;
    onCopy: (asset: Asset) => void;
    onDownload: (asset: Asset) => void | Promise<void>;
    onEditOriginal: (asset: Asset) => void;
    onReplicate: (asset: Asset) => void | Promise<void>;
    onSavePrompt: (asset: Asset) => void | Promise<void>;
    onResultAction: (asset: Asset, eventType: AssetEventType) => void | Promise<void>;
    onAddProject: (asset: Asset) => void;
    onShareDepartment: (asset: Asset, remove?: boolean) => void | Promise<void>;
    onSetCompanyVisibility: (asset: Asset, visibility: "private" | "company") => void | Promise<void>;
    onShareDesign?: (asset: Asset) => void | Promise<void>;
    sharingDesign?: boolean;
}) {
    const isOwner = asset?.ownerId === currentUserId;
    const isAdmin = currentUserRole === "super_admin" || currentUserRole === "department_admin";
    const visibility = asset ? metadataString(asset, "visibilityScope") : "private";
    return (
        <Drawer title="素材详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {asset.kind === "image" ? (
                        <AssetDetailPreview asset={asset} />
                    ) : asset.kind === "video" ? null : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
                            {isServerAsset ? <Tag color="orange">{resultStatusLabel(metadataString(asset, "resultStatus"))}</Tag> : null}
                            {isServerAsset ? <Tag>可用性 {metadataNumber(asset, "usabilityScore")}/100</Tag> : null}
                            {isServerAsset ? <Tag>下载 {metadataNumber(asset, "downloadCount")} 次</Tag> : null}
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            内容
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <ResolvedAssetVideo asset={asset} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    <AssetTrace asset={asset} />
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">备注</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space wrap>
                        {asset.kind === "image" ? (
                            <Button icon={<PencilLine className="size-4" />} onClick={() => onEditOriginal(asset)}>编辑原图</Button>
                        ) : null}
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                复制文本
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? "下载视频" : "下载图片"}
                            </Button>
                        ) : null}
                        {canReplicate(asset) ? (
                            <Button icon={<RotateCcw className="size-4" />} onClick={() => onReplicate(asset)}>
                                一键复刻
                            </Button>
                        ) : null}
                        {isServerAsset && canReplicate(asset) ? (
                            <Button icon={<BookmarkPlus className="size-4" />} onClick={() => onSavePrompt(asset)}>
                                保存到我的提示词
                            </Button>
                        ) : null}
                        {isOwner && asset.kind === "image" && onShareDesign ? <Button icon={<Share2 className="size-4" />} loading={sharingDesign} onClick={() => void onShareDesign(asset)}>分享到灵感库</Button> : null}
                    </Space>
                    {isServerAsset ? (
                        <div className="rounded-lg border border-orange-200 bg-orange-50/60 p-4 dark:border-orange-900 dark:bg-orange-950/20">
                            <Typography.Text strong>成果操作</Typography.Text>
                            <div className="mt-3 flex flex-wrap gap-2">
                                {isOwner ? (
                                    <Button icon={<Check className="size-4" />} onClick={() => void onResultAction(asset, "asset.candidate_added")}>加入候选</Button>
                                ) : null}
                                {isOwner ? <Button onClick={() => onAddProject(asset)}>加入正式项目</Button> : null}
                                {isOwner ? (
                                    <Button icon={<Share2 className="size-4" />} onClick={() => void onShareDepartment(asset)}>共享到部门</Button>
                                ) : null}
                                {isOwner ? <Button onClick={() => void onShareDepartment(asset, true)}>取消部门共享</Button> : null}
                                {isAdmin ? <Button onClick={() => void onResultAction(asset, "asset.pending")}>待定</Button> : null}
                                {isAdmin ? <Button type="primary" onClick={() => void onResultAction(asset, "asset.adopted")}>确认采用</Button> : null}
                                {isAdmin ? <Button onClick={() => void onResultAction(asset, "asset.delivered")}>最终交付</Button> : null}
                                {isAdmin ? <Button danger onClick={() => void onResultAction(asset, "asset.rejected")}>标记废弃</Button> : null}
                                {isAdmin ? (
                                    <Button icon={<Share2 className="size-4" />} onClick={() => void onSetCompanyVisibility(asset, visibility === "company" ? "private" : "company")}>
                                        {visibility === "company" ? "撤出公司素材库" : "加入公司素材库"}
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </Drawer>
    );
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content.length > 280 ? `${asset.data.content.slice(0, 280)}…` : asset.data.content;
    const dimensions = asset.data.width > 0 && asset.data.height > 0 ? `${asset.data.width} × ${asset.data.height}` : "尺寸未记录";
    return `${dimensions} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function AssetTrace({ asset }: { asset: Asset }) {
    const module = metadataString(asset, "module") || asset.source || "未记录";
    const prompt = metadataString(asset, "prompt") || (asset.kind === "text" ? asset.data.content : "");
    const model = metadataString(asset, "model");
    const sourceFile = metadataString(asset, "sourceFile");
    return (
        <div className="rounded-lg border border-stone-200 p-4 text-sm dark:border-stone-800">
            <Typography.Text type="secondary" className="block text-xs">
                生成记录
            </Typography.Text>
            <div className="mt-2 grid gap-2">
                <TraceLine label="来源板块" value={module} />
                {model ? <TraceLine label="模型" value={imageModelDisplayName(model)} /> : null}
                {sourceFile ? <TraceLine label="原始文件" value={sourceFile} /> : null}
                {prompt ? <TraceLine label="提示词" value={prompt} multiline /> : null}
            </div>
        </div>
    );
}

function TraceLine({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
    return (
        <div className={multiline ? "grid gap-1" : "grid grid-cols-[72px_minmax(0,1fr)] gap-2"}>
            <span className="text-xs text-stone-400">{label}</span>
            <span className={multiline ? "whitespace-pre-wrap rounded-md bg-stone-50 p-2 text-stone-700 dark:bg-stone-900 dark:text-stone-200" : "truncate text-stone-700 dark:text-stone-200"}>{value}</span>
        </div>
    );
}

function metadataString(asset: Asset, key: string) {
    const value = asset.metadata?.[key];
    return typeof value === "string" ? value : "";
}

function metadataNumber(asset: Asset, key: string) {
    const value = asset.metadata?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function resultStatusLabel(status: string) {
    return ({
        unused: "未使用",
        candidate: "候选",
        project: "已入项目",
        editing: "继续编辑",
        downloaded: "已下载/导出",
        adopted: "已采用",
        delivered: "已交付",
        pending: "待定",
        rejected: "已废弃",
    } as Record<string, string>)[status] || "未使用";
}

function canReplicate(asset: Asset) {
    return Boolean(asset.metadata?.canRecreate || metadataString(asset, "recreatePath") || (metadataString(asset, "prompt") || (asset.kind === "text" ? asset.data.content : "")).trim());
}

function buildRecreateUrl(asset: Asset) {
    const explicitPath = metadataString(asset, "recreatePath");
    if (explicitPath) return appendRecreateSource(explicitPath, asset);
    const prompt = metadataString(asset, "prompt") || (asset.kind === "text" ? asset.data.content : "");
    if (!prompt.trim()) return "";
    const model = metadataString(asset, "model");
    const source = metadataString(asset, "source");
    const toolMode = metadataString(asset, "toolMode") || "image-generation";
    const params = new URLSearchParams();
    params.set("prompt", prompt);
    if (model) params.set("model", model);
    const serverAssetId = metadataString(asset, "serverAssetId");
    if (serverAssetId) {
        params.set("sourceAssetId", serverAssetId);
        params.set("sourceOwnerId", asset.ownerId);
    }
    if (source === "video-page") return `/video?${params.toString()}`;
    params.set("tool", toolMode);
    return `/image?${params.toString()}`;
}

function appendRecreateSource(path: string, asset: Asset) {
    const serverAssetId = metadataString(asset, "serverAssetId");
    if (!serverAssetId) return path;
    const url = new URL(path, window.location.origin);
    url.searchParams.set("sourceAssetId", serverAssetId);
    url.searchParams.set("sourceOwnerId", asset.ownerId);
    return `${url.pathname}${url.search}`;
}
