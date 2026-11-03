import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Select, Space, Tag, Typography } from "antd";
import { RefreshCw } from "lucide-react";
import { listAdminReleaseNotes, publishReleaseNote, ReleaseNotesError, saveReleaseNoteDraft, type AdminReleaseNote } from "@/services/api/release-notes";
import { releaseVersion } from "@/lib/release-notes-state";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { releaseNotesOwner, releaseNotesStore } from "@/stores/use-release-notes-store";
import { useUserStore } from "@/stores/use-user-store";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";

const currentVersion = releaseVersion(__APP_VERSION__);
const emptyDraft = { title: "", content: "" };

export default function ReleaseNotesPanel() {
    const { message, modal } = App.useApp();
    const user = useUserStore(state => state.user), status = useUserStore(state => state.status);
    const enabled = Boolean(releaseNotesOwner()) && user?.role === "super_admin";
    const [notes, setNotes] = useState<AdminReleaseNote[]>([]), [version, setVersion] = useState(currentVersion);
    const [baseline, setBaseline] = useState<AdminReleaseNote | null>(null), [draft, setDraft] = useState(emptyDraft);
    const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState(""), [conflict, setConflict] = useState(false);
    const pending = useRef(false), epoch = useRef(0);
    const dirty = !baseline?.publishedAt && (draft.title !== (baseline?.title || "") || draft.content !== (baseline?.content || ""));
    const { confirmDiscard } = useUnsavedGuard(dirty || conflict, "版本更新草稿尚未保存，离开后会丢失本次编辑。");
    const ownerId = user?.id;
    const isCurrent = (captured: number) => epoch.current === captured && useUserStore.getState().status === "authenticated" && useUserStore.getState().user?.id === ownerId && useUserStore.getState().user?.role === "super_admin";
    const select = (selected: string, rows = notes) => {
        const note = rows.find(item => item.version === selected) || null;
        setVersion(selected); setBaseline(note); setDraft(note ? { title: note.title, content: note.content } : emptyDraft); setError(""); setConflict(false);
    };
    const load = async (offset = 0, selected = version) => {
        if (pending.current || !enabled) return;
        pending.current = true; setBusy(true);
        const captured = epoch.current;
        try {
            const result = await listAdminReleaseNotes(offset);
            if (!isCurrent(captured)) return;
            const rows = offset ? [...notes, ...result.notes.filter(item => !notes.some(old => old.version === item.version))] : result.notes;
            setNotes(rows); setHasMore(result.hasMore); setReady(true); setError("");
            if (!offset) select(selected, rows);
        } catch (cause) { if (isCurrent(captured)) setError(cause instanceof Error ? cause.message : "更新列表读取失败，请重试"); }
        finally { if (isCurrent(captured)) { pending.current = false; setBusy(false); } }
    };
    useEffect(() => {
        epoch.current++; pending.current = false;
        setNotes([]); setReady(false); setBusy(false); select(currentVersion, []);
        if (enabled) void load(0, currentVersion);
        return () => { epoch.current++; pending.current = false; };
    }, [ownerId, status, enabled]);
    const refresh = async () => {
        if (pending.current) return;
        if (conflict && !await modal.confirm({ title: "读取服务器上的最新版本？", content: "当前文字不会自动合并。请先复制需要保留的内容；继续将用服务器版本替换编辑框。", okText: "读取最新版本", cancelText: "保留当前文字" })) return;
        if (!conflict && !await confirmDiscard()) return;
        await load();
    };
    const save = async () => {
        if (pending.current || !ready || !enabled || baseline?.publishedAt || conflict) return;
        pending.current = true; setBusy(true); setError("");
        const captured = epoch.current;
        try {
            const { note } = await saveReleaseNoteDraft(version, { ...draft, expectedRevision: baseline?.revision ?? null });
            if (!isCurrent(captured)) return;
            setNotes(rows => [note, ...rows.filter(item => item.version !== note.version)]); select(note.version, [note]); message.success("草稿已保存，尚未向使用者公开");
        } catch (cause) {
            if (!isCurrent(captured)) return;
            const conflicted = cause instanceof ReleaseNotesError && cause.status === 409;
            setConflict(conflicted); setError(conflicted ? "此版本已被其他管理员修改或发布。你的文字已保留，请先复制需要保留的内容，再刷新列表核对；不会自动覆盖。" : cause instanceof Error ? cause.message : "草稿保存失败，文字已保留");
        } finally { if (isCurrent(captured)) { pending.current = false; setBusy(false); } }
    };
    const publish = async () => {
        if (pending.current || !baseline || baseline.publishedAt || dirty || conflict || !draft.title.trim() || !draft.content.trim() || !enabled) return;
        pending.current = true;
        const captured = epoch.current;
        if (!await modal.confirm({ title: `发布 ${version} 给所有使用者？`, content: "发布后，所有已登录使用者都可在首页和“版本更新”入口查看。正在创作的人会收到一次非阻断提示。已发布内容不能再修改。", okText: "确认发布", cancelText: "返回检查" })) { pending.current = false; return; }
        if (!isCurrent(captured)) return;
        setBusy(true); setError("");
        try {
            const { note } = await publishReleaseNote(version, baseline.revision);
            if (!isCurrent(captured)) return;
            setNotes(rows => [note, ...rows.filter(item => item.version !== note.version)]); select(note.version, [note]); message.success("已发布，所有使用者可查看此版本更新");
            void releaseNotesStore.getState().refresh(true);
        } catch (cause) {
            if (!isCurrent(captured)) return;
            const conflicted = cause instanceof ReleaseNotesError && cause.status === 409;
            setConflict(conflicted); setError(conflicted ? "发布前内容已变化。当前文字已保留，请刷新列表核对最新版本后再发布。" : cause instanceof Error ? cause.message : "发布结果暂未确认，请刷新列表核查，不要重复发布");
        } finally { if (isCurrent(captured)) { pending.current = false; setBusy(false); } }
    };
    if (!enabled) return <Alert type="info" title="版本更新发布仅供正式服务的超级管理员使用" />;
    const published = Boolean(baseline?.publishedAt);
    const options = [...new Set([currentVersion, ...notes.map(note => note.version)])].map(value => {
        const note = notes.find(item => item.version === value);
        return { value, label: `${value}${value === currentVersion ? " · 当前版本" : ""} · ${note?.publishedAt ? "已发布" : note ? "草稿" : "待编写"}` };
    });
    return <section data-testid="admin-release-notes" className="wb-surface min-w-0 p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">版本更新</h2><p className="mt-1 text-sm text-muted-foreground">先保存草稿，确认后发布给所有使用者。每个版本只发布一次。</p></div><Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void refresh()}>刷新列表</Button></div>
        {error ? <Alert className="mb-5" showIcon type={conflict ? "warning" : "error"} title={error} /> : null}
        <div className="mb-5 grid gap-4 sm:grid-cols-2"><div><label htmlFor="release-current-version" className="mb-2 block text-sm">当前版本</label><Input id="release-current-version" aria-label="当前版本" readOnly value={currentVersion} /><p className="mt-1 text-xs text-muted-foreground">自动取自当前部署版本，不可手动修改。</p></div><div><label className="mb-2 block text-sm">选择版本</label><Select aria-label="选择版本" className="w-full" value={version} options={options} disabled={busy || !ready} onChange={async value => { if (await confirmDiscard()) select(value); }} /></div></div>
        {ready ? <>
            <div className="mb-4 flex flex-wrap items-center gap-2"><Tag color={published ? "green" : "default"}>{published ? "已发布 · 只读" : "未发布草稿"}</Tag><span className="text-xs text-muted-foreground">{published ? `${formatBeijingDateTime(baseline!.publishedAt)} 发布` : "草稿只对超级管理员可见，不会出现在使用者首页。"}</span></div>
            {published ? <article><Typography.Title level={4} style={{ overflowWrap: "anywhere" }}>{baseline?.title}</Typography.Title><Typography.Paragraph style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.9 }}>{baseline?.content}</Typography.Paragraph></article> : <>
                <label htmlFor="release-title" className="mb-2 block text-sm">更新标题</label><Input id="release-title" value={draft.title} maxLength={80} showCount disabled={busy} placeholder="用一句话说明本次更新" onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} />
                <label htmlFor="release-content" className="mb-2 mt-5 block text-sm">更新内容</label><Input.TextArea id="release-content" value={draft.content} maxLength={4000} showCount autoSize={{ minRows: 10, maxRows: 22 }} disabled={busy} placeholder="说明新增功能、改进和使用提醒。按原样保留换行，不支持 HTML 或 Markdown 排版。" onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} />
                <div className="mt-8 flex flex-wrap items-center gap-3"><Space wrap><Button aria-label="保存草稿" aria-busy={busy} onClick={() => void save()} loading={busy} disabled={busy || conflict || (!dirty && Boolean(baseline))}>保存草稿</Button><Button aria-label="发布给所有使用者" aria-busy={busy} type="primary" onClick={() => void publish()} loading={busy} disabled={busy || !baseline || dirty || conflict || !draft.title.trim() || !draft.content.trim()}>发布给所有使用者</Button></Space><span className="text-xs text-muted-foreground">{dirty ? "有未保存修改，请先保存草稿。" : baseline ? "草稿已保存，发布后不可修改。" : "当前版本尚未编写，标题和正文由管理员填写。"}</span></div>
            </>}
        </> : !busy && !error ? <Empty description="暂无版本更新" /> : null}
        {hasMore ? <Button className="mt-6" loading={busy} onClick={() => void load(notes.length)}>加载更早版本</Button> : null}
    </section>;
}
