import { getUiLocale, useUiText } from "@/lib/i18n";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Drawer, Empty, Modal, Select, Tag } from "antd";
import { BarChart3, Copy, Download, Frame, ImageOff } from "lucide-react";
import { saveAs } from "file-saver";
import copy from "copy-to-clipboard";
import { useNavigate } from "react-router-dom";
import { createClientId } from "@/lib/client-id";
import { formatBytes } from "@/lib/image-utils";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { addDesignLibraryImageToCanvas, DesignLibraryCanvasPersistenceError } from "@/lib/canvas/canvas-design-library-reuse";
import { downloadDesignLibraryImage, getDesignLibraryEntry, recordDesignLibraryEvent } from "@/services/api/design-library";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { DesignLibraryEntry } from "@/types/design-library";
const StatsDrawer = lazy(() => import("./stats-drawer").then(module => ({ default: module.StatsDrawer })));

export const statusLabels = { published: "已发布", withdrawn: "本人已撤回", taken_down: "管理员已下架" };

export function EntryDetail({ entry, admin, onClose, onWithdraw, onModerate }: { entry: DesignLibraryEntry; admin: boolean; onClose: () => void; onWithdraw: () => void; onModerate: () => void }) {
    const t = useUiText();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const ownerId = useUserStore(state => state.user?.id);
    const [imageIndex, setImageIndex] = useState(0);
    const [failedImage, setFailedImage] = useState("");
    const [statsOpen, setStatsOpen] = useState(false);
    const [reuseOpen, setReuseOpen] = useState(false);
    const [target, setTarget] = useState("");
    const [action, setAction] = useState("");
    const [trackingError, setTrackingError] = useState(false);
    const [saveFailedProject, setSaveFailedProject] = useState("");
    const actionRef = useRef(false);
    const views = useRef(new Set<string>());
    const viewRequest = useRef(createClientId());
    const alive = useRef(true);
    const projects = useCanvasStore(state => state.projects);
    const unloaded = useCanvasStore(state => state.unloadedProjects);
    const hydrated = useCanvasStore(state => state.hydrated);
    const options = useMemo(() => canvasLibrarySummaries(projects, unloaded).map(project => ({ label: project.title, value: project.id })), [projects, unloaded]);
    const image = entry.images[imageIndex];
    const available = entry.status === "published" && !admin;
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => {
        if (!available || views.current.has("entry")) return;
        views.current.add("entry");
        void recordDesignLibraryEvent(entry.id, { action: "view", requestId: viewRequest.current }, { expectedOwnerId: ownerId }).catch(() => { if (alive.current) setTrackingError(true); });
    }, [entry.id, available, ownerId]);
    const recordImageView = () => {
        if (!available || !image || views.current.has(image.id)) return;
        views.current.add(image.id);
        void recordDesignLibraryEvent(entry.id, { action: "view", imageId: image.id, requestId: viewRequest.current }, { expectedOwnerId: ownerId }).catch(() => { if (alive.current) setTrackingError(true); });
    };
    const run = async (key: string, work: () => Promise<void>) => {
        if (actionRef.current) return;
        actionRef.current = true; setAction(key);
        try { await work(); }
        catch (error) {
            if (alive.current && useUserStore.getState().user?.id === ownerId) {
                if (error instanceof DesignLibraryCanvasPersistenceError) { setSaveFailedProject(error.projectId); setReuseOpen(false); }
                message.error(error instanceof Error ? error.message : t("操作未完成，请重试"));
            }
        } finally { actionRef.current = false; if (alive.current) setAction(""); }
    };
    const download = () => run("download", async () => {
        if (!image) return;
        const requestId = createClientId();
        const blob = await downloadDesignLibraryImage(entry.id, image.id, requestId, { expectedOwnerId: ownerId });
        if (!alive.current || useUserStore.getState().user?.id !== ownerId) return;
        saveAs(blob, image.filename);
        message.success(t("原图已交给浏览器下载"));
        try { await recordDesignLibraryEvent(entry.id, { action: "download", imageId: image.id, requestId }, { expectedOwnerId: ownerId }); }
        catch { if (alive.current) setTrackingError(true); }
    });
    const copyPrompt = () => run("copy", async () => {
        const latest = await getDesignLibraryEntry(entry.id);
        if (!alive.current || useUserStore.getState().user?.id !== ownerId) return;
        if (latest.status !== "published" || !latest.prompt) throw new Error(t("这份分享已不可复制，请刷新作品详情"));
        if (!copy(latest.prompt)) throw new Error(t("复制失败，请手动选择提示词复制"));
        message.success(t("提示词已复制"));
        try { await recordDesignLibraryEvent(entry.id, { action: "prompt_copy", requestId: createClientId() }, { expectedOwnerId: ownerId }); }
        catch { if (alive.current) setTrackingError(true); }
    });
    const reuse = () => run("reuse", async () => {
        if (!image) return;
        const result = await addDesignLibraryImageToCanvas(entry, image, target || undefined);
        if (!alive.current || useUserStore.getState().user?.id !== ownerId) return;
        if (!result.trackingRecorded) message.warning(t("图片已保存到你的画布，但使用统计暂未记入"));
        else message.success(t("已保存独立图片副本，可以继续创作"));
        navigate(`/canvas/${encodeURIComponent(result.projectId)}`);
    });

    return <>
        <Drawer open title={entry.title} size={1120} onClose={onClose}>
            <div className="mb-5 flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{entry.author.name}</span><span className="text-muted-foreground">{entry.author.departmentName || t("部门未设置")} · {new Date(entry.createdAt).toLocaleDateString(getUiLocale())}</span><Tag>{t(statusLabels[entry.status])}</Tag>{entry.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>
            {!available && entry.status !== "published" && <Alert className="mb-4" type="warning" showIcon title={t("此作品已停止共享")} description={t("不再允许新的下载、复制提示词或画布复用。已经获得的独立副本不受影响。")} />}
            <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
                <section className="min-w-0">
                    {image ? <>
                        <div className="flex min-h-64 items-center justify-center rounded-xl border border-border bg-muted/30 p-2">
                            {failedImage === image.id ? <div className="py-20 text-center text-muted-foreground"><ImageOff className="mx-auto mb-3" /><p>{t("图片暂时无法读取，请刷新作品重试")}</p></div> : <img key={image.id} src={image.contentUrl} alt={image.filename} className="max-h-[60vh] w-full object-contain" onLoad={recordImageView} onError={() => setFailedImage(image.id)} />}
                        </div>
                        <div className="my-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span className="break-all">{image.filename}</span><span>{image.width && image.height ? `${image.width} × ${image.height} · ` : ""}{formatBytes(image.byteSize)} · {imageIndex + 1}/{entry.images.length}</span></div>
                        {entry.images.length > 1 && <div className="mb-4 flex gap-2 overflow-x-auto pb-2">{entry.images.map((item, index) => <button type="button" key={item.id} aria-label={t("查看图片 {p0}：{p1}", { p0: String(index + 1), p1: String(item.filename) })} aria-pressed={index === imageIndex} onClick={() => { setImageIndex(index); setFailedImage(""); }} className={`size-16 shrink-0 overflow-hidden rounded-lg border-2 ${index === imageIndex ? "border-primary" : "border-transparent"}`}><img src={item.contentUrl} alt="" className="size-full object-cover" /></button>)}</div>}
                        {!admin && <div className="flex flex-wrap gap-2"><Button icon={<Download size={16} />} disabled={!available || Boolean(action)} loading={action === "download"} onClick={() => void download()}>{t("下载原图")}</Button><Button type="primary" icon={<Frame size={16} />} disabled={!available || !hydrated || Boolean(action) || Boolean(saveFailedProject)} onClick={() => setReuseOpen(true)}>{t("放到我的画布")}</Button></div>}
                    </> : <div className="flex min-h-56 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("这是一份文字灵感分享")} /></div>}
                </section>
                <section className="min-w-0 space-y-5">
                    {entry.thought && <div><h3 className="mb-2 text-base font-semibold">{t("设计思路")}</h3><p className="whitespace-pre-wrap break-words text-sm leading-7">{entry.thought}</p></div>}
                    {entry.prompt && <div><div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">{t("生图提示词")}</h3>{!admin && <Button size="small" icon={<Copy size={14} />} loading={action === "copy"} disabled={!available || Boolean(action)} onClick={() => void copyPrompt()}>{t("复制提示词")}</Button>}</div><pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-muted/50 p-4 font-mono text-xs leading-6">{entry.prompt}</pre></div>}
                    {!admin && <p className="rounded-lg border border-border p-3 text-xs leading-6 text-muted-foreground">{t("下载或放入画布后，作者可看到你的员工姓名、部门和操作时间。浏览仅统计次数与人数，不公开浏览者名单；你的私人画布与后续创作不会共享。")}</p>}
                    {trackingError && <Alert type="warning" title={t("部分使用统计暂未记入，已完成的操作不受影响")} />}
                    {saveFailedProject && <Alert type="error" title={t("图片已加入，但画布保存尚未完成")} description={t("不要重复添加。打开该画布处理保存状态。")} action={<Button onClick={() => navigate(`/canvas/${encodeURIComponent(saveFailedProject)}`)}>{t("打开画布")}</Button>} />}
                    <div className="flex flex-wrap gap-2 border-t border-border pt-4">{entry.canViewStats && <Button icon={<BarChart3 size={16} />} onClick={() => setStatsOpen(true)}>{t("使用统计")}</Button>}{entry.canWithdraw && !admin && <Button danger onClick={onWithdraw}>{t("撤回分享")}</Button>}{entry.canModerate && admin && <Button danger onClick={onModerate}>{t("下架作品")}</Button>}</div>
                </section>
            </div>
        </Drawer>
        <Modal open={reuseOpen} title={t("把独立副本放到我的画布")} okText={t("保存副本并打开画布")} cancelText={t("取消")} confirmLoading={action === "reuse"} onOk={() => void reuse()} onCancel={() => { if (!actionRef.current) setReuseOpen(false); }} maskClosable={!action}>
            <p className="mb-4 text-sm text-muted-foreground">{t("只添加当前图片，不覆盖已有节点、连线或聊天。作者之后撤回分享，不影响你保存的副本。")}</p>
            <Select className="w-full" value={target} onChange={setTarget} disabled={Boolean(action)} showSearch optionFilterProp="label" options={[{ value: "", label: t("新建画布，继续创作") }, ...options]} />
        </Modal>
        {statsOpen && <Suspense fallback={<Drawer open title={t("使用统计")} size={860} onClose={() => setStatsOpen(false)}><p role="status">{t("正在加载使用统计…")}</p></Drawer>}><StatsDrawer entry={entry} admin={admin} onClose={() => setStatsOpen(false)} /></Suspense>}
    </>;
}
