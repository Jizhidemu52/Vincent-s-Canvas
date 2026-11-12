import { uiText, useUiText, getUiLocale } from "@/lib/i18n";
import { ArrowRight, BookOpen, ImagePlus, Info, LayoutGrid, MessageSquareText, Plus, Video } from "lucide-react";
import { Popover, Tooltip } from "antd";
import { WorkbenchImage } from "@/components/workbench-image";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { nextProjectTitle } from "@/lib/project-title";
import { navigationTools, navigationModuleKey } from "@/constant/navigation-tools";
import { HomeResources } from "./home-resources";
import { HomeReleaseNote } from "@/components/release-notes";
import { HomeRecentNavigation } from "@/components/layout/frequent-navigation";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import type { ModuleKey } from "@/services/api/modules";
import "./home.css";

const entries = [
    { path: "/canvas", flag: "canvas" as const, icon: LayoutGrid, title: "自由画布", description: "把灵感放在一起，自由编排与创作", action: "打开画布", preview: "knit-sketch" },
    { path: "/image", flag: "image" as const, icon: ImagePlus, title: "图像生成", description: "描述一个想法，把它变成图片", action: "开始生图", preview: "womenswear-source" },
    { path: "/video", flag: "video" as const, icon: Video, title: "视频生成", description: "从文字或图片，生成一段视频", action: "制作视频", preview: "model-natural-source" },
    { path: "/chat", flag: "gpt-chat" as const, icon: MessageSquareText, title: "对话改图", description: "发送图片，接着聊、接着改", action: "开始对话", preview: "hat" },
];

export default function IndexPage() {
    useUiText();
    const navigate = useNavigate();
    const hydrated = useCanvasStore(state => state.hydrated);
    const projects = useCanvasStore(state => state.projects);
    const unloadedProjects = useCanvasStore(state => state.unloadedProjects);
    const createProject = useCanvasStore(state => state.createProject);
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const canvasAvailable = isModuleAvailable(flags, tools, "canvas");
    const summaries = useMemo(() => canvasLibrarySummaries(projects, unloadedProjects), [projects, unloadedProjects]);
    const recent = summaries.slice(0, 8);
    const createAndEnter = () => {
        const current = useCanvasStore.getState();
        if (!current.hydrated || !isModuleAvailable(flags, tools, "canvas")) return;
        navigate("/canvas/" + createProject(nextProjectTitle(canvasLibrarySummaries(current.projects, current.unloadedProjects))));
    };
    return (
        <main className="wb-page home-page h-full overflow-y-auto">
            <div className="home-content">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">{uiText("TruCreate / AI 创意设计平台")}</p><h1 className="wb-title">{uiText("想法成真")}</h1><p className="wb-description">{uiText("选一个工具开始，或回到上次的画布继续创作。")}</p></div>
                    {canvasAvailable ? <Tooltip title={!hydrated ? uiText("正在读取画布，请稍候") : undefined}><span><button type="button" className="wb-primary-link" disabled={!hydrated} onClick={createAndEnter}><Plus size={18} />{uiText("新建画布")}</button></span></Tooltip> : null}
                </header>
                <HomeReleaseNote />
                <HomeRecentNavigation />
                <section className="home-tools" aria-label={uiText("选择创作工具")}>
                    {entries.filter(entry => isModuleAvailable(flags, tools, entry.flag)).map(({ path, icon: Icon, title, description, action, preview }) => <Link to={path} className="wb-surface home-tool" key={path}>
                        <div className="home-tool-preview"><WorkbenchImage src={`/design-examples/${preview}.webp`} alt={uiText("工具效果示意")} loading="lazy" /><span>{uiText("示例")}</span></div>
                        <div className="home-tool-top"><Icon size={20} strokeWidth={1.5} /></div>
                        <h2>{uiText(title || "")}</h2><p>{uiText(description || "")}</p><span className="home-tool-action">{uiText(action || "")}<ArrowRight size={16} /></span>
                    </Link>)}
                </section>
                <section className="my-8" aria-label={uiText("全部工具")}><h2 className="mb-4 text-xl font-semibold">{uiText("全部工具")}</h2><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{navigationTools.filter(tool => tool.group !== "admin" && isModuleAvailable(flags, tools, navigationModuleKey(tool.slug) as ModuleKey)).map(tool => <Link key={tool.slug} to={tool.path} className="wb-surface flex items-center gap-2 px-4 py-3 text-sm"><tool.icon className="size-4 shrink-0" />{uiText(tool.label)}</Link>)}</div></section>
                {canvasAvailable ? <section className="home-projects">
                    <div className="wb-header"><div><p className="wb-eyebrow">{uiText("继续创作")}</p><h2 className="wb-title">{uiText("最近的画布")}</h2></div><Link to="/canvas" className="home-all-link">{uiText("查看全部 ")}{summaries.length ? "(" + summaries.length + ")" : ""}<ArrowRight size={16} /></Link></div>
                    {!hydrated ? <div className="wb-grid" role="status" aria-label={uiText("正在读取画布")}>{Array.from({ length: 4 }, (_, index) => <div className="home-skeleton animate-pulse" key={index} />)}</div> : recent.length ? <div className="home-project-grid">
                        {recent.map(project => {
                            const preview = project.cover;
                            return <Link to={"/canvas/" + project.id} className="wb-surface home-project" key={project.id}>
                                <div className="home-project-preview">{preview ? <CanvasPersistedMediaPreview kind="image" url={preview.content} storageKey={preview.storageKey} alt={project.title} className="h-full w-full object-cover" /> : <LayoutGrid size={32} strokeWidth={1} />}</div>
                                <div className="home-project-info"><h3>{project.title || uiText("未命名画布")}</h3><p>{project.nodeCount} {uiText(" 个内容 · ")}{new Date(project.updatedAt).toLocaleDateString(getUiLocale(), { month: "long", day: "numeric" })} {uiText(" 更新")}</p></div>
                            </Link>;
                        })}
                    </div> : <div className="wb-surface wb-empty"><LayoutGrid size={36} strokeWidth={1.2} /><strong>{uiText("这里将保存你的创作")}</strong><p>{uiText("新建画布后，把图片拖进来，输入你想修改的地方，就可以开始。")}</p><button className="wb-primary-link" onClick={createAndEnter}><Plus size={16} />{uiText("创建第一个画布")}</button></div>}
                    <Popover content={<p className="max-w-72 text-sm leading-6">{uiText("保存位置和同步状态以画布顶部提示为准。重要项目请及时导出备份，再换电脑或清理浏览器。")}</p>} trigger="click"><button type="button" className="home-local-note inline-flex items-center gap-2"><Info size={14} />{uiText("保存与同步说明")}</button></Popover>
                </section> : null}
                <HomeResources />
                {flags.prompts ? <Link to="/prompts" className="home-help"><BookOpen size={20} /><div><strong>{uiText("还不知道怎么描述想法？")}</strong><span>{uiText("打开提示词库，挑一个模板开始。")}</span></div><ArrowRight size={18} /></Link> : null}
            </div>
        </main>
    );
}
