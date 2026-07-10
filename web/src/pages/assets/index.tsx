import { Copy, Download, PencilLine, RotateCcw, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Card, Drawer, Empty, Form, Image, Input, Modal, Pagination, Select, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useNavigate } from "react-router-dom";

import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { uploadImage } from "@/services/image-storage";
import { cn } from "@/lib/utils";
import { canUserAccessAsset, useAssetStore, type Asset, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import { deleteServerAsset, listServerAssets, uploadServerAsset, type ServerAsset } from "@/services/api/server-assets";

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
    const { message } = App.useApp();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const batchImageInputRef = useRef<HTMLInputElement>(null);
    const localAssets = useAssetStore((state) => state.assets);
    const [serverAssets, setServerAssets] = useState<ServerAsset[]>([]);
    const [serverAssetIds, setServerAssetIds] = useState<Set<string>>(new Set());
    const user = useUserStore((state) => state.user);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const refreshServerAssets = async () => {
        try { const result = await listServerAssets(); setServerAssets(result.assets); setServerAssetIds(new Set(result.assets.map((asset) => asset.id))); }
        catch (error) { message.error(error instanceof Error ? error.message : "公司素材加载失败"); }
    };
    useEffect(() => { void refreshServerAssets(); }, []);
    const assets = useMemo(() => [...serverAssets.map(serverAssetToLocal), ...localAssets.filter((asset) => !serverAssetIds.has(asset.id))], [localAssets, serverAssetIds, serverAssets]);
    const validAssets = useMemo(() => assets.filter((asset) => canUserAccessAsset(asset, user) && (asset.kind === "text" || asset.kind === "image" || asset.kind === "video")), [assets, user]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [filteredAssets.length, pageSize]);

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

        if (!editingAsset && values.kind === "text") {
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
        copyText(asset.data.content, "文本已复制");
    };

    const downloadImage = (asset: Asset) => {
        if (asset.kind !== "image" && asset.kind !== "video") return;
        saveAs(asset.kind === "video" ? asset.data.url : asset.data.dataUrl, `${asset.title || "asset"}.${asset.data.mimeType.split("/")[1] || "png"}`);
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning("暂无素材可导出");
            return;
        }
        await exportAssets(validAssets);
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

    const importImageFiles = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) {
            message.warning("请选择图片文件");
            return;
        }
        for (const file of imageFiles) await uploadServerAsset(file, { title: file.name, tags: ["手动上传"], source: "manual-upload", module: "素材库", originalFileName: file.name });
        await refreshServerAssets();
        message.success(`已上传 ${imageFiles.length} 张图片`);
        if (batchImageInputRef.current) batchImageInputRef.current.value = "";
    };

    const replicateAsset = (asset: Asset) => {
        const url = buildRecreateUrl(asset);
        if (!url) {
            message.warning("这个素材没有可复刻的提示词记录");
            return;
        }
        navigate(url);
    };

    const confirmDelete = async () => {
        if (!deletingAsset) return;
        if (serverAssetIds.has(deletingAsset.id)) { await deleteServerAsset(deletingAsset.id); await refreshServerAssets(); }
        else removeAsset(deletingAsset.id);
        message.success("素材已删除");
        setDeletingAsset(null);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">我的素材</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">收藏常用文本和图片，按类型、标题和标签快速查找。</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder="搜索标题、内容、标签或来源"
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setPage(1);
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
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
                                                setPage(1);
                                                setKindFilter(option.value as AssetKind | "all");
                                            }}
                                        >
                                            {option.label}
                                        </Tag.CheckableTag>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                >
                                    导出素材
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => assetInputRef.current?.click()}
                                >
                                    导入素材
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => batchImageInputRef.current?.click()}
                                >
                                    批量上传图片
                                </button>
                                <button type="button" className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300" onClick={openCreate}>
                                    新增素材
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                onOpen={() => setPreviewAsset(asset)}
                                onEdit={() => openEdit(asset)}
                                onCopy={copyAssetText}
                                onDownload={downloadImage}
                                onReplicate={() => replicateAsset(asset)}
                                onDelete={() => setDeletingAsset(asset)}
                            />
                        ))}
                    </div>

                    {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到素材" className="py-20" /> : null}

                    <div className="flex justify-center">
                        <Pagination
                            current={page}
                            pageSize={pageSize}
                            total={filteredAssets.length}
                            showSizeChanger
                            pageSizeOptions={[10, 20, 50, 100]}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </div>
            </main>

            <Modal title={editingAsset ? "编辑素材" : "新增素材"} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset()} okText="保存" cancelText="取消" destroyOnHidden>
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label="类型">
                            <Select
                                options={[
                                    { label: "文本", value: "text" },
                                    { label: "图片", value: "image" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input size="large" placeholder="给素材起一个容易检索的名字" />
                        </Form.Item>
                        <Form.Item name="coverUrl" label="封面 URL">
                            <Space.Compact className="w-full">
                                <Input placeholder="可粘贴图片 URL，也可以上传本地封面" />
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    上传
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label="标签">
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后回车" />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label="来源">
                                <Input placeholder="手动添加 / 画布 / 提示词库" />
                            </Form.Item>
                            <Form.Item name="note" label="备注">
                                <Input placeholder="可选" />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label="文本内容" rules={[{ required: true, message: "请输入文本内容" }]}>
                                <Input.TextArea rows={8} placeholder="保存提示词、说明文案、参考描述等文本素材" />
                            </Form.Item>
                        ) : (
                            <Form.Item label="图片内容" required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
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

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} onReplicate={replicateAsset} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />
            <input ref={batchImageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void importImageFiles(event.target.files)} />

            <Modal title="删除素材" open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={confirmDelete} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除「{deletingAsset?.title}」吗？删除后会从我的素材中移除。
            </Modal>
        </div>
    );
}

