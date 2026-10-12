import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Form, Input, Modal, Select, Tag } from "antd";
import { ImagePlus, X } from "lucide-react";

import { createClientId } from "@/lib/client-id";
import { formatBytes } from "@/lib/image-utils";
import { publishDesignLibrary } from "@/services/api/design-library";
import { listServerAssets, uploadServerAsset, type ServerAsset } from "@/services/api/server-assets";
import { useUserStore } from "@/stores/use-user-store";
import type { DesignLibraryEntry } from "@/types/design-library";

type DraftFile = { id: string; file: File; preview: string; assetId?: string };
type Fields = { title: string; thought: string; prompt: string; tags: string[] };
const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function PublishDialog({ onClose, onPublished }: { onClose: () => void; onPublished: (entry: DesignLibraryEntry) => void }) {
    const { message, modal } = App.useApp();
    const ownerId = useUserStore(state => state.user?.id);
    const [form] = Form.useForm<Fields>();
    const [files, setFiles] = useState<DraftFile[]>([]);
    const filesRef = useRef(files);
    filesRef.current = files;
    const [assets, setAssets] = useState<ServerAsset[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [assetError, setAssetError] = useState("");
    const [assetLoading, setAssetLoading] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const requestRef = useRef({ fingerprint: "", requestId: "" });
    const inputRef = useRef<HTMLInputElement>(null);
    const mounted = useRef(true);
    const dirty = useRef(false);
    const title = Form.useWatch("title", form) || "未填写标题";
    const thought = Form.useWatch("thought", form) || "";
    const prompt = Form.useWatch("prompt", form) || "";
    const tags: string[] = Form.useWatch("tags", form) || [];

    useEffect(() => {
        mounted.current = true;
        const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", warn);
        return () => { mounted.current = false; filesRef.current.forEach(item => URL.revokeObjectURL(item.preview)); window.removeEventListener("beforeunload", warn); };
    }, []);

    const loadAssets = async () => {
        if (!ownerId || assetLoading) return;
        setAssetLoading(true); setAssetError("");
        try {
            const result = await listServerAssets(AbortSignal.timeout(20_000));
            if (mounted.current && useUserStore.getState().user?.id === ownerId) {
                setAssets(result.assets.filter(asset => asset.ownerUserId === ownerId && asset.kind === "image" && asset.status === "ready" && supportedTypes.has(asset.mimeType) && asset.byteSize <= 20 * 1024 * 1024));
            }
        } catch (error) { if (mounted.current) setAssetError(error instanceof Error ? error.message : "私有图片加载失败"); }
        finally { if (mounted.current) setAssetLoading(false); }
    };

    const addFiles = (selected: FileList | null) => {
        if (!selected) return;
        const incoming = Array.from(selected);
        if (incoming.some(file => !supportedTypes.has(file.type) || file.size > 20 * 1024 * 1024 || !file.size)) {
            message.error("请选择 PNG、JPG、WebP 或 GIF 图片，每张不超过 20 MB。"); return;
        }
        if (files.length + selectedIds.length + incoming.length > 12) { message.warning("每次最多分享 12 张图片"); return; }
        dirty.current = true; setAcknowledged(false);
        setFiles(current => [...current, ...incoming.map(file => ({ id: createClientId(), file, preview: URL.createObjectURL(file) }))]);
    };

    const close = () => {
        if (busyRef.current) return;
        if (!dirty.current) { onClose(); return; }
        modal.confirm({ title: "放弃本次分享草稿？", content: "草稿尚未公开，关闭后需要重新填写。", okText: "放弃草稿", cancelText: "继续编辑", onOk: onClose });
    };

    const publish = async () => {
        if (busyRef.current || !ownerId || !acknowledged) return;
        busyRef.current = true; setBusy(true);
        try {
            const assertOwner = () => { if (!mounted.current || useUserStore.getState().user?.id !== ownerId) throw new Error("员工身份已变化，请重新打开发布窗口"); };
            let values: Fields;
            try { values = await form.validateFields(); } catch { return; }
            assertOwner();
            if (!values.thought?.trim() && !values.prompt?.trim() && !files.length && !selectedIds.length) throw new Error("请至少填写设计思路、提示词或选择一张图片");
            const selectedAssets = assets.filter(asset => selectedIds.includes(asset.id));
            if (files.length + selectedIds.length > 12 || files.reduce((sum, item) => sum + item.file.size, 0) + selectedAssets.reduce((sum, item) => sum + item.byteSize, 0) > 100 * 1024 * 1024) throw new Error("最多 12 张图片，合计不超过 100 MB");
            const assetIds = [...selectedIds];
            for (const item of files) {
                assertOwner();
                if (!item.assetId) {
                    item.assetId = await uploadServerAsset(item.file, { source: "design-library-upload" }, { clientReferenceId: `library:${item.id}`, expectedOwnerId: ownerId, signal: AbortSignal.timeout(60_000) });
                }
                assertOwner(); assetIds.push(item.assetId);
            }
            const input = { title: values.title.trim(), thought: values.thought?.trim() || "", prompt: values.prompt?.trim() || "", tags: values.tags || [], assetIds };
            const fingerprint = JSON.stringify(input);
            if (requestRef.current.fingerprint !== fingerprint) requestRef.current = { fingerprint, requestId: createClientId() };
            const result = await publishDesignLibrary({ ...input, requestId: requestRef.current.requestId }, { expectedOwnerId: ownerId });
            assertOwner(); dirty.current = false; message.success("已发布到公司设计灵感库"); onPublished(result);
        } catch (error) { if (mounted.current && useUserStore.getState().user?.id === ownerId) message.error(error instanceof Error ? error.message : "发布失败，草稿已保留，可重试"); }
        finally { busyRef.current = false; if (mounted.current) setBusy(false); }
    };

    return <Modal open title="发布到公司设计灵感库" width={920} onCancel={close} maskClosable={!busy} closable={!busy} keyboard={!busy} footer={<div className="flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={close}>取消</Button><Button type="primary" loading={busy} disabled={!acknowledged} onClick={() => void publish()}>确认公开并发布</Button></div>}>
        <div className="grid gap-6 py-3 lg:grid-cols-[1.2fr_1fr]">
            <Form form={form} layout="vertical" disabled={busy} initialValues={{ title: "", thought: "", prompt: "", tags: [] }} onValuesChange={() => { dirty.current = true; setAcknowledged(false); }}>
                <Form.Item label="作品标题" name="title" rules={[{ required: true, whitespace: true, message: "请填写作品标题" }, { max: 120 }]}><Input maxLength={120} placeholder="例如：春夏植物印花的色彩与构图探索" /></Form.Item>
                <Form.Item label="设计思路" name="thought"><Input.TextArea rows={4} maxLength={12000} showCount placeholder="分享你的灵感、设计判断或尝试过程（选填）" /></Form.Item>
                <Form.Item label="生图提示词" name="prompt"><Input.TextArea rows={4} maxLength={12000} showCount placeholder="只粘贴你愿意向全公司公开的提示词（选填）" /></Form.Item>
                <Form.Item label="标签" name="tags" rules={[{ validator: (_, value: string[]) => value?.some(tag => tag.length > 32) ? Promise.reject(new Error("每个标签不超过 32 字")) : Promise.resolve() }]}><Select mode="tags" maxCount={8} tokenSeparators={[",", "，"]} placeholder="输入标签后按回车，最多 8 个" options={[]} /></Form.Item>
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">分享图片 · {files.length + selectedIds.length}/12</span><Button icon={<ImagePlus size={16} />} onClick={() => inputRef.current?.click()}>选择本地图片</Button></div>
                <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { addFiles(event.target.files); event.target.value = ""; }} />
                <p className="my-2 text-xs text-muted-foreground">每张 ≤20 MB，合计 ≤100 MB；按原始图片字节分享。</p>
                <div className="mb-3 grid grid-cols-3 gap-2">{files.map(item => <div key={item.id} className="relative overflow-hidden rounded-lg border border-border"><img className="h-24 w-full object-contain" src={item.preview} alt={item.file.name} /><div className="truncate p-1 text-xs" title={item.file.name}>{item.file.name}</div><button type="button" disabled={busy} aria-label={`移除 ${item.file.name}`} className="absolute right-1 top-1 rounded-full bg-background p-1" onClick={() => { URL.revokeObjectURL(item.preview); setFiles(current => current.filter(file => file.id !== item.id)); setAcknowledged(false); }}><X size={14} /></button></div>)}</div>
                <Select className="w-full" mode="multiple" value={selectedIds} loading={assetLoading} maxCount={12 - files.length} placeholder="或从我的私有图片选择" optionFilterProp="label" onOpenChange={open => { if (open && !assets.length) void loadAssets(); }} options={assets.map(asset => ({ value: asset.id, label: `${asset.filename} · ${formatBytes(asset.byteSize)}` }))} onChange={ids => { dirty.current = true; setSelectedIds(ids); setAcknowledged(false); }} />
                {assetError && <Alert className="mt-2" type="warning" title={assetError} action={<Button size="small" onClick={() => void loadAssets()}>重试</Button>} />}
            </Form>
            <aside className="space-y-4 rounded-xl bg-muted/40 p-4">
                <div><div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground">发布前核对 · 全公司设计师可见</div><h3 className="break-words text-lg font-semibold">{title}</h3></div>
                <p className="text-sm text-muted-foreground">将公开：你的员工姓名与部门、标题、下方填写的思路和提示词、所选图片及标签。</p>
                {thought && <section><h4 className="mb-1 text-sm font-medium">设计思路</h4><p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">{thought}</p></section>}
                {prompt && <section><h4 className="mb-1 text-sm font-medium">提示词</h4><p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs">{prompt}</p></section>}
                {!!tags.length && <div>{tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>}
                {!!selectedIds.length && <div className="grid grid-cols-2 gap-2">{assets.filter(asset => selectedIds.includes(asset.id)).map(asset => <figure key={asset.id}><img src={`/api/assets/${encodeURIComponent(asset.id)}/content`} className="h-24 w-full rounded-md object-contain" alt={asset.filename} /><figcaption className="truncate text-xs">{asset.filename}</figcaption></figure>)}</div>}
                <Alert type="info" showIcon title="只分享本次选中的内容" description="不会公开整个画布、聊天记录、未选图片或隐藏提示词。原始素材保持私有。" />
                <p className="text-xs leading-5 text-muted-foreground">同事可下载原图、复制提示词、添加到自己的画布。你可查看浏览量与人数，以及下载、复用同事的姓名和部门。撤回只能阻止后续访问，无法收回已下载或已复用的副本。</p>
                <Checkbox checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)}>我已核对公开内容，并确认有权分享这些内容</Checkbox>
            </aside>
        </div>
    </Modal>;
}
