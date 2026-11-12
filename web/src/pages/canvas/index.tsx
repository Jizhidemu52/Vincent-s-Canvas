import { useUiLocale, useUiText, uiText } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Select, Skeleton, Tooltip } from "antd";
import { BookOpen, Download, FileUp, HardDrive, LayoutGrid, MessageSquareText, Plus } from "lucide-react";

import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectGrid } from "./canvas-project-grid";
import { CanvasSaveStatus } from "@/components/canvas/canvas-save-status";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasExport } from "@/hooks/use-canvas-export";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { importCanvasArchive } from "./import-canvas";
import { nextProjectTitle } from "@/lib/project-title";
import { sortCanvasLibraryProjects, type CanvasLibrarySort } from "@/lib/canvas/canvas-library-ux";
import { cleanupVerifiedCanvasCache } from "@/services/canvas-cache-maintenance";
import { deploymentFeatures } from "@/lib/deployment-features";

export default function CanvasPage() {
    const t = useUiText();
    const locale = useUiLocale();
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLElement>(null);
    const exportProjects = useCanvasExport();
    const autoOpenRef = useRef(false);
    const importLockRef = useRef(false);
    const [importing, setImporting] = useState(false);
    const [clearingCache, setClearingCache] = useState(false);
    const [creatingExample, setCreatingExample] = useState(false);
    const exampleLockRef = useRef(false);
    const [sort, setSort] = useState<CanvasLibrarySort>("updated");
    const hydrated = useCanvasStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const unloadedProjects = useCanvasStore((state) => state.unloadedProjects);
    const projects = useMemo(() => sortCanvasLibraryProjects(canvasLibrarySummaries(localProjects, unloadedProjects), sort, locale), [localProjects, unloadedProjects, sort, locale]);
    const cloudStatus = useCanvasStore(state => state.cloudStatus);
    const createProject = useCanvasStore((state) => state.createProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const exporting = useCanvasUiStore((state) => state.exportingProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const setSelectedIds = useCanvasUiStore(state => state.setSelectedProjectIds);

    const mode = searchParams.get("mode");
    const tool = searchParams.get("tool");
    const chatMode = tool === "gpt-chat";
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode || chatMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        navigate(`/canvas/${id}${agentQuery}`);
    };
    const createAndEnter = () => {
        const state = useCanvasStore.getState();
        if (state.hydrated) enterProject(createProject(nextProjectTitle(canvasLibrarySummaries(state.projects, state.unloadedProjects))));
    };
    const createExample = async () => {
        if (!useCanvasStore.getState().hydrated || exampleLockRef.current) return;
        const ownerId = useUserStore.getState().user?.id;
        exampleLockRef.current = true;
        setCreatingExample(true);
        try {
            const { createCanvasExampleProject } = await import("@/lib/canvas/canvas-example-graph");
            if (!useCanvasStore.getState().hydrated || ownerId !== useUserStore.getState().user?.id) return;
            navigate(`/canvas/${createCanvasExampleProject()}`);
        } catch (error) { message.error(error instanceof Error ? error.message : t("教学画布创建失败，请重试。")); }
        finally { exampleLockRef.current = false; setCreatingExample(false); }
    };
    const clearCache = () => modal.confirm({
        title: t("清理已验证的本机缓存？"),
        content: t("仅清理已同步且与服务器原件逐字节核对一致的本机图片缓存，保留缩略图和云端原件。未同步图片、素材库及撤销历史引用不会删除；之后可从服务器重新读取。建议先导出备份。"),
        okText: t("验证并清理缓存"), cancelText: t("取消"),
        onOk: async () => {
            setClearingCache(true);
            try {
                const result = await cleanupVerifiedCanvasCache();
                message.success(t("已清理 {count} 项缓存，释放 {size} MB；跳过 {skipped} 项。云端原件未删除。", { count: result.removed, size: (result.bytes / 1024 / 1024).toFixed(1), skipped: result.skipped }));
            } catch (error) { message.error(error instanceof Error ? error.message : t("缓存清理失败，原件保持不变。")); throw error; }
            finally { setClearingCache(false); }
        },
    });
    const importCanvas = async (file?: File) => {
        if (!file || importLockRef.current) return;
        importLockRef.current = true;
        setImporting(true);
        const key = "canvas-archive-import";
        try {
            const count = await importCanvasArchive(file, { onProgress: value => {
                if (value.phase !== "complete") void message.open({ key, type: "loading", content: `${value.label}${value.total ? ` (${value.completed}/${value.total})` : ""}`, duration: 0 });
            } });
            message.success({ key, content: uiText("已导入 {value1} 个画布", { value1: count }), duration: 3 });
        } catch (error) {
            console.error("画布导入失败", error);
            message.error({ key, content: error instanceof Error ? error.message : uiText("导入失败，请重试。"), duration: 5 });
        } finally {
            importLockRef.current = false;
            setImporting(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(nextProjectTitle(projects)) : projects[0]?.id || createProject(nextProjectTitle(projects)));
    }, [createProject, hydrated, mode, projects]);
    useEffect(() => {
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || useCanvasUiStore.getState().editingProjectId) return;
            const element = event.target instanceof Element ? event.target : null;
            if (element?.closest("input,textarea,select,[contenteditable=true],[role=dialog]") || document.querySelector(".ant-modal-wrap:not([style*='display: none'])")) return;
            setSelectedIds([]);
        };
        window.addEventListener("keydown", escape);
        return () => window.removeEventListener("keydown", escape);
    }, [setSelectedIds]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("正在打开画布...")}</main>;

    return (
        <main ref={scrollRef} className="wb-page h-full overflow-auto">
            <div className="mx-auto flex w-full max-w-[1920px] flex-col gap-6 p-5 sm:p-8">
                <header className="wb-page-header">
                    <div>
                        <p className="wb-eyebrow">{chatMode ? t("在线功能") : t("画布库")}</p>
                        <h1 className="wb-title">{chatMode ? t("对话改图") : t("自由画布")}</h1>
                        {!chatMode ? <p className="wb-description">{t("{count} 个画布", { count: projects.length })} · <CanvasSaveStatus /></p> : null}
                        {chatMode ? <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">{t("选择或新建一个画布后，助手会围绕当前项目内容进行对话、拆解提示词和生成建议，后台会把相关任务归入画布项目历史。")}</p> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Tooltip title={t("每次新建一张独立教学画布，包含十类图文案例；不改旧项目、不自动生成。 ")}><Button disabled={!hydrated} loading={creatingExample} icon={<BookOpen className="size-4" />} onClick={() => void createExample()}>{t("新建教学画布")}</Button></Tooltip>
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} loading={exporting} icon={<Download className="size-4" />} onClick={() => void exportProjects(selectedIds, t("自由画布-{count}个项目", { count: selectedIds.length }))}>
                                    {t("导出选中")}</Button>
                                <Button danger disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("删除选中")}</Button>
                            </>
                        ) : null}
                        {deploymentFeatures.authenticationEnabled && cloudStatus !== "local" ? <Button type="text" disabled={!hydrated} loading={clearingCache} icon={<HardDrive className="size-4" />} onClick={clearCache}>{t("清理已同步缓存")}</Button> : null}
                        <Button disabled={!hydrated} loading={importing} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {importing ? t("正在导入…") : t("导入画布")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {chatMode ? t("新建对话画布") : t("新建画布")}
                        </Button>
                    </div>
                </header>
                {projects.length ? <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="text" onClick={() => setSelectedIds(projects.map(project => project.id))}>{t("全选")}</Button>
                        {selectedIds.length ? <Button type="text" onClick={() => setSelectedIds([])}>{t("取消选择（{count}）", { count: selectedIds.length })}</Button> : null}
                    </div>
                    <Select aria-label={t("画布排序")} value={sort} onChange={setSort} virtual={false} style={{ minWidth: 156 }} options={[
                        { value: "updated", label: t("按更新时间排序") }, { value: "created", label: t("按创建时间排序") }, { value: "name", label: t("按名称排序") },
                    ]} />
                </div> : null}

                {chatMode ? (
                    <section className="grid gap-3 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-950 dark:border-orange-900 dark:bg-orange-950/30 dark:text-orange-100 md:grid-cols-[auto_minmax(0,1fr)]">
                        <div className="flex size-10 items-center justify-center rounded-full bg-orange-600 text-white">
                            <MessageSquareText className="size-5" />
                        </div>
                        <div>
                            <div className="font-semibold">{t("画布对话改图模式已启用")}</div>
                            <p className="mt-1 leading-6">{t("从这里进入的画布会自动打开对话改图，可以围绕素材、提示词和生成结果继续讨论。")}</p>
                        </div>
                    </section>
                ) : null}

                {!hydrated ? (
                    <section aria-label={t("正在加载画布…")} className="grid min-h-[360px] grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[120rem]:grid-cols-5">
                        {Array.from({ length: 10 }, (_, index) => <div key={index} className="wb-surface overflow-hidden p-4"><Skeleton.Node active style={{ width: "100%", height: 128 }} /><Skeleton active title paragraph={{ rows: 2 }} className="mt-4" /></div>)}
                    </section>
                ) : projects.length ? (
                    <CanvasProjectGrid projects={projects} scrollElement={scrollRef} />
                ) : (
                    <section className="wb-surface wb-empty min-h-[360px]">
                        <LayoutGrid className="mx-auto mb-4 size-10 text-muted-foreground" aria-hidden />
                        <h2 className="text-xl font-medium">{t("还没有画布")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{chatMode ? t("新建一个对话画布后，就可以围绕项目素材持续讨论和生成。") : t("新建一个画布后，就可以独立保存节点、连线和画布外观。")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {chatMode ? t("新建对话画布") : t("新建画布")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