function serverAssetToLocal(asset: ServerAsset): Asset {
    const title = typeof asset.metadata.title === "string" ? asset.metadata.title : asset.filename;
    const common = { id: asset.id, ownerId: asset.ownerUserId, title, coverUrl: `/api/assets/${asset.id}/content`, tags: Array.isArray(asset.metadata.tags) ? asset.metadata.tags.map(String) : [], source: asset.source, note: typeof asset.metadata.note === "string" ? asset.metadata.note : undefined, metadata: { ...asset.metadata, designerId: asset.ownerUserId, departmentId: asset.departmentId, projectId: asset.projectId, operationType: asset.operationType, prompt: asset.prompt, modelName: asset.modelName }, createdAt: asset.createdAt, updatedAt: asset.createdAt };
    if (asset.kind === "text") return { ...common, kind: "text", data: { content: typeof asset.metadata.content === "string" ? asset.metadata.content : "" } };
    if (asset.kind === "video") return { ...common, kind: "video", data: { url: common.coverUrl, storageKey: asset.id, width: 0, height: 0, bytes: asset.byteSize, mimeType: asset.mimeType } };
    return { ...common, kind: "image", data: { dataUrl: common.coverUrl, storageKey: asset.id, width: 0, height: 0, bytes: asset.byteSize, mimeType: asset.mimeType } };
}

function AssetCard({
    asset,
    onOpen,
    onEdit,
    onCopy,
    onDownload,
    onReplicate,
    onDelete,
}: {
    asset: Asset;
    onOpen: () => void;
    onEdit: () => void;
    onCopy: (asset: Asset) => void;
    onDownload: (asset: Asset) => void;
    onReplicate: () => void;
    onDelete: () => void;
}) {
    const cover = asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "");
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className="overflow-hidden"
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="block w-full text-left" onClick={onOpen}>
                    {cover ? (
                        <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                        <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                </button>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || "未标注来源"}
                            </Typography.Text>
                        </div>
                        <Tag className="m-0 shrink-0 text-[11px]">{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
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

function AssetDrawer({ asset, onClose, onCopy, onDownload, onReplicate }: { asset: Asset | null; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onReplicate: (asset: Asset) => void }) {
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    return (
        <Drawer title="素材详情" open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={cover} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : "暂无封面"}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文本"}</Tag>
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
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-black" />
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
                    <Space>
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
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset) {
    return [
        asset.title,
        asset.source || "",
        asset.note || "",
        metadataString(asset, "prompt"),
        metadataString(asset, "model"),
        metadataString(asset, "module"),
        (asset.tags || []).join(" "),
        asset.kind === "text" ? asset.data.content : asset.data.mimeType,
    ]
        .join(" ")
        .toLowerCase();
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
                {model ? <TraceLine label="模型" value={model} /> : null}
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

function canReplicate(asset: Asset) {
    return Boolean(buildRecreateUrl(asset));
}

function buildRecreateUrl(asset: Asset) {
    const explicitPath = metadataString(asset, "recreatePath");
    if (explicitPath) return explicitPath;
    const prompt = metadataString(asset, "prompt") || (asset.kind === "text" ? asset.data.content : "");
    if (!prompt.trim()) return "";
    const model = metadataString(asset, "model");
    const source = metadataString(asset, "source");
    const toolMode = metadataString(asset, "toolMode") || "image-generation";
    const params = new URLSearchParams();
    params.set("prompt", prompt);
    if (model) params.set("model", model);
    if (source === "video-page") return `/video?${params.toString()}`;
    params.set("tool", toolMode);
    return `/image?${params.toString()}`;
}
