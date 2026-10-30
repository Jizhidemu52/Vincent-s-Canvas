import { uiText, useUiText, getUiLocale } from "@/lib/i18n";
import { ArrowRight, BookOpen, ImagePlus, Images, LayoutGrid, MessageSquareText, Plus, Video } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { nextProjectTitle } from "@/lib/project-title";
import { navigationTools, navigationModuleKey } from "@/constant/navigation-tools";
import { HomeResources } from "./home-resources";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import type { ModuleKey } from "@/services/api/modules";
import "./home.css";

const entries = [
    { path: "/image", flag: "image" as const, icon: ImagePlus, title: "图像生成", description: "描述一个想法，把它变成图片", action: "开始生图" },
    { path: "/video", flag: "video" as const, icon: Video, title: "视频生成", description: "从文字或图片，生成一段视频", action: "制作视频" },
    { path: "/chat", flag: "gpt-chat" as const, icon: MessageSquareText, title: "对话改图", description: "发送图片，接着聊、接着改", action: "开始对话" },
    { path: "/assets", flag: "assets" as const, icon: Images, title: "素材库", description: "收藏作品，随时带回创作", action: "管理素材" },
];

export default function IndexPage() {
    useUiText();
    const navigate = useNavigate();
    const hydrated = useCanvasStore(state => state.hydrated);
    const projects = useCanvasStore(state => state.projects);
    const createProject = useCanvasStore(state => state.createProject);
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const canvasAvailable = isModuleAvailable(flags, tools, "canvas");
    const recent = useMemo(() => [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 8), [projects]);
    const createAndEnter = () => {
        const current = useCanvasStore.getState();
        if (!current.hydrated || !isModuleAvailable(flags, tools, "canvas")) return;
        navigate("/canvas/" + createProject(nextProjectTitle(canvasLibrarySummaries(current.projects, current.unloadedProjects))));
    };
    return (
        <main className="wb-page home-page h-full overflow-y-auto">
            <div className="home-content">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">{uiText("VINCENT'S CANVAS / 创作工作台")}</p><h1 className="wb-title">{uiText("让想法，开始成形。")}</h1><p className="wb-description">{uiText("选一个工具开始，或回到上次的画布继续创作。")}</p></div>
                    {canvasAvailable ? <button type="button" className="wb-primary-link" disabled={!hydrated} onClick={createAndEnter}><Plus size={18} />{uiText("新建画布")}</button> : null}
                </header>
                <section className="home-tools" aria-label={uiText("选择创作工具")}>
                    {entries.filter(entry => isModuleAvailable(flags, tools, entry.flag)).map(({ path, icon: Icon, title, description, action }, index) => <Link to={path} className="wb-surface home-tool" key={path}>
                        <div className="home-tool-top"><Icon size={24} strokeWidth={1.4} /><span>0{index + 1}</span></div>
                        <h2>{uiText(title || "")}</h2><p>{uiText(description || "")}</p><span className="home-tool-action">{uiText(action || "")}<ArrowRight size={16} /></span>
                    </Link>)}
                </section>
                <section className="my-8" aria-label={uiText("全部工具")}><h2 className="mb-4 text-lg font-semibold">{uiText("全部工具")}</h2><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{navigationTools.filter(tool => tool.group !== "admin" && isModuleAvailable(flags, tools, navigationModuleKey(tool.slug) as ModuleKey)).map(tool => <Link key={tool.slug} to={tool.path} className="wb-surface flex items-center gap-2 px-4 py-3 text-sm"><tool.icon className="size-4 shrink-0" />{uiText(tool.label)}</Link>)}</div></section>
                {canvasAvailable ? <section className="home-projects">
                    <div className="wb-header"><div><p className="wb-eyebrow">{uiText("继续创作")}</p><h2 className="wb-title">{uiText("最近的画布")}</h2></div><Link to="/canvas" className="home-all-link">{uiText("查看全部 ")}{projects.length ? "(" + projects.length + ")" : ""}<ArrowRight size={16} /></Link></div>
                    {!hydrated ? <div className="wb-grid" role="status" aria-label={uiText("正在读取画布")}>{Array.from({ length: 4 }, (_, index) => <div className="home-skeleton animate-pulse" key={index} />)}</div> : recent.length ? <div className="home-project-grid">
                        {recent.map(project => {
                            const preview = project.nodes.find(node => node.type === "image" && (node.metadata?.storageKey || node.metadata?.content));
                            return <Link to={"/canvas/" + project.id} className="wb-surface home-project" key={project.id}>
                                <div className="home-project-preview">{preview ? <CanvasPersistedMediaPreview kind="image" url={preview.metadata?.content} storageKey={preview.metadata?.storageKey} alt={project.title} className="h-full w-full object-cover" /> : <LayoutGrid size={32} strokeWidth={1} />}</div>
                                <div className="home-project-info"><h3>{project.title || uiText("未命名画布")}</h3><p>{project.nodes.length} {uiText(" 个内容 · ")}{new Date(project.updatedAt).toLocaleDateString(getUiLocale(), { month: "long", day: "numeric" })} {uiText(" 更新")}</p></div>
                            </Link>;
                        })}
                    </div> : <div className="wb-surface wb-empty"><LayoutGrid size={36} strokeWidth={1.2} /><strong>{uiText("这里将保存你的创作")}</strong><p>{uiText("新建画布后，把图片拖进来，输入你想修改的地方，就可以开始。")}</p><button className="wb-primary-link" onClick={createAndEnter}><Plus size={16} />{uiText("创建第一个画布")}</button></div>}
                    <p className="home-local-note">{uiText("保存位置和同步状态以画布顶部提示为准。重要项目请及时导出备份，再换电脑或清理浏览器。")}</p>
                </section> : null}
                <HomeResources />
                {flags.prompts ? <Link to="/prompts" className="home-help"><BookOpen size={20} /><div><strong>{uiText("还不知道怎么描述想法？")}</strong><span>{uiText("打开提示词库，挑一个模板开始。")}</span></div><ArrowRight size={18} /></Link> : null}
            </div>
        </main>
    );
}
