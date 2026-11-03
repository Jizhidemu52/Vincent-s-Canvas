import { useEffect, useState } from "react";
import { App, Alert, Button, Drawer, Empty, Select, Skeleton, Tag, Typography } from "antd";
import { ArrowUpRight, FileText } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { releaseNotesOwner, releaseNotesStore, useReleaseNotesStore } from "@/stores/use-release-notes-store";
import { releaseNoteSummary } from "@/lib/release-notes-state";
import { formatBeijingDateTime } from "@/lib/beijing-time";

const NOTICE_KEY = "published-release-note";

/** Mounted once, including while the canvas hides its navigation shell. Never opens a drawer automatically. */
export function ReleaseNotesHost() {
    const { notification } = App.useApp();
    const [visibleCheck, setVisibleCheck] = useState(0);
    const state = useReleaseNotesStore(value => value);
    const status = useUserStore(value => value.status);
    const userId = useUserStore(value => value.user?.id);
    const available = status === "authenticated" && state.ownerId === userId && Boolean(releaseNotesOwner());
    useEffect(() => {
        const syncOwner = () => {
            const owner = releaseNotesOwner();
            if (releaseNotesStore.getState().ownerId !== owner) notification.destroy(NOTICE_KEY);
            void releaseNotesStore.getState().setOwner(owner);
        };
        syncOwner();
        const unsubscribe = useUserStore.subscribe(syncOwner);
        const refresh = () => { if (document.visibilityState === "visible" && releaseNotesOwner()) { setVisibleCheck(value => value + 1); void releaseNotesStore.getState().refresh(); } };
        const timer = window.setInterval(refresh, 120_000);
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => { unsubscribe(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); notification.destroy(NOTICE_KEY); void releaseNotesStore.getState().setOwner(null); };
    }, [notification]);
    useEffect(() => {
        if (!available || document.visibilityState !== "visible") return;
        const note = releaseNotesStore.getState().claimNotice();
        if (!note) return;
        const ownerId = state.ownerId;
        notification.info({ key: NOTICE_KEY, title: `版本更新 · ${note.version}`, description: note.title, role: "status", duration: 8, placement: "bottomRight",
            styles: { root: { width: "min(360px, calc(100vw - 32px))" } },
            actions: <Button size="small" onClick={() => { if (releaseNotesOwner() === ownerId) releaseNotesStore.getState().show(note.version); notification.destroy(NOTICE_KEY); }}>查看详情</Button>,
        });
    }, [available, state.notes, state.ownerId, notification, visibleCheck]);
    const note = state.notes.find(item => item.version === state.selectedVersion) || state.notes[0];
    return <Drawer title="版本更新" open={available && state.open} onClose={state.close} size="min(640px, 100vw)" destroyOnHidden styles={{ body: { padding: 24 } }}>
        {state.error ? <Alert type="warning" showIcon title={state.error} action={state.supported ? <Button size="small" onClick={() => void state.refresh(true)}>重试</Button> : undefined} className="mb-5" /> : null}
        {state.loading && !state.notes.length ? <Skeleton active /> : note ? <>
            {state.notes.length > 1 ? <Select aria-label="查看历史版本" className="mb-6 w-full" value={note.version} options={state.notes.map(item => ({ value: item.version, label: `${item.version} · ${item.title}` }))} onChange={state.show} /> : null}
            <div className="mb-3 flex flex-wrap items-center gap-2"><Tag>{note.version}</Tag><Typography.Text type="secondary">{formatBeijingDateTime(note.publishedAt).slice(0, 10)} 发布</Typography.Text></div>
            <Typography.Title level={3} style={{ marginTop: 0, overflowWrap: "anywhere" }}>{note.title}</Typography.Title>
            <Typography.Paragraph data-testid="release-note-content" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.9 }}>{note.content}</Typography.Paragraph>
        </> : !state.loading ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有已发布的版本更新" /> : null}
        {state.hasMore ? <Button block loading={state.loading} onClick={() => void state.refresh(true, true)}>加载更早版本</Button> : null}
    </Drawer>;
}

export function HomeReleaseNote() {
    const note = useReleaseNotesStore(state => state.notes[0]);
    const ownerId = useReleaseNotesStore(state => state.ownerId);
    useUserStore(state => state.status);
    useUserStore(state => state.user?.id);
    if (!note || ownerId !== releaseNotesOwner()) return null;
    return <section data-testid="home-release-note" aria-label="最新版本更新" className="mb-7 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border px-5 py-4">
        <div className="min-w-0 flex-1 basis-64">
            <p className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><FileText size={13} />版本更新</span><span>{note.version}</span><time dateTime={note.publishedAt}>{formatBeijingDateTime(note.publishedAt).slice(0, 10)}</time></p>
            <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">{note.title}</h2>
            <p className="mt-1 line-clamp-2 text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">{releaseNoteSummary(note.content)}</p>
        </div>
        <button type="button" className="wb-nav-link inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-2" onClick={() => releaseNotesStore.getState().show(note.version)}>查看详情<ArrowUpRight size={15} /></button>
    </section>;
}

export function ReleaseNotesNavigation({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
    const state = useReleaseNotesStore(value => value);
    useUserStore(value => value.status);
    useUserStore(value => value.user?.id);
    if (!releaseNotesOwner() || state.ownerId !== releaseNotesOwner() || !state.supported) return null;
    return <button type="button" className={className} onClick={() => { onNavigate?.(); state.show(); }}><FileText className="size-4" /><span>版本更新</span>{state.notes[0] && state.seen.readVersion !== state.notes[0].version ? <span className="ml-auto size-1.5 rounded-full bg-current" aria-label="有未读更新" /> : null}</button>;
}
