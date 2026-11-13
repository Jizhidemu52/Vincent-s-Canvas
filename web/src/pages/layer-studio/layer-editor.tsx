import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Select, Tooltip } from "antd";
import type { LayerStudioItem, LayerStudioResultDocument } from "../../../../shared/layer-studio";
import { workspaceOwnerHeaders } from "@/services/api/workspace-owner";
import { useUserStore } from "@/stores/use-user-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUiLocale, useUiText } from "@/lib/i18n";
import { layerStudioUiMessage } from "./page-copy";
import { DisplayText, useDisplayText } from "@/hooks/use-display-text";
import {
    createLayerStudioEditDocument, hitLayerStudioItem, initialLayerStudioRect, layerStudioBoxRect,
    layerStudioGroups, layerStudioPngBlob, layerStudioPoint, moveLayerStudioOrder, orderedLayerStudioItems,
    renderLayerStudioComposition, scaleLayerStudioEdit, updateLayerStudioEdit, validLayerStudioSize,
    type LayerStudioEditDocument, type LayerStudioLayerEdit, type LayerStudioSize,
} from "./layer-composition";
import { createLayerStudioMedia, layerStudioFileName } from "./layer-editor-media";
import "./layer-editor.css";

export type { LayerStudioEditDocument } from "./layer-composition";
export type LayerStudioEditorProps = {
    document: LayerStudioResultDocument;
    value?: LayerStudioEditDocument;
    onChange: (next: LayerStudioEditDocument) => void;
    onRefresh?: () => Promise<void>;
    onResume?: () => Promise<void>;
    recovering?: boolean;
};

function currentOwner() {
    const { user, status } = useUserStore.getState();
    return `${status}:${user?.id || "anonymous"}:${user?.status || ""}`;
}
function label(item: LayerStudioItem | undefined, t: ReturnType<typeof useUiText>, display: ReturnType<typeof useDisplayText>) {
    if (!item) return t("未就绪图层");
    return item.name ? display(item.name) : item.role === "base" ? t("底图") : item.role === "image" ? t("生成图片") : t("图层 {index}", { index: item.urlIndex });
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "操作失败，当前编辑与原件已保留"; }

/** A changed employee must remount with that employee's own task, never reuse this result. */
export function LayerStudioEditor(props: LayerStudioEditorProps) {
    const t = useUiText();
    const [owner] = useState(currentOwner);
    const session = useUserStore(state => `${state.status}:${state.user?.id || "anonymous"}:${state.user?.status || ""}`);
    const theme = useThemeStore(state => state.theme);
    const allowed = !deploymentFeatures.authenticationEnabled || useUserStore.getState().status === "authenticated";
    if (session !== owner || !allowed) return <div className="layer-editor layer-editor-session" data-theme={theme} role="status">{t("员工会话已变化。请重新打开当前员工的任务，原编辑不会覆盖其他员工的数据。")}</div>;
    return <SessionEditor key={props.document.taskId} {...props} owner={owner} theme={theme} />;
}

