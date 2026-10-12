import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button } from "antd";
import { Download, FileUp, MessageSquareText, Plus } from "lucide-react";

import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectGrid } from "./canvas-project-grid";
import { CanvasSaveStatus } from "@/components/canvas/canvas-save-status";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useCanvasExport } from "@/hooks/use-canvas-export";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { importCanvasArchive } from "./import-canvas";

export default function CanvasPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLElement>(null);
    const exportProjects = useCanvasExport();
    const autoOpenRef = useRef(false);
    const importLockRef = useRef(false);
    const [importing, setImporting] = useState(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const localProjects = useCanvasStore((state) => state.projects);
    const unloadedProjects = useCanvasStore((state) => state.unloadedProjects);
    const projects = useMemo(() => canvasLibrarySummaries(localProjects, unloadedProjects), [localProjects, unloadedProjects]);
    const createProject = useCanvasStore((state) => state.createProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const exporting = useCanvasUiStore((state) => state.exportingProjectIds.length > 0);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const mode = searchParams.get("mode");
    const tool = searchParams.get("tool");
    const chatMode = tool === "gpt-chat";
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode || chatMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        navigate(`/canvas/${id}${agentQuery}`);
    };
    const createAndEnter = () => enterProject(createProject(`无线画布 ${projects.length + 1}`));
    const importCanvas = async (file?: File) => {
        if (!file || importLockRef.current) return;
        importLockRef.current = true;
        setImporting(true);
        const key = "canvas-archive-import";
        try {
            const count = await importCanvasArchive(file, { onProgress: value => {
                if (value.phase !== "complete") void message.open({ key, type: "loading", content: `${value.label}${value.total ? ` (${value.completed}/${value.total})` : ""}`, duration: 0 });
            } });
            message.success({ key, content: `已导入 ${count} 个画布`, duration: 3 });
        } catch (error) {
            console.error("画布导入失败", error);
            message.error({ key, content: error instanceof Error ? error.message : "导入失败，请重试。", duration: 5 });
        } finally {
            importLockRef.current = false;
            setImporting(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(`无线画布 ${projects.length + 1}`) : projects[0]?.id || createProject(`无线画布 ${projects.length + 1}`));
    }, [createProject, hydrated, mode, projects]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">正在打开画布...</main>;

    return (
        <main ref={scrollRef} className="wb-page h-full overflow-auto">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-5 sm:p-8">
                <header className="wb-page-header">
                    <div>
                        <p className="wb-eyebrow">{chatMode ? "在线功能" : "画布库"}</p>
                        <h1 className="wb-title">{chatMode ? "GPT 对话" : "无线画布"}</h1>
                        {!chatMode ? <p className="wb-description">{projects.length} 个画布 · <CanvasSaveStatus /></p> : null}
                        {chatMode ? <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">选择或新建一个画布后，助手会围绕当前项目内容进行对话、拆解提示词和生成建议，后台会把相关任务归入画布项目历史。</p> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} loading={exporting} icon={<Download className="size-4" />} onClick={() => void exportProjects(selectedIds, `无线画布-${selectedIds.length}个项目`)}>
                                    导出选中
                                </Button>
                                <Button danger disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    删除选中
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button type="text" danger disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                删除全部
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} loading={importing} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {importing ? "正在导入…" : "导入画布"}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {chatMode ? "新建对话画布" : "新建画布"}
                        </Button>
                    </div>
                </header>

                {chatMode ? (
                    <section className="grid gap-3 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-950 dark:border-orange-900 dark:bg-orange-950/30 dark:text-orange-100 md:grid-cols-[auto_minmax(0,1fr)]">
                        <div className="flex size-10 items-center justify-center rounded-full bg-orange-600 text-white">
                            <MessageSquareText className="size-5" />
                        </div>
                        <div>
                            <div className="font-semibold">画布 GPT 对话模式已启用</div>
                            <p className="mt-1 leading-6">从这里进入的项目会保留 `tool=gpt-chat` 参数，适合把素材、提示词和生成结果放在同一个画布里复盘。</p>
                        </div>
                    </section>
                ) : null}

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">正在加载画布...</section>
                ) : projects.length ? (
                    <CanvasProjectGrid projects={projects} scrollElement={scrollRef} />
                ) : (
                    <section className="wb-surface wb-empty min-h-[360px]">
                        <h2 className="text-xl font-medium">还没有画布</h2>
                        <p className="mt-3 text-sm text-stone-500">{chatMode ? "新建一个对话画布后，就可以围绕项目素材持续讨论和生成。" : "新建一个画布后，就可以独立保存节点、连线和画布外观。"}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {chatMode ? "新建对话画布" : "新建画布"}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
