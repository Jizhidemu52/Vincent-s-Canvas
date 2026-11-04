import { useId, useState, type KeyboardEvent } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "antd";
import { BookOpen, ChevronDown, Copy, Download } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy-text";
import { designExampleForLocation, type DesignExample } from "@/lib/design-examples";

function stopExampleSubmit(event: KeyboardEvent<HTMLElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
    }
}

/** Static teaching content only: no form setters, history writes, imports, or generation requests. */
export function DesignExampleArticle({ example }: { example: DesignExample }) {
    const copyText = useCopyText();
    return <article data-testid="design-example-article" data-example-id={example.id} className="min-w-0 text-foreground [overflow-wrap:anywhere]" onKeyDown={stopExampleSubmit}>
        <header className="mb-4 space-y-1">
            <h3 className="text-sm font-semibold">{example.title}</h3>
            <p className="text-sm leading-6 text-muted-foreground">{example.purpose}</p>
            <p className="text-xs leading-5 text-muted-foreground">入口：{example.location}</p>
        </header>
        <div className="mb-5 grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
            {example.media.map(media => <figure key={media.src} className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                {media.kind === "video" ? <video src={media.src} poster={media.poster} aria-label={media.alt} controls playsInline preload="metadata" onLoadedMetadata={event => {
                    event.currentTarget.defaultPlaybackRate = 1;
                    event.currentTarget.playbackRate = 1;
                }} className="aspect-[3/4] max-h-[65vh] w-full object-contain">
                    当前浏览器无法播放此视频，可下载后查看。
                </video> : <img src={media.src} alt={media.alt} loading="lazy" decoding="async" width={1536} height={1024} className="aspect-[3/2] w-full object-contain" />}
                <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 text-xs">
                    <span className="font-medium">{media.label}</span>
                    <a href={media.kind === "video" ? media.downloadSrc ?? media.src : media.src} download={(media.kind === "video" ? media.downloadSrc ?? media.src : media.src).split("/").at(-1)} className="inline-flex items-center gap-1.5 rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label={`下载${media.label}`}><Download size={13} />{media.kind === "video" ? "下载原视频" : "下载教学素材"}</a>
                </figcaption>
            </figure>)}
        </div>
        <dl aria-label="输入、操作与结果" className="space-y-3 text-sm leading-6">
            {example.steps.map(step => <div key={step.title} className="flex gap-4">
                <dt className="shrink-0 font-medium">{step.title}</dt>
                <dd className="min-w-0 text-muted-foreground">{step.detail}</dd>
            </div>)}
        </dl>
        {example.prompt ? <section aria-label="示例要求" className="mt-4 border-t border-border pt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-medium">本次要求</h4><Button size="small" icon={<Copy size={13} />} onClick={() => void copyText(example.prompt!, "示例要求已复制")}>复制示例要求</Button></div>
            <p className="text-sm leading-6 text-muted-foreground">{example.prompt}</p>
        </section> : null}
    </article>;
}

/** A fixed example record beside real history, never part of its data or totals. */
export function PracticeExampleRecord({ example: suppliedExample }: { example?: DesignExample } = {}) {
    const location = useLocation();
    const example = suppliedExample ?? designExampleForLocation(location.pathname, location.search);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const contentId = useId();
    if (!example) return null;
    const expanded = expandedId === example.id;
    const input = example.media.find(media => media.label.startsWith("输入"));
    const result = example.media.find(media => media.label.startsWith("结果"));
    const previews = [input, result].filter((media): media is DesignExample["media"][number] => Boolean(media));
    if (!previews.length && example.media[0]) previews.push(example.media[0]);
    return <section data-testid="practice-example-record" data-example-id={example.id} aria-label={`${example.title}实操案例`} className="min-w-0 overflow-hidden rounded-lg border border-border bg-card text-foreground" onKeyDown={stopExampleSubmit}>
        <button type="button" data-testid="practice-example-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpandedId(expanded ? null : example.id)} className="flex w-full min-w-0 flex-col items-stretch gap-2.5 p-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
            <span className="flex min-w-0 items-start gap-2"><span className="min-w-0 flex-1">
                <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><BookOpen size={13} aria-hidden="true" />实操案例</span>
                <span className="block text-sm font-medium leading-5">{example.title}</span>
            </span><ChevronDown size={15} aria-hidden="true" className={`mt-0.5 shrink-0 text-muted-foreground ${expanded ? "rotate-180" : ""}`} /></span>
            <span className="grid w-full max-w-40 grid-cols-2 gap-2">{previews.map(media => <span key={media.src} className="block min-w-0">
                <img src={media.kind === "video" ? media.poster : media.src} alt={media.alt} loading="lazy" decoding="async" width={96} height={64} className="aspect-[3/2] w-full rounded border border-border object-contain" />
                <span className="mt-1 block truncate text-[10px] leading-4 text-muted-foreground">{media.label}</span>
            </span>)}</span>
        </button>
        <div id={contentId} hidden={!expanded} className="border-t border-border p-3 sm:p-4">{expanded ? <DesignExampleArticle example={example} /> : null}</div>
    </section>;
}