function NumericField({ title, value, minimum, onCommit }: { title: string; value: number; minimum?: number; onCommit: (next: number) => void }) {
    const [text, setText] = useState(String(Number(value.toFixed(2))));
    useEffect(() => setText(String(Number(value.toFixed(2)))), [value]);
    const save = () => {
        const parsed = Number(text);
        if (text.trim() && Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000 && (minimum === undefined || parsed >= minimum)) onCommit(parsed);
        else setText(String(Number(value.toFixed(2))));
    };
    return <label className="layer-editor-number"><span>{title}</span><input type="number" aria-label={title} value={text} min={minimum} step="any"
        onChange={event => setText(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>px</small></label>;
}

function OcrDetails({ item }: { item: LayerStudioItem }) {
    const t = useUiText();
    const recognition = item.textRecognition;
    if (!recognition) return <p className="layer-editor-muted">{t("未返回文字识别信息；不代表此图层没有文字。")}</p>;
    return <details className="layer-editor-ocr"><summary>{t("文字识别与样式（模型参考值）")}</summary>
        {recognition.text !== undefined && <pre>{recognition.text ? <DisplayText text={recognition.text} /> : t("（返回文本为空）")}</pre>}
        {recognition.lines?.map((line, lineIndex) => <div key={`line-${lineIndex}`} className="layer-editor-ocr-line">
            <small>{t("文字行 {index}", { index: lineIndex + 1 })}</small>
            {line.runs?.map((run, runIndex) => <div key={`run-${runIndex}`}>
                {run.text !== undefined && <pre><DisplayText text={run.text} /></pre>}
                {run.style && <dl>{Object.entries(run.style).map(([key, value]) => <div key={key}><dt>{({ similarFontFamily: t("相近字体"), foregroundColor: t("文字颜色"), bold: t("粗体"), italic: t("斜体"), underline: t("下划线"), strikethrough: t("删除线"), shadow: t("阴影"), translucent: t("半透明") } as Record<string, string>)[key] || key}</dt><dd>{typeof value === "boolean" ? value ? t("是") : t("否") : typeof value === "string" ? <DisplayText text={value} /> : value}</dd></div>)}</dl>}
            </div>)}
            {line.boundingBox && <small>{t("识别框 ")}{line.boundingBox.absolute ? t("像素 {coordinates}", { coordinates: line.boundingBox.absolute.join(", ") }) : line.boundingBox.normalized ? t("归一化 {coordinates}", { coordinates: line.boundingBox.normalized.join(", ") }) : t("未返回")}</small>}
        </div>)}
        {recognition.text === undefined && !recognition.lines?.length && <p>{t("上游返回了空识别结构，未补造文本或字体。")}</p>}
    </details>;
}

function SessionEditor({ document: result, value, onChange, onRefresh, onResume, recovering, owner, theme }: LayerStudioEditorProps & { owner: string; theme: string }) {
    const t = useUiText();
    const display = useDisplayText();
    const locale = useUiLocale();
    const [local, setLocal] = useState(() => createLayerStudioEditDocument(result, value));
    const [dimensions, setDimensions] = useState<Map<number, LayerStudioSize>>(new Map());
    const [media, setMedia] = useState<ReturnType<typeof createLayerStudioMedia> | null>(null);
    const [groupIndex, setGroupIndex] = useState(() => result.items.find(item => item.index === value?.selectedIndex)?.groupIndex ?? result.items[0]?.groupIndex ?? 0);
    const [failure, setFailure] = useState("");
    const [notice, setNotice] = useState("");
    const [renderIssues, setRenderIssues] = useState<Array<{ index: number; message: string }>>([]);
    const [rendering, setRendering] = useState(false);
    const [busy, setBusy] = useState(false);
    const [lockAspect, setLockAspect] = useState(true);
    const [reload, setReload] = useState(0);
    const [scalePercent, setScalePercent] = useState("100");
    const visibleCanvas = useRef<HTMLCanvasElement>(null);
    const stage = useRef<HTMLDivElement>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const edit = useMemo(() => createLayerStudioEditDocument(result, local, dimensions), [result, local, dimensions]);
    const editRef = useRef(edit); editRef.current = edit;
    const groups = useMemo(() => layerStudioGroups(result, dimensions), [result, dimensions]);
    const group = groups.find(candidate => candidate.index === groupIndex) || groups[0];
    const selectedItem = group?.items.find(item => item.index === edit.selectedIndex);
    const selected = edit.layers.find(layer => layer.index === selectedItem?.index);
    const gesture = useRef<{ id: number; kind: "move" | "scale"; x: number; y: number; start: LayerStudioLayerEdit } | null>(null);
    const operation = useRef<AbortController | null>(null);
    const assertOwner = () => { if (currentOwner() !== owner) throw new Error("员工会话已变化，已停止图层操作"); };
    const commit = (next: LayerStudioEditDocument) => {
        assertOwner(); setLocal(next); editRef.current = next; onChangeRef.current(next); setNotice("");
    };
    useEffect(() => {
        const next = createLayerStudioEditDocument(result, value || editRef.current, dimensions);
        setLocal(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (JSON.stringify(value) !== JSON.stringify(next)) onChangeRef.current(next);
    }, [result, value, dimensions]);

    useEffect(() => {
        const sessionMedia = createLayerStudioMedia({ assertCurrent: () => { if (currentOwner() !== owner) throw new Error("员工会话已变化，已停止图层读取"); }, headers: workspaceOwnerHeaders });
        setMedia(sessionMedia);
        return () => { operation.current?.abort(); sessionMedia.dispose(); const canvas = visibleCanvas.current; if (canvas) { canvas.width = 1; canvas.height = 1; } };
    }, [owner]);

    useEffect(() => {
        if (!media) return;
        const controller = new AbortController();
        void (async () => {
            for (const item of result.items) {
                if (controller.signal.aborted) return;
                if (item.state !== "saved" || validLayerStudioSize(item) || dimensions.has(item.index)) continue;
                try {
                    const image = await media.readImage(item, controller.signal);
                    const size = { width: image.width, height: image.height }; image.dispose();
                    if (!controller.signal.aborted) setDimensions(previous => new Map(previous).set(item.index, size));
                } catch (error) { if (!controller.signal.aborted) setFailure(errorText(error)); }
            }
        })();
        return () => controller.abort();
        // Decode only unavailable dimensions; known metadata needs no duplicate request.
    }, [result, media, reload]);

    useEffect(() => {
        if (!media || !group?.size) return;
        const controller = new AbortController();
        const scratch = window.document.createElement("canvas");
        setRendering(true);
        void renderLayerStudioComposition(scratch, result, edit, group, media.readImage, {
            signal: controller.signal, allowPartial: true, scale: Math.min(1, 1200 / Math.max(group.size.width, group.size.height)),
        }).then(({ unavailable }) => {
            if (controller.signal.aborted) return;
            media.assertCurrent();
            const canvas = visibleCanvas.current;
            if (canvas) { canvas.width = scratch.width; canvas.height = scratch.height; canvas.getContext("2d")?.drawImage(scratch, 0, 0); }
            setRenderIssues(unavailable);
        }).catch(error => { if (!controller.signal.aborted) setFailure(errorText(error)); })
            .finally(() => { scratch.width = 1; scratch.height = 1; if (!controller.signal.aborted) setRendering(false); });
        return () => controller.abort();
    }, [result, edit, group, media, reload]);

    const patch = (changes: Partial<LayerStudioLayerEdit>) => {
        if (!selected) return;
        try { commit(updateLayerStudioEdit(editRef.current, selected.index, changes)); }
        catch (error) { setFailure(errorText(error)); }
    };
    const select = (item: LayerStudioItem) => { setScalePercent("100"); commit({ ...editRef.current, selectedIndex: item.index }); };
    const begin = (event: ReactPointerEvent<HTMLDivElement>, kind: "move" | "scale") => {
        if (event.button !== 0 || busy || !group?.size || !stage.current) return;
        const point = layerStudioPoint(event, stage.current.getBoundingClientRect(), group.size);
        const item = kind === "scale" ? selectedItem : hitLayerStudioItem(group, editRef.current, point);
        const layer = editRef.current.layers.find(candidate => candidate.index === item?.index);
        if (!item || !layer) return;
        event.preventDefault(); event.stopPropagation(); select(item);
        gesture.current = { id: event.pointerId, kind, ...point, start: { ...layer } };
        stage.current.setPointerCapture(event.pointerId); stage.current.focus();
    };
    const move = (event: ReactPointerEvent<HTMLDivElement>) => {
        const active = gesture.current;
        if (!active || active.id !== event.pointerId || !group?.size || !stage.current) return;
        const point = layerStudioPoint(event, stage.current.getBoundingClientRect(), group.size);
        const dx = point.x - active.x, dy = point.y - active.y;
        let change: Partial<LayerStudioLayerEdit>;
        if (active.kind === "move") change = { x: active.start.x + dx, y: active.start.y + dy };
        else {
            const width = Math.max(1, active.start.width + dx);
            const height = lockAspect ? width / active.start.width * active.start.height : Math.max(1, active.start.height + dy);
            change = { width, height };
        }
        try { const next = updateLayerStudioEdit(editRef.current, active.start.index, change); setLocal(next); editRef.current = next; }
        catch (error) { setFailure(errorText(error)); }
    };
    const end = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (gesture.current?.id !== event.pointerId) return;
        gesture.current = null;
        if (stage.current?.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId);
        commit(editRef.current);
    };
    const reset = () => {
        if (!group) return;
        const defaults = createLayerStudioEditDocument(result, undefined, dimensions);
        const indices = new Set(group.items.map(item => item.index));
        commit({ ...edit, layers: [...edit.layers.filter(layer => !indices.has(layer.index)), ...defaults.layers.filter(layer => indices.has(layer.index))] });
        setScalePercent("100"); setNotice("当前组已恢复初始位置、顺序与显隐；原件未改变。");
    };
    const run = async (action: (sessionMedia: NonNullable<typeof media>, signal: AbortSignal) => Promise<void>) => {
        if (!media || busy) return;
        setBusy(true); setFailure(""); setNotice("");
        const controller = new AbortController(); operation.current = controller;
        try { media.assertCurrent(); await action(media, controller.signal); }
        catch (error) { if (currentOwner() === owner) setFailure(errorText(error)); }
        finally { if (operation.current === controller) operation.current = null; if (currentOwner() === owner) setBusy(false); }
    };
    const exportPng = () => void run(async (sessionMedia, signal) => {
        if (!group) return;
        const canvas = window.document.createElement("canvas");
        try {
            await renderLayerStudioComposition(canvas, result, editRef.current, group, sessionMedia.readImage, { signal });
            const blob = await layerStudioPngBlob(canvas, signal); sessionMedia.assertCurrent();
            sessionMedia.download(blob, `图层合成-${result.taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}-组${group.index + 1}.png`);
            setNotice("PNG 已交给浏览器下载；透明区域已保留，原件未修改。");
        } finally { canvas.width = 1; canvas.height = 1; }
    });
    const downloadOriginal = (item: LayerStudioItem) => void run(async (sessionMedia, signal) => {
        const blob = await sessionMedia.readOriginal(item, signal); sessionMedia.assertCurrent();
        sessionMedia.download(blob, layerStudioFileName(item, blob.type)); setNotice("原始文件已交给浏览器下载，未重新编码。");
    });
    const canExport = Boolean(media && group?.size && result.status === "ready" && result.items.length === result.expectedOutputCount && result.items.every(item => item.state === "saved"));
    const savedCount = result.items.filter(item => item.state === "saved").length;
    const refreshOriginals = () => void run(async () => { await onRefresh?.(); setReload(value => value + 1); });
    const resumeOriginals = () => void run(async () => { await onResume?.(); setReload(value => value + 1); });
    const positionKnown = selectedItem && group?.size && (selectedItem.role !== "layer" || layerStudioBoxRect(selectedItem.boundingBox, group.size));
    return <section className="layer-editor" data-theme={theme} aria-label={t("图层重组编辑器")}>
        <header className="layer-editor-toolbar"><div><h3>{t("图层重组")}</h3><p>{t("已保存 {saved} / {total} 个原件 · 调整不会改动原图", { saved: savedCount, total: result.expectedOutputCount })}</p></div>
            <div className="layer-editor-actions">{groups.length > 1 && <label>{t("结果组 ")}<Select aria-label={t("结果组")} className="min-w-28" value={group?.index} onChange={value => {
                const next = groups.find(candidate => candidate.index === value);
                if (next) { setGroupIndex(next.index); commit({ ...edit, selectedIndex: next.items[0]?.index ?? null }); }
            }} options={groups.map(candidate => ({ value: candidate.index, label: t("第 {index} 组", { index: candidate.index + 1 }) }))} /></label>}
                <button type="button" onClick={reset} disabled={busy || !group?.size}>{t("复位当前组")}</button>
                <button type="button" className="layer-editor-primary" onClick={exportPng} disabled={busy || !canExport}>{busy ? t("处理中…") : t("导出合成 PNG")}</button></div>
        </header>
        {result.status !== "ready" && <div className="layer-editor-warning" role="status">{t("原件仍在保存或部分保存失败。已保存图层可编辑、单独下载；完整合成暂不可导出。请在任务区查询同一原任务，不要重新生成。")}</div>}
        {failure && <div role="alert" className="layer-editor-warning">{layerStudioUiMessage(failure)}</div>}
        {notice && <div role="status" className="layer-editor-notice">{layerStudioUiMessage(notice)}</div>}
        <div className="layer-editor-layout"><div className="layer-editor-workspace">
            <div className="layer-editor-stage-wrap">{group?.size ? <div ref={stage} className="layer-editor-stage" style={{ aspectRatio: `${group.size.width} / ${group.size.height}`, width: `min(100%, ${65 * group.size.width / group.size.height}vh)` }}
                role="application" aria-label={t("图层画布，方向键移动选中图层，Shift 加速")} tabIndex={0}
                onPointerDown={event => begin(event, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
                onKeyDown={event => {
                    if (!selected || busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                    event.preventDefault(); const distance = event.shiftKey ? 10 : 1;
                    patch({ x: selected.x + (event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0), y: selected.y + (event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0) });
                }}><canvas ref={visibleCanvas} aria-label={t("图层合成预览")} />
                {selected?.visible && <div className="layer-editor-selection" data-testid="layer-selection" style={{ left: `${selected.x / group.size.width * 100}%`, top: `${selected.y / group.size.height * 100}%`, width: `${selected.width / group.size.width * 100}%`, height: `${selected.height / group.size.height * 100}%` }}>
                    <span title={locale === "en-US" ? selectedItem?.name : undefined}>{selectedItem && label(selectedItem, t, display)}</span><div className="layer-editor-handle" role="button" aria-label={t("拖动缩放选中图层")} tabIndex={-1} onPointerDown={event => begin(event, "scale")} /></div>}
            </div> : <p className="layer-editor-muted">{t("底图原件或尺寸尚未就绪，未猜测画布尺寸。可查询原任务后继续。")}</p>}</div>
            <footer className="layer-editor-canvas-status"><span>{group?.size ? `${group.size.width} × ${group.size.height} px` : t("等待底图尺寸")}{rendering ? t(" · 预览更新中") : ""}</span><span>{t("拖动移动 · 角点缩放 · 方向键微调")}</span></footer>
            {(renderIssues.length > 0 || savedCount < result.expectedOutputCount) && <div className="layer-editor-warning" aria-label={t("图层原件恢复")}>
                <p>{savedCount < result.expectedOutputCount ? t("已保存 {saved} / {total} 份原件；未保存的图层暂不能显示，重新读取预览不会补存。", { saved: savedCount, total: result.expectedOutputCount }) : t("当前预览有 {count} 个图层未显示。编辑已保留。", { count: renderIssues.length })}</p>
                {renderIssues.length > 0 && <ul>{renderIssues.map(issue => <li key={issue.index}>{label(result.items.find(item => item.index === issue.index), t, display)}{t("：")}{layerStudioUiMessage(issue.message)}</li>)}</ul>}
                <div className="layer-editor-actions">
                    {onResume && <button type="button" className="layer-editor-primary" disabled={busy || recovering} onClick={resumeOriginals}>{t("继续保存缺失图层（不重新生成）")}</button>}
                    {onRefresh && <button type="button" disabled={busy || recovering} onClick={refreshOriginals}>{t("查询原任务并更新图层")}</button>}
                    {renderIssues.some(issue => result.items.find(item => item.index === issue.index)?.state === "saved") && <button type="button" disabled={busy || recovering} onClick={() => { setFailure(""); setReload(value => value + 1); }}>{t("重新读取已保存原件")}</button>}
                </div>
            </div>}
        </div><aside className="layer-editor-sidebar" aria-label={t("图层设置")}><h4>{t("图层 ")}<span>{group?.items.length || 0}</span></h4>
            <div className="layer-editor-list" role="list" aria-label={t("图层列表，最上方在最前景")}>{group && orderedLayerStudioItems(group, edit).reverse().map(item => {
                const layer = edit.layers.find(candidate => candidate.index === item.index);
                return <div className={`layer-editor-row${item.index === selectedItem?.index ? " is-selected" : ""}`} key={item.index} role="listitem">
                    <input type="checkbox" aria-label={t("显示 {name}", { name: label(item, t, display) })} checked={layer?.visible ?? true} disabled={!layer || busy} onChange={event => commit(updateLayerStudioEdit(edit, item.index, { visible: event.target.checked }))} />
                    <button type="button" aria-pressed={item.index === selectedItem?.index} onClick={() => select(item)} className="layer-editor-select"><span title={locale === "en-US" ? item.name : undefined}>{label(item, t, display)}</span><small>{item.state === "saved" ? item.role === "base" ? t("底图原件") : t("已保存") : t("原件待保存")}</small></button>
                    <Tooltip title={item.state !== "saved" ? t("原件保存后即可下载") : t("下载原始文件")}><button type="button" aria-label={t("下载 {name} 原件", { name: label(item, t, display) })} disabled={item.state !== "saved" || busy} onClick={() => downloadOriginal(item)}>↓</button></Tooltip>
                </div>;
            })}</div>
            {selectedItem && <div className="layer-editor-inspector"><h4 title={locale === "en-US" ? selectedItem.name : undefined}>{label(selectedItem, t, display)}</h4>{selectedItem.description && <p className="layer-editor-muted"><DisplayText text={selectedItem.description} /></p>}
                {!positionKnown && <p className="layer-editor-warning">{t("位置未知：以原尺寸居中作为手动起点，非模型返回定位。请自行调整。")}</p>}
                {selected ? <><fieldset disabled={busy}><legend>{t("位置与尺寸")}</legend><div className="layer-editor-fields">
                    <NumericField title={t("X 位置")} value={selected.x} onCommit={x => patch({ x })} /><NumericField title={t("Y 位置")} value={selected.y} onCommit={y => patch({ y })} />
                    <NumericField title={t("图层宽度")} minimum={1} value={selected.width} onCommit={width => patch({ width, ...(lockAspect ? { height: width / selected.width * selected.height } : {}) })} />
                    <NumericField title={t("图层高度")} minimum={1} value={selected.height} onCommit={height => patch({ height, ...(lockAspect ? { width: height / selected.height * selected.width } : {}) })} />
                </div><label className="layer-editor-lock"><input type="checkbox" checked={lockAspect} onChange={event => setLockAspect(event.target.checked)} />{t("锁定宽高比例")}</label>
                    <div className="layer-editor-scale"><label>{t("缩放 ")}<input aria-label={t("缩放百分比")} type="number" min="1" max="10000" value={scalePercent} onChange={event => setScalePercent(event.target.value)} /> %</label><button type="button" onClick={() => {
                        const ratio = Number(scalePercent) / 100;
                        if (Number.isFinite(ratio) && ratio >= 0.01 && ratio <= 100) { patch(scaleLayerStudioEdit(selected, Math.max(1, selected.width * ratio), Math.max(1, selected.height * ratio))); setScalePercent("100"); }
                    }}>{t("应用缩放")}</button></div>
                </fieldset><div className="layer-editor-actions"><button type="button" disabled={busy} onClick={() => group && commit(moveLayerStudioOrder(edit, group, selected.index, 1))}>{t("上移一层")}</button><button type="button" disabled={busy} onClick={() => group && commit(moveLayerStudioOrder(edit, group, selected.index, -1))}>{t("下移一层")}</button><button type="button" disabled={busy || !group?.size} onClick={() => {
                    if (!group?.size) return; const rect = initialLayerStudioRect(selectedItem, group.size, dimensions); if (rect) patch(rect); setScalePercent("100");
                }}>{t("复位位置")}</button></div></> : <p className="layer-editor-muted">{t("尺寸尚未就绪，暂不可调整。")}</p>}
                <p className="layer-editor-muted">{t("文件尺寸：")}{selectedItem.width ?? dimensions.get(selectedItem.index)?.width ?? t("未知")} × {selectedItem.height ?? dimensions.get(selectedItem.index)?.height ?? t("未知")}{t(" px；文件分辨率不等于画布中的摆放尺寸。")}</p>
                <OcrDetails item={selectedItem} />
            </div>}
        </aside></div>
    </section>;
}
