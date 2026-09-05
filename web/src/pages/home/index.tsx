import { ArrowRight, BookOpen, ImagePlus, Images, LayoutGrid, MessageSquareText, Plus, Video } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useModuleStore } from "@/stores/use-module-store";
import "./home.css";

const entries = [
    { path: "/image", flag: "image" as const, icon: ImagePlus, title: "图像创作", description: "描述一个想法，把它变成图片", action: "开始生图" },
    { path: "/video", flag: "video" as const, icon: Video, title: "视频创作", description: "从文字或图片，生成一段视频", action: "制作视频" },
    { path: "/chat", flag: "gpt-chat" as const, icon: MessageSquareText, title: "AI 对话", description: "整理思路、完善文案和提示词", action: "开始对话" },
    { path: "/assets", flag: "assets" as const, icon: Images, title: "我的素材", description: "收藏作品，随时带回创作", action: "管理素材" },
];

export default function IndexPage() {
    const navigate = useNavigate();
    const hydrated = useCanvasStore(state => state.hydrated);
    const projects = useCanvasStore(state => state.projects);
    const createProject = useCanvasStore(state => state.createProject);
    const flags = useModuleStore(state => state.flags);
    const recent = useMemo(() => [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 8), [projects]);
    const createAndEnter = () => navigate("/canvas/" + createProject("无线画布 " + (projects.length + 1)));
    return (
        <main className="wb-page home-page h-full overflow-y-auto">
            <div className="home-content">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">VINCENT'S CANVAS / 创作工作台</p><h1 className="wb-title">让想法，开始成形。</h1><p className="wb-description">选一个工具开始，或回到上次的画布继续创作。</p></div>
                    {flags.canvas ? <button type="button" className="wb-primary-link" disabled={!hydrated} onClick={createAndEnter}><Plus size={18} />新建画布</button> : null}
                </header>
                <section className="home-tools" aria-label="选择创作工具">
                    {entries.filter(entry => flags[entry.flag]).map(({ path, icon: Icon, title, description, action }, index) => <Link to={path} className="wb-surface home-tool" key={path}>
                        <div className="home-tool-top"><Icon size={24} strokeWidth={1.4} /><span>0{index + 1}</span></div>
                        <h2>{title}</h2><p>{description}</p><span className="home-tool-action">{action}<ArrowRight size={16} /></span>
                    </Link>)}
                </section>
                {flags.canvas ? <section className="home-projects">
                    <div className="wb-header"><div><p className="wb-eyebrow">继续创作</p><h2 className="wb-title">最近的画布</h2></div><Link to="/canvas" className="home-all-link">查看全部 {projects.length ? "(" + projects.length + ")" : ""}<ArrowRight size={16} /></Link></div>
                    {!hydrated ? <div className="wb-grid" role="status" aria-label="正在读取画布">{Array.from({ length: 4 }, (_, index) => <div className="home-skeleton animate-pulse" key={index} />)}</div> : recent.length ? <div className="home-project-grid">
                        {recent.map(project => {
                            const preview = project.nodes.find(node => node.type === "image" && (node.metadata?.storageKey || node.metadata?.content));
                            return <Link to={"/canvas/" + project.id} className="wb-surface home-project" key={project.id}>
                                <div className="home-project-preview">{preview ? <CanvasPersistedMediaPreview kind="image" url={preview.metadata?.content} storageKey={preview.metadata?.storageKey} alt={project.title} className="h-full w-full object-cover" /> : <LayoutGrid size={32} strokeWidth={1} />}</div>
                                <div className="home-project-info"><h3>{project.title || "未命名画布"}</h3><p>{project.nodes.length} 个内容 · {new Date(project.updatedAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} 更新</p></div>
                            </Link>;
                        })}
                    </div> : <div className="wb-surface wb-empty"><LayoutGrid size={36} strokeWidth={1.2} /><strong>这里将保存你的创作</strong><p>新建画布后，把图片拖进来，输入你想修改的地方，就可以开始。</p><button className="wb-primary-link" onClick={createAndEnter}><Plus size={16} />创建第一个画布</button></div>}
                    <p className="home-local-note">画布自动保存在当前浏览器。重要项目请在画布中导出备份，再换电脑或清理浏览器。</p>
                </section> : null}
                {flags.prompts ? <Link to="/prompts" className="home-help"><BookOpen size={20} /><div><strong>还不知道怎么描述想法？</strong><span>打开提示词库，挑一个模板开始。</span></div><ArrowRight size={18} /></Link> : null}
            </div>
        </main>
    );
}
