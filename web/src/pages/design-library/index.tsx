import { getUiLocale, useUiText } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Pagination, Segmented, Skeleton, Tag } from "antd";
import { ArrowLeft, BookOpen, Plus, RefreshCw, Search } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { deploymentFeatures } from "@/lib/deployment-features";
import { getDesignLibraryEntry, listDesignLibrary, moderateDesignLibrary, withdrawDesignLibrary } from "@/services/api/design-library";
import { useUserStore } from "@/stores/use-user-store";
import type { DesignLibraryEntry, DesignLibraryList } from "@/types/design-library";
import { EntryDetail, statusLabels } from "./entry-detail";
import { PublishDialog } from "./publish-dialog";
import { LibraryImage } from "./library-image";
import { readDesignLibraryShareDraft } from "./share-draft";

export default function DesignLibraryPage() {
    const t = useUiText();
    const { message, modal } = App.useApp();
    const location = useLocation();
    const admin = location.pathname.startsWith("/admin/");
    const [searchParams, setSearchParams] = useSearchParams();
    const user = useUserStore(state => state.user);
    const owner = user?.id || "";
    const [shareDraft, setShareDraft] = useState(() => readDesignLibraryShareDraft(location.state, owner));
    const [scope, setScope] = useState<"company" | "mine">("company");
    const [query, setQuery] = useState("");
    const [keyword, setKeyword] = useState("");
    const [tag, setTag] = useState("");
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [result, setResult] = useState<{ owner: string; value: DesignLibraryList } | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [opened, setOpened] = useState<{ owner: string; entry: DesignLibraryEntry; key: string } | null>(null);
    const [opening, setOpening] = useState("");
    const detailRequest = useRef<AbortController | null>(null);
    const [publishOwner, setPublishOwner] = useState(searchParams.get("publish") === "1" ? owner : "");
    const [moderationReason, setModerationReason] = useState("");
    const [moderating, setModerating] = useState(false);
    const [moderationOpen, setModerationOpen] = useState(false);
    const moderationBusy = useRef(false);
    const enabled = deploymentFeatures.oaLoginEnabled;
    const data = result?.owner === owner ? result.value : null;
    const detail = opened?.owner === owner ? opened : null;

    useEffect(() => {
        if (shareDraft && location.state) setSearchParams(new URLSearchParams(searchParams), { replace: true, state: null });
    }, [shareDraft, location.state, searchParams, setSearchParams]);

    useEffect(() => {
        const controller = new AbortController();
        if (!enabled) { setLoading(false); return; }
        setLoading(true); setError("");
        void listDesignLibrary({ scope: admin ? "all" : scope, q: keyword, tag, page, pageSize: 24 }, admin, controller.signal)
            .then(value => { if (!controller.signal.aborted) setResult({ owner, value }); })
            .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("共享库加载失败")); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [owner, scope, keyword, tag, page, revision, admin, enabled]);
    useEffect(() => {
        setOpened(null); setModerationOpen(false); setPublishOwner(searchParams.get("publish") === "1" && !admin ? owner : "");
        return () => detailRequest.current?.abort();
    }, [owner, admin]);
    const closePublish = () => {
        setPublishOwner("");
        setShareDraft(undefined);
        if (searchParams.has("publish")) { const next = new URLSearchParams(searchParams); next.delete("publish"); setSearchParams(next, { replace: true }); }
    };
    const openEntry = async (id: string) => {
        detailRequest.current?.abort();
        const controller = new AbortController(); detailRequest.current = controller;
        setOpening(id);
        try {
            const entry = await getDesignLibraryEntry(id, admin, controller.signal);
            if (!controller.signal.aborted) setOpened({ owner, entry, key: `${entry.id}:${Date.now()}` });
        } catch (reason) { if (!controller.signal.aborted) message.error(reason instanceof Error ? reason.message : t("作品暂不可访问，请刷新列表")); }
        finally { if (!controller.signal.aborted) setOpening(""); }
    };
    const updateEntry = (entry: DesignLibraryEntry) => {
        setOpened(current => current && current.owner === owner ? { ...current, entry } : null);
        setRevision(value => value + 1);
    };
    const withdraw = () => {
        if (!detail) return;
        const entry = detail.entry;
        modal.confirm({ title: t("撤回这份分享？"), content: t("同事将无法继续访问、下载或复用。已经下载或加入其他画布的副本无法收回。你仍可查看作品和使用统计。"), okText: t("确认撤回"), cancelText: t("保持分享"), okButtonProps: { danger: true }, onOk: async () => {
            try { updateEntry(await withdrawDesignLibrary(entry.id, { expectedOwnerId: owner })); message.success(t("已撤回，后续共享访问已停止")); }
            catch (reason) { message.error(reason instanceof Error ? reason.message : t("撤回失败，请重试")); throw reason; }
        } });
    };
    const moderate = async () => {
        if (!detail || moderationBusy.current) return;
        if (!moderationReason.trim()) { message.warning(t("请填写下架原因")); return; }
        moderationBusy.current = true; setModerating(true);
        try { updateEntry(await moderateDesignLibrary(detail.entry.id, moderationReason.trim(), { expectedOwnerId: owner })); setModerationOpen(false); message.success(t("作品已下架，原因已写入审计记录")); }
        catch (reason) { message.error(reason instanceof Error ? reason.message : t("下架失败，请重试")); }
        finally { moderationBusy.current = false; setModerating(false); }
    };

    return <div className="wb-page h-full overflow-y-auto">
        <main className="mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
            {admin && <Link to="/admin" className="flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft size={14} />{t("返回管理中心")}</Link>}
            <header className="wb-header !mb-0">
                <div><div className="wb-eyebrow">{admin ? t("公司内容管理") : t("同事的灵感，新的起点")}</div><h1 className="wb-title">{admin ? t("设计灵感库管理") : t("公司设计灵感库")}</h1><p className="wb-description">{admin ? t("浏览可管理范围内的作品、查看使用统计，处理需要停止共享的内容。") : t("分享设计思路、提示词与 AI 作品。从同事的探索中发现灵感，带回自己的画布继续创作。")}</p></div>
                {enabled && !admin && <Button type="primary" size="large" icon={<Plus size={18} />} onClick={() => setPublishOwner(owner)}>{t("分享我的设计")}</Button>}
            </header>
            {!enabled ? <section className="wb-surface py-16 text-center"><BookOpen className="mx-auto mb-4 size-10 text-muted-foreground" /><h2 className="mb-2 text-xl font-semibold">{t("公司共享需要 OA 员工身份")}</h2><p className="mx-auto max-w-xl px-6 text-sm leading-7 text-muted-foreground">{deploymentFeatures.authenticationEnabled ? t("当前为个人账号模式，尚未启用公司 OA 接入，公司设计灵感库暂未开放。个人素材仍按账号隔离，不会自动公开。") : t("当前为本机试用模式，设计灵感库未开放。启用公司 OA 接入后，每位设计师可自主发布，系统会按员工身份保存作者和使用记录。本机素材不会自动公开。")}</p><Link to="/canvas"><Button className="mt-6">{t("返回我的画布")}</Button></Link></section> : <>
                <section className="flex flex-wrap items-center justify-between gap-3" aria-label={t("共享库筛选")}>
                    {admin ? <Tag>{t("仅显示当前管理员有权管理的内容")}</Tag> : <Segmented value={scope} options={[{ label: t("全公司共享"), value: "company" }, { label: t("我的发布"), value: "mine" }]} onChange={value => { setScope(value as "company" | "mine"); setPage(1); }} />}
                    <div className="flex min-w-0 flex-wrap items-center gap-2"><Input.Search className="!w-64 max-w-full" prefix={<Search size={15} />} placeholder={t("搜索标题、思路、提示词")} value={query} onChange={event => setQuery(event.target.value)} onSearch={value => { setKeyword(value.trim()); setPage(1); }} allowClear /><Button aria-label={t("刷新共享库")} icon={<RefreshCw size={16} />} loading={loading} onClick={() => setRevision(value => value + 1)} /></div>
                </section>
                {tag && <div className="text-sm">{t("标签筛选：")}<Tag closable onClose={() => { setTag(""); setPage(1); }}>{tag}</Tag></div>}
                {error && <Alert type="error" showIcon title={t("设计灵感库暂未更新")} description={error} action={<Button onClick={() => setRevision(value => value + 1)}>{t("重试")}</Button>} />}
                {loading && !data ? <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="wb-surface p-4"><Skeleton.Image active className="!h-40 !w-full" /><Skeleton active title={{ width: "70%" }} paragraph={{ rows: 2 }} /></div>)}</div> : data?.items.length ? <>
                    <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{data.total} {t("份")}{scope === "mine" && !admin ? t("自主发布的") : t("设计")}{t("分享")}</span><span>{t("最新发布优先 · 原画布始终私有")}</span></div>
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy={loading}>
                        {data.items.map(entry => <article key={entry.id} className="wb-surface group flex min-w-0 flex-col overflow-hidden">
                            <button type="button" aria-label={t("查看作品：{p0}", { p0: String(entry.title) })} disabled={opening === entry.id} className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted/30 text-left focus-visible:outline-2 focus-visible:outline-primary" onClick={() => void openEntry(entry.id)}>
                                {entry.images[0] ? <LibraryImage {...entry.images[0]} alt={entry.title} className="size-full object-contain transition-transform duration-300 motion-reduce:transition-none group-hover:scale-[1.025]" /> : <div className="p-6"><BookOpen className="mb-3 text-muted-foreground" /><p className="line-clamp-4 whitespace-pre-wrap text-sm leading-6">{entry.thought || entry.prompt || t("打开阅读这份设计灵感")}</p></div>}
                                {entry.images.length > 1 && <span className="absolute bottom-2 right-2 rounded bg-background/90 px-2 py-1 text-xs">{entry.images.length} {t("张图片")}</span>}
                                {entry.status !== "published" && <span className="absolute left-2 top-2 rounded bg-background/95 px-2 py-1 text-xs">{t(statusLabels[entry.status])}</span>}
                            </button>
                            <div className="flex flex-1 flex-col gap-2 p-4"><button type="button" className="line-clamp-2 text-left font-semibold leading-6 hover:text-primary" onClick={() => void openEntry(entry.id)}>{entry.title}</button><div className="text-xs text-muted-foreground">{entry.author.name} · {entry.author.departmentName || t("部门未设置")}</div><div className="mt-auto flex flex-wrap gap-1 pt-2">{entry.tags.slice(0, 4).map(value => <button type="button" key={value} className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setTag(value); setPage(1); }}>#{value}</button>)}</div><div className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleDateString(getUiLocale())}{opening === entry.id ? t(" · 正在打开…") : ""}</div></div>
                        </article>)}
                    </div>
                    <Pagination current={page} pageSize={24} total={data.total} onChange={setPage} showSizeChanger={false} hideOnSinglePage className="self-center" />
                </> : !error && <section className="wb-surface py-16"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword || tag ? t("没有找到匹配作品，试试其他关键词") : scope === "mine" ? t("你还没有公开的设计分享") : t("灵感库等待第一份分享")}>{!admin && !keyword && !tag && <Button type="primary" onClick={() => setPublishOwner(owner)}>{t("分享我的设计")}</Button>}</Empty></section>}
            </>}
        </main>
        {enabled && !admin && publishOwner === owner && Boolean(owner) && <PublishDialog key={owner} initialDraft={shareDraft?.ownerId === owner ? shareDraft : undefined} onClose={closePublish} onPublished={entry => { closePublish(); setScope("mine"); setPage(1); setKeyword(""); setQuery(""); setTag(""); setRevision(value => value + 1); setOpened({ owner, entry, key: `${entry.id}:${Date.now()}` }); }} />}
        {detail && <EntryDetail key={detail.key} entry={detail.entry} admin={admin} onClose={() => setOpened(null)} onWithdraw={withdraw} onModerate={() => { setModerationReason(""); setModerationOpen(true); }} />}
        <Modal open={moderationOpen && Boolean(detail)} title={t("下架共享作品")} okText={t("确认下架")} cancelText={t("取消")} okButtonProps={{ danger: true }} confirmLoading={moderating} onOk={() => void moderate()} onCancel={() => { if (!moderationBusy.current) setModerationOpen(false); }}>
            <p className="mb-4 text-sm text-muted-foreground">{t("停止后续访问、下载和复用；已有副本无法收回。下架原因会记录在管理员审计中。")}</p><Input.TextArea aria-label={t("下架原因")} value={moderationReason} maxLength={1000} rows={4} showCount onChange={event => setModerationReason(event.target.value)} placeholder={t("请填写具体下架原因")} />
        </Modal>
    </div>;
}
