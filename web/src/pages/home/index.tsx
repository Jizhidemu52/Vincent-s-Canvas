import { Plus } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { cn } from "@/lib/utils";

type FilterItem = {
    label: string;
    active?: boolean;
};

const filters: FilterItem[] = [
    { label: "我的项目", active: true },
    { label: "我分享的" },
    { label: "分享给我" },
    { label: "精选项目" },
];

const placeholderProjects = Array.from({ length: 17 }, (_, index) => ({
    id: `placeholder-${index + 1}`,
    title: index === 0 ? "Create new project" : "Untitled",
    age: index === 1 || index === 2 ? "modified 2 hours ago" : index < 5 ? "modified 1 day ago" : "modified 2 days ago",
    tone: index % 5,
}));

function formatProjectTime(value: string) {
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return "modified just now";
    const diff = Date.now() - time;
    const minutes = Math.max(1, Math.floor(diff / 60_000));
    if (minutes < 60) return `modified ${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `modified ${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `modified ${days} days ago`;
}

function ProjectPreview({ project, tone = 0, isCreate = false }: { project?: CanvasProject; tone?: number; isCreate?: boolean }) {
    if (isCreate) {
        return (
            <div className="flex h-full items-center justify-center bg-white">
                <Plus className="size-12 stroke-[1.5] text-stone-300" />
            </div>
        );
    }

    const hasNodes = Boolean(project?.nodes.length);

    return (
        <div className="relative h-full overflow-hidden bg-[#f7f7f5]">
            {hasNodes ? (
                <>
                    <div className="absolute left-[12%] top-[18%] h-12 w-16 rounded-sm bg-orange-100 ring-1 ring-orange-200" />
                    <div className="absolute left-[40%] top-[28%] h-28 w-36 rounded-sm bg-cyan-100 ring-1 ring-cyan-200" />
                    <div className="absolute right-[14%] bottom-[18%] h-16 w-24 rounded-sm bg-stone-200 ring-1 ring-stone-300" />
                    <div className="absolute inset-x-8 bottom-8 border-t border-dashed border-stone-300" />
                </>
            ) : tone === 0 ? (
                <div className="flex h-full items-center justify-center text-xl font-semibold text-stone-200">No images</div>
            ) : tone === 1 ? (
                <>
                    <div className="absolute left-[46%] top-0 h-10 w-20 rounded-b-full bg-stone-200" />
                    <div className="absolute left-[46%] top-[23%] h-[58%] w-20 bg-cyan-100" />
                </>
            ) : tone === 2 ? (
                <div className="absolute left-6 top-5 h-[88%] w-32 bg-cyan-100" />
            ) : tone === 3 ? (
                <>
                    <div className="absolute left-0 top-12 h-20 w-28 rounded-r-md bg-[linear-gradient(135deg,#f97316,#fecaca,#84cc16)]" />
                    <div className="absolute right-0 top-16 h-28 w-[64%] bg-cyan-100" />
                </>
            ) : (
                <div className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-6 gap-1">
                    {Array.from({ length: 24 }, (_, index) => (
                        <span key={index} className="size-2 rounded-full bg-stone-300" style={{ opacity: 0.35 + (index % 4) * 0.12 }} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ProjectCard({ project, placeholder, onOpen, onCreate }: { project?: CanvasProject; placeholder?: (typeof placeholderProjects)[number]; onOpen?: () => void; onCreate?: () => void }) {
    const isCreate = placeholder?.id === "placeholder-1";
    const title = project?.title || placeholder?.title || "Untitled";
    const meta = project ? formatProjectTime(project.updatedAt) : placeholder?.age || "modified just now";

    return (
        <article className="group">
            <button type="button" onClick={isCreate ? onCreate : onOpen} className="block w-full overflow-hidden rounded-md border border-stone-200 bg-white text-left transition hover:border-stone-300 hover:shadow-[0_18px_38px_rgba(0,0,0,0.08)]">
                <div className="aspect-[16/9]">
                    <ProjectPreview project={project} tone={placeholder?.tone} isCreate={isCreate} />
                </div>
            </button>
            <div className="mt-2">
                <h2 className="truncate text-[13px] font-bold !text-stone-950">{title}</h2>
                <p className="mt-0.5 text-[12px] font-medium !text-stone-500">{meta}</p>
            </div>
        </article>
    );
}

export default function IndexPage() {
    const navigate = useNavigate();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);

    const visibleProjectItems = useMemo(() => {
        return projects.map((project, index) => ({ project, placeholder: { ...placeholderProjects[(index % (placeholderProjects.length - 1)) + 1], id: project.id } }));
    }, [projects]);

    const createAndEnter = () => {
        const id = createProject(`无线画布 ${projects.length + 1}`);
        navigate(`/canvas/${id}`);
    };

    return (
        <main className="h-full overflow-y-auto bg-[#eeeeec] text-stone-950">
            <section className="mx-auto w-full max-w-[1820px] px-4 py-3 md:px-5">
                <div className="relative min-h-[188px] overflow-hidden rounded-lg bg-[#ff5a1f] text-white">
                    <div className="relative z-10 flex min-h-[188px] max-w-[760px] flex-col justify-center px-5 py-6">
                        <span className="mb-3 w-fit rounded-sm bg-black px-2 py-0.5 text-[12px] font-black uppercase leading-5 text-white">New</span>
                        <h1 className="max-w-[700px] text-4xl font-black leading-[0.95] tracking-normal md:text-5xl">无线画布工作台</h1>
                        <p className="mt-3 max-w-[620px] text-[14px] font-semibold leading-6 text-white/90">项目、素材、模型和出图任务集中在一个入口，设计师从这里开始创作，管理员从这里追踪成本。</p>
                        <button type="button" onClick={createAndEnter} className="mt-4 h-10 w-fit rounded-md bg-white px-5 text-[13px] font-black !text-stone-950 transition hover:bg-stone-100">
                            新建项目
                        </button>
                    </div>
                    <div className="absolute bottom-0 right-0 top-0 hidden w-[36%] overflow-hidden md:block">
                        <img
                            src="https://images.unsplash.com/photo-1544005313-94ddf0286df2?q=80&w=1200&auto=format&fit=crop"
                            alt=""
                            className="h-full w-full object-cover"
                            referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-[#ff5a1f] to-transparent" />
                        <div className="absolute bottom-4 right-5 text-5xl font-black text-white drop-shadow">V1</div>
                    </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-2">
                    {filters.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            className={cn(
                                "h-8 rounded-md px-3 text-[12px] font-bold transition",
                                item.active ? "bg-white !text-stone-950 shadow-sm" : "bg-transparent !text-stone-500 hover:bg-white hover:!text-stone-950",
                            )}
                        >
                            {item.label}
                            {item.label === "精选项目" ? <span className="ml-1 rounded-sm bg-orange-500 px-1 text-[9px] uppercase text-white">New</span> : null}
                        </button>
                    ))}
                    <button type="button" className="h-8 rounded-md bg-stone-200 px-3 text-[12px] font-bold !text-stone-500 transition hover:bg-white hover:!text-stone-950">
                        最近打开
                    </button>
                </div>

                <div className="mt-5 grid gap-x-2.5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
                    {!hydrated ? (
                        Array.from({ length: 12 }, (_, index) => (
                            <div key={index} className="space-y-2">
                                <div className="aspect-[16/9] animate-pulse rounded-md bg-white" />
                                <div className="h-3 w-24 animate-pulse rounded bg-stone-200" />
                            </div>
                        ))
                    ) : projects.length ? (
                        <>
                            <ProjectCard placeholder={placeholderProjects[0]} onCreate={createAndEnter} />
                            {visibleProjectItems.map(({ project, placeholder }) => (
                                <ProjectCard key={project.id} project={project} placeholder={placeholder} onOpen={() => navigate(`/canvas/${project.id}`)} />
                            ))}
                        </>
                    ) : (
                        placeholderProjects.map((placeholder) => <ProjectCard key={placeholder.id} placeholder={placeholder} onCreate={createAndEnter} onOpen={createAndEnter} />)
                    )}
                </div>

                <div className="h-12" />
            </section>
        </main>
    );
}
