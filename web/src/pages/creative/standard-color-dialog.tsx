import { uiText, useUiText } from "@/lib/i18n";
import { Button, Modal, Spin } from "antd";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { findStandardColors, loadStandardColorManifest, loadStandardColors, toStandardColorSelection, type StandardColor, type StandardColorSelection } from "@/lib/standard-colors";
import { PhotoColorSampler } from "./photo-color-sampler";
import { useModuleEnabled } from "@/stores/use-module-store";
import { isSceneHexColor } from "./scene-form-model";
import "./standard-color-dialog.css";

const pageSize = 48;

export default function StandardColorDialog({ initialHex, selection, source, slotLabel, onSelect, onClose }: {
    initialHex: string;
    selection?: StandardColorSelection | null;
    source?: string;
    slotLabel: string;
    onSelect: (selection: StandardColorSelection) => void;
    onClose: () => void;
}) {
    useUiText();
    const photoColorPickerEnabled = useModuleEnabled("photo-color-picker");
    const [manifest, setManifest] = useState<Awaited<ReturnType<typeof loadStandardColorManifest>> | null>(null);
    const [library, setLibrary] = useState(selection?.library || "PANTONE TCX");
    const [colors, setColors] = useState<StandardColor[]>([]);
    const [query, setQuery] = useState("");
    const deferredQuery = useDeferredValue(query);
    const [hex, setHex] = useState(initialHex);
    const [sort, setSort] = useState<"catalog" | "nearest">("catalog");
    const [page, setPage] = useState(0);
    const [chosen, setChosen] = useState<StandardColorSelection | null>(null);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setBusy(true); setError(""); setColors([]);
        void loadStandardColorManifest().then(async data => {
            if (cancelled) return;
            setManifest(data);
            if (library && !data.libraries.some(item => item.name === library)) { setLibrary(""); return; }
            const loaded = await loadStandardColors(library || undefined);
            if (!cancelled) setColors(loaded);
        }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? uiText(caught.message) : uiText("色库加载失败，请重试")); })
            .finally(() => { if (!cancelled) setBusy(false); });
        return () => { cancelled = true; };
    }, [library, retry]);

    const validHex = isSceneHexColor(hex);
    const effectiveSort = sort === "nearest" && validHex ? "nearest" : "catalog";
    const matchingHex = effectiveSort === "nearest" ? hex : undefined;
    const results = useMemo(() => findStandardColors(colors, {
        query: deferredQuery, hex: matchingHex, sort: effectiveSort, limit: pageSize, offset: page * pageSize,
    }), [colors, deferredQuery, matchingHex, effectiveSort, page]);
    const updating = busy || query !== deferredQuery;
    const pageCount = Math.max(1, Math.ceil(results.total / pageSize));
    const currentHex = isSceneHexColor(initialHex) ? initialHex : "transparent";
    const pickHex = (value: string) => { setHex(value); setSort("nearest"); setPage(0); };

    return <Modal open modalRender={modal => <div data-usage-board="standard-colors">{modal}</div>} title={uiText("从标准色库选择 · {slotLabel}", { slotLabel: slotLabel })} width={920} onCancel={onClose}
        footer={<div className="sc-footer"><span>{uiText("仅填写目标色，点击「生成」后才调用 AI。")}</span><div><Button onClick={onClose}>{uiText("取消")}</Button><Button type="primary" disabled={!chosen} onClick={() => { if (chosen) onSelect(chosen); }}>{uiText("应用到")}{slotLabel}</Button></div></div>}>
        <div className="sc-dialog">
            <div className="sc-intro"><p>{uiText("搜索色号，或从原图取色寻找相近颜色。")}</p><span>{manifest ? uiText("{value1} 色 · {length} 个色库 / 分组", { value1: manifest.total.toLocaleString(), length: manifest.libraries.length }) : uiText("正在读取色库目录…")}</span></div>
            <div className="sc-filters">
                <label>{uiText("色库")}<select className="cs-select" value={library} disabled={!manifest} onChange={event => { setLibrary(event.target.value); setPage(0); }}>
                    <option value="">{uiText("全部色库")}</option>
                    {manifest?.libraries.map(item => <option key={item.name} value={item.name}>{item.name}（{item.count.toLocaleString()}）</option>)}
                </select></label>
                <label>{uiText("色号 / 名称 / HEX")}<input className="cs-input" type="search" value={query} autoFocus placeholder={uiText("例如：18-1664、RAL 3020、#A5B8C5")} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
            </div>
            <div className="sc-match-controls">
                <label>{uiText("参考色")}<input className="cs-input" aria-invalid={!validHex} value={hex} maxLength={7} onChange={event => { setHex(event.target.value); setPage(0); }} placeholder="#RRGGBB" /></label>
                <div role="group" aria-label={uiText("颜色排序")}><button type="button" className="cs-choice" aria-pressed={effectiveSort === "catalog"} onClick={() => { setSort("catalog"); setPage(0); }}>{uiText("按色库浏览")}</button><button type="button" className="cs-choice" aria-pressed={effectiveSort === "nearest"} disabled={!validHex} onClick={() => { setSort("nearest"); setPage(0); }}>{uiText("寻找相近色")}</button></div>
                {effectiveSort === "nearest" && <span>{uiText("按 ΔE2000 从小到大排列")}</span>}
            </div>
            {!validHex && <p className="sc-error" role="status">{uiText("请输入 #RGB 或 #RRGGBB 格式的参考色。")}</p>}
            {photoColorPickerEnabled && source && <details className="sc-photo"><summary>{uiText("从已上传的款式图取色")}</summary><PhotoColorSampler src={source} onPick={pickHex} /></details>}
            <div className="sc-status" aria-live="polite">{updating ? <><Spin size="small" /> {uiText(" 正在加载颜色…")}</> : error ? null : uiText("{value1} 个结果{value2}", { value1: results.total.toLocaleString(), value2: effectiveSort === "nearest" ? uiText(" · 屏幕色值近似匹配") : "" })}</div>
            {error ? <div className="sc-error" role="alert"><p>{uiText(error || "")}</p><Button onClick={() => setRetry(value => value + 1)}>{uiText("重新加载")}</Button></div> : <>
                <div className="sc-grid" aria-label={uiText("标准色卡")} aria-busy={updating}>
                    {!updating && results.items.map(({ color, deltaE }) => {
                        const selected = chosen?.id === color.id && chosen.library === (library || color.brand);
                        return <button type="button" className="sc-card" key={color.id} aria-pressed={selected} aria-label={`${color.name} ${color.hex}`} onClick={() => setChosen(toStandardColorSelection(color, library || undefined, manifest?.version))}>
                            <span className="sc-swatch" style={{ background: color.hex }} />
                            <span className="sc-card-name" title={color.name}>{color.name}</span>
                            <span className="sc-card-library" title={library || color.brand}>{library || color.brand}</span>
                            <span className="sc-card-values">{color.hex}{deltaE !== undefined && <span>ΔE {deltaE.toFixed(2)}</span>}</span>
                        </button>;
                    })}
                    {!updating && !results.total && <p className="sc-empty">{uiText("没有找到匹配色号，请缩短关键词或切换到全部色库。")}</p>}
                </div>
                <nav className="sc-pagination" aria-label={uiText("色卡分页")}><Button size="small" disabled={updating || page === 0} onClick={() => setPage(value => value - 1)}>{uiText("上一页")}</Button><span>{uiText("第 {page} / {total} 页", { page: page + 1, total: pageCount })}</span><Button size="small" disabled={updating || page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>{uiText("下一页")}</Button></nav>
            </>}
            <div className="sc-selection" aria-live="polite">
                <span className="sc-comparison" style={{ background: currentHex }} aria-label={uiText("当前色 {initialHex}", { initialHex: initialHex })} />
                <span>→</span><span className="sc-comparison" style={{ background: chosen?.hex || "transparent" }} />
                {chosen ? <div><strong>{chosen.name}</strong><span>{chosen.library} · {chosen.hex}</span><a href={chosen.sourceUrl} target="_blank" rel="noreferrer">{uiText("查看色号来源")}</a></div> : <span>{uiText("选择一张色卡，确认后填入")}{slotLabel}。</span>}
            </div>
            <p className="sc-note">{uiText("色值来自公开色库快照，供屏幕与 AI 配色参考。照片换色将要求保留面料纹理、褶皱和光影，生成结果仍为近似颜色；生产用色请核对实物色卡。")}</p>
        </div>
    </Modal>;
}
