import { useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Button, Drawer } from "antd";
import { ArrowRight, BookOpen, Check, ChevronDown, Copy, Download, X } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { designExampleForLocation, type DesignExample } from "@/lib/design-examples";

/** Static teaching content only: no form setters, history writes, imports, or generation requests. */
export function DesignExampleArticle({ example }: { example: DesignExample }) {
    const copyText = useCopyText();
    return <article data-testid="design-example-article" data-example-id={example.id} className="min-w-0 text-foreground [overflow-wrap:anywhere]" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }}>
        <header className="mb-5">
            <p className="mb-2 text-xs tracking-wide text-muted-foreground">操作案例 / {example.category}</p>
            <h2 className="text-xl font-semibold leading-snug tracking-tight md:text-2xl">{example.title}</h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{example.brief}</p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">图示为独立教学素材，不是你的生成记录。查看、复制或下载不会提交任务。</p>
        </header>
        <div className={`mb-7 grid min-w-0 gap-4 ${example.media.length === 1 ? "grid-cols-1" : example.media.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3"}`}>
            {example.media.map(media => <figure key={media.src} className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                <img src={media.src} alt={media.alt} loading="lazy" decoding="async" width={1536} height={1024} className="aspect-[3/2] w-full object-contain" />
                <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 text-xs">
                    <span className="font-medium">{media.label}</span>
                    <a href={media.src} download={media.src.split("/").at(-1)} className="inline-flex items-center gap-1.5 rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label={`下载${media.label}`}><Download size={13} />下载教学素材</a>
                </figcaption>
            </figure>)}
        </div>
        <section aria-label="准备与操作" className="mb-7">
            <h3 className="mb-4 text-sm font-semibold">准备、操作与得到的结果</h3>
            <ol className="space-y-5">
                {example.steps.map((step, index) => <li key={`${index}:${step.title}`} className="flex gap-3">
                    <span aria-hidden="true" className="mt-0.5 w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                    <div className="min-w-0"><h4 className="text-sm font-medium">{step.title}</h4><p className="mt-1 text-sm leading-7 text-muted-foreground">{step.detail}</p></div>
                </li>)}
            </ol>
        </section>
        {example.prompt ? <section aria-label="示例要求" className="mb-7 rounded-lg border border-border px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">可复用的设计要求</h3><Button size="small" icon={<Copy size={13} />} onClick={() => void copyText(example.prompt!, "示例要求已复制；请检查后手动粘贴")}>复制示例要求</Button></div>
            <details className="mt-3"><summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground">查看完整文字<ChevronDown size={13} /></summary><pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-7">{example.prompt}</pre></details>
        </section> : null}
        <section aria-label="核对要点" className="mb-7 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-semibold">得到结果后，先核对这些</h3>
            <ul className="space-y-2.5">{example.checks.map((check, index) => <li key={index} className="flex gap-2 text-sm leading-6 text-muted-foreground"><Check size={15} className="mt-1 shrink-0" /><span>{check}</span></li>)}</ul>
        </section>
        <footer className="space-y-3 rounded-lg bg-muted/50 p-4 text-xs leading-6 text-muted-foreground">
            <p><strong className="font-medium text-foreground">费用与执行：</strong>{example.cost}</p>
            <p><strong className="font-medium text-foreground">使用边界：</strong>{example.limitation}</p>
        </footer>
    </article>;
}

/** Sits inside the existing authorization/module gates; never opens itself. */
export function FeatureExamples({ children }: { children: ReactNode }) {
    const location = useLocation();
    const example = designExampleForLocation(location.pathname, location.search);
    const [collapsedId, setCollapsedId] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    if (!example) return <>{children}</>;
    const collapsed = collapsedId === example.id;
    return <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
        <section data-testid="feature-example" data-example-id={example.id} aria-label="本板块操作案例" className="shrink-0 border-b border-border px-4 py-2.5 md:px-6">
            {collapsed ? <button type="button" onClick={() => setCollapsedId(null)} className="inline-flex max-w-full items-center gap-2 rounded py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><BookOpen size={14} className="shrink-0" /><span className="truncate">展开操作案例 · {example.title}</span><ChevronDown size={13} className="shrink-0" /></button> : <div className="flex items-start gap-3 md:gap-4">
                <div className="flex shrink-0 gap-2 pt-0.5" aria-hidden="true">{example.media.slice(0, 2).map((media, index) => <figure key={media.src} className={`${index ? "hidden lg:block" : "block"} w-20 md:w-28`}><img src={media.src} alt="" width={1536} height={1024} decoding="async" className="aspect-[3/2] w-full rounded-md border border-border object-contain" /><figcaption className="mt-1 truncate text-[10px] leading-4 text-muted-foreground">{media.label}</figcaption></figure>)}</div>
                <div className="min-w-0 flex-1">
                    <p className="mb-1 text-[11px] text-muted-foreground">图文操作案例 · {example.category}</p>
                    <h2 className="line-clamp-2 text-sm font-medium leading-5">{example.title}</h2>
                    <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">{example.steps.slice(0, 3).map(step => step.title).join(" → ")}</p>
                    <button type="button" onClick={() => setOpenId(example.id)} className="mt-1 inline-flex items-center gap-1 rounded py-1 text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">查看操作案例<ArrowRight size={13} /></button>
                </div>
                <button type="button" onClick={() => setCollapsedId(example.id)} aria-label="收起操作案例" title="收起操作案例" className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><X size={15} /></button>
            </div>}
        </section>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        <Drawer title="图文操作案例" open={openId === example.id} onClose={() => setOpenId(null)} size="min(820px, 100vw)" mask={false} autoFocus={false} focusable={{ trap: false }} destroyOnHidden styles={{ body: { padding: 20 } }}>
            <DesignExampleArticle example={example} />
        </Drawer>
    </div>;
}
