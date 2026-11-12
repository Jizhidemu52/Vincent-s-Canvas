import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Select } from "antd";
import { designBriefFromFields } from "../../../shared/design-brief";
import { designDestinations, prepareDesignHandoff } from "@/lib/design-handoff";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { uiText, useUiText } from "@/lib/i18n";
import type { ReferenceImage } from "@/types/image";

const checks: Record<string, string[]> = {
    "style-to-sketch": ["目标产品、轮廓与结构线是否完整", "纽扣、口袋、绞花和罗纹数量是否改变", "线稿不含颜色信息；继续处理前核对沿用要求"],
    "garment-colorway": ["是否只改变指定产品或区域", "图案、面料和配饰是否发生重绘", "颜色代码是生成参考，不能替代实物色差核对"],
    "local-restyle": ["修改位置和结构衔接是否合理", "未要求修改的图案、文字与配饰是否保持", "使用选区时检查边缘衔接；未选区不保证其他部位不变"],
    "back-design": ["前后片风格、面料与比例是否匹配", "背面结构是设计推测，不是隐藏原图的真实还原", "接缝、开口、图案位置是否适合打样"],
    "pattern-extract": ["图案元素、数量和比例是否完整", "遮挡处的补全是否符合已有证据", "边缘、底色和循环接缝需人工检查"],
};

/** File facts and manual review prompts, never an automatic quality approval. */
export function DesignResultReview({ sceneId, fields, image, disabled = false }: {
    sceneId: string; fields: Record<string, unknown>; image: ReferenceImage; disabled?: boolean;
}) {
    useUiText();
    const navigate = useNavigate();
    const flags = useModuleStore(state => state.flags);
    const tools = useBusinessConfigStore(state => state.tools);
    const available = designDestinations.filter(item => isModuleAvailable(flags, tools, item.id));
    const [destination, setDestination] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const lock = useRef(false);
    const mounted = useRef(true);
    const identity = `${sceneId}:${image.id}`;
    const currentIdentity = useRef(identity);
    currentIdentity.current = identity;
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const brief = useMemo(() => {
        try { return { value: designBriefFromFields(sceneId, fields) }; }
        catch { return { error: "沿用设计要求过长或格式不符，请先在设计输入中整理后再继续处理。" }; }
    }, [sceneId, fields]);
    const proceed = async () => {
        if (lock.current || disabled || !brief.value || !available.some(item => item.id === destination)) return;
        lock.current = true; setBusy(true); setError("");
        const startedIdentity = identity;
        try {
            const href = await prepareDesignHandoff(destination, image, brief.value);
            if (mounted.current && currentIdentity.current === startedIdentity) navigate(href);
        } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "设计交接未完成，请保留原记录后重试"); }
        finally { lock.current = false; if (mounted.current) setBusy(false); }
    };
    const dimensions = image.width && image.height ? `${image.width} × ${image.height} px` : uiText("尺寸未记录");
    const format = image.type ? image.type.replace(/^image\//, "").toUpperCase() : uiText("格式未记录");
    return <details className="border-t border-border px-3 py-2 text-sm leading-6">
        <summary className="cursor-pointer font-medium">{uiText("结果核对与继续处理")}</summary>
        <p className="my-2 text-muted-foreground">{uiText("实际输出")}：{dimensions} · {format}</p>
        <p className="font-medium">{uiText("待人工核对，不代表已验收")}</p>
        <ul className="my-2 list-disc pl-4 text-muted-foreground">{(checks[sceneId] || ["产品结构、图案、文字和面料是否符合要求", "结果仅供设计参考，打样前仍需核对工艺可行性"]).map(check => <li key={check}>{uiText(check)}</li>)}</ul>
        {!!brief.value?.requirements.length && <details className="my-2"><summary className="cursor-pointer">{uiText("将沿用的设计要求")}（{brief.value.requirements.length}）</summary><ul className="list-disc whitespace-pre-wrap break-words pl-4">{brief.value.requirements.map(line => <li key={line}>{line}</li>)}</ul></details>}
        <label className="block font-medium" htmlFor={`design-next-${image.id}`}>{uiText("下一步处理")}</label>
        <div className="my-2 flex flex-wrap gap-2">
            <Select id={`design-next-${image.id}`} aria-label={uiText("下一步处理")} className="min-w-0 flex-1" value={destination} disabled={disabled || busy} onChange={setDestination}
                options={[{ value: "", label: uiText("选择已有板块") }, ...available.map(item => ({ value: item.id, label: uiText(item.label) }))]} />
            <button type="button" className="flex items-center gap-1 rounded border border-border px-2 py-1 disabled:opacity-50" disabled={disabled || busy || !brief.value || !available.some(item => item.id === destination)} onClick={() => void proceed()}>{busy ? <LoaderCircle size={13} className="animate-spin" /> : <ArrowRight size={13} />}{uiText("带入新草稿")}</button>
        </div>
        <p className="text-muted-foreground">{uiText("只带入结果原图和可编辑要求，保留原任务，不自动生成。原选区不会带到新图。")}</p>
        {(error || brief.error) && <p role="alert" className="mt-2 text-destructive">{uiText(error || brief.error || "")}</p>}
    </details>;
}
