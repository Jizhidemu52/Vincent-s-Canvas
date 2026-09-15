import { Button, Input, Segmented, Select, Typography } from "antd";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { buildGarmentRecipe, garmentReferencesMatch, garmentScenarios, GARMENT_BRIEF_TEXT_LIMIT, type GarmentBrief, type GarmentRecipe, type GarmentScenario } from "@/lib/garment-recipe";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import type { ImageReferenceItem } from "@/types/image";

type Props = {
    references: ImageReferenceItem[];
    disabled: boolean;
    onApply: (recipe: GarmentRecipe) => void;
    onDraftChange: (dirty: boolean) => void;
    initialScenario?: GarmentScenario;
};

/** An untouched, empty form must not block a manually supplied prompt. */
export function garmentDraftChanged(brief: GarmentBrief, applied: GarmentBrief | null): boolean {
    if (!applied) return Boolean(brief.target.trim());
    return brief.scenario !== applied.scenario || brief.primaryId !== applied.primaryId
        || brief.target.trim() !== applied.target.trim() || brief.preserve.trim() !== applied.preserve.trim();
}

export function GarmentRecipePanel({ references, disabled, onApply, onDraftChange, initialScenario }: Props) {
    const panelId = useId();
    const [expanded, setExpanded] = useState(Boolean(initialScenario));
    const [preserveOpen, setPreserveOpen] = useState(false);
    const [brief, setBrief] = useState<GarmentBrief>(() => ({
        scenario: initialScenario || "colorway",
        primaryId: references.length === 1 ? references[0]!.id : "",
        target: "",
        preserve: "",
    }));
    const [error, setError] = useState("");
    const appliedBrief = useRef<GarmentBrief | null>(null);
    const hasBoundImage = useRef(Boolean(brief.primaryId));
    const previousReferences = useRef(references);
    const scenario = garmentScenarios.find(item => item.id === brief.scenario)!;
    const primary = references.find(item => item.id === brief.primaryId);
    const compiled = useMemo(() => {
        try {
            return { recipe: buildGarmentRecipe(brief, references), validation: "" };
        } catch (cause) {
            return { recipe: null, validation: cause instanceof Error ? cause.message : "请补全服装图和目标要求。" };
        }
    }, [brief, references]);

    const changeBrief = (patch: Partial<GarmentBrief>) => {
        if (disabled) return;
        const next = { ...brief, ...patch };
        onDraftChange(garmentDraftChanged(next, appliedBrief.current));
        if (next.primaryId) hasBoundImage.current = true;
        setBrief(next);
        setError("");
    };

    useLayoutEffect(() => {
        const before = previousReferences.current.find(item => item.id === brief.primaryId);
        previousReferences.current = references;
        if (!disabled && !hasBoundImage.current && !brief.primaryId && references.length === 1) {
            const next = { ...brief, primaryId: references[0]!.id };
            onDraftChange(garmentDraftChanged(next, appliedBrief.current));
            hasBoundImage.current = true;
            setBrief(next);
        } else if (before && !garmentReferencesMatch([before], primary ? [primary] : [])) {
            // A bound source changed: do not silently give its role to another image.
            onDraftChange(Boolean(appliedBrief.current || brief.target.trim()));
            setError("");
        }
    }, [references, brief, primary, disabled, onDraftChange]);

    const applyRecipe = () => {
        if (disabled || !compiled.recipe) return;
        setError("");
        // Clear the draft gate before the parent records the newly applied snapshot.
        // No follow-up draft callback may invalidate that snapshot in this event.
        onDraftChange(false);
        try {
            onApply(compiled.recipe);
            appliedBrief.current = { ...brief };
        } catch (cause) {
            onDraftChange(garmentDraftChanged(brief, appliedBrief.current));
            setError(cause instanceof Error ? cause.message : "套用失败，请检查图片和目标要求。");
        }
    };

    const imageLabel = (reference: ImageReferenceItem) => `${imageReferenceLabel(references.indexOf(reference))} · ${reference.imageName || reference.name || "服装图"}`;

    return (
        <section className="min-w-0" aria-label={initialScenario ? scenario.title : "服装换色与改款"}>
            {!initialScenario ? <button
                type="button"
                className="text-left text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                aria-expanded={expanded}
                aria-controls={panelId}
                disabled={disabled}
                onClick={() => setExpanded(current => !current)}
            >
                服装 · 换色 / 改款 <span aria-hidden="true">{expanded ? "−" : "+"}</span>
            </button> : null}
            <div id={panelId} hidden={!initialScenario && !expanded} className={initialScenario ? "space-y-3" : "mt-3 space-y-3"}>
                {!initialScenario ? <Segmented<GarmentScenario>
                    size="small"
                    value={brief.scenario}
                    options={[{ label: "换色", value: "colorway" }, { label: "改款", value: "restyle" }]}
                    disabled={disabled}
                    aria-label="服装场景"
                    onChange={value => changeBrief({ scenario: value })}
                /> : null}
                {!references.length ? <p className="text-xs text-[var(--muted-foreground)]">请先在参考图区添加服装图。</p> : references.length === 1 ? (
                    primary ? <p className="truncate text-xs text-[var(--muted-foreground)]" title={imageLabel(primary)}>服装图：{imageLabel(primary)}</p> : (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
                            <span>原服装图已移除，请重新绑定。</span>
                            <Button size="small" disabled={disabled} onClick={() => changeBrief({ primaryId: references[0]!.id })}>使用当前图片</Button>
                        </div>
                    )
                ) : (
                    <Select
                        aria-label="服装主图"
                        size="small"
                        className="w-full"
                        placeholder="选择服装主图（仅此图会用于生成）"
                        value={primary?.id}
                        disabled={disabled}
                        allowClear
                        options={references.map(reference => ({
                            value: reference.id,
                            label: <span className="flex min-w-0 items-center gap-2"><img src={reference.dataUrl || reference.url} alt="" className="size-5 shrink-0 rounded object-contain" /><span className="truncate">{imageLabel(reference)}</span></span>,
                        }))}
                        onChange={value => changeBrief({ primaryId: value || "" })}
                    />
                )}
                <div className="space-y-1.5">
                    {initialScenario ? <label htmlFor={`${panelId}-target`} className="block text-xs font-medium">{scenario.targetLabel}</label> : null}
                    <Input.TextArea
                        id={`${panelId}-target`}
                        aria-label={scenario.targetLabel}
                        rows={2}
                        value={brief.target}
                        disabled={disabled}
                        maxLength={GARMENT_BRIEF_TEXT_LIMIT}
                        placeholder={scenario.targetPlaceholder}
                        onChange={event => changeBrief({ target: event.target.value })}
                    />
                </div>
                <div className="space-y-2">
                    <button type="button" className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50" aria-expanded={preserveOpen} aria-controls={`${panelId}-preserve`} disabled={disabled} onClick={() => setPreserveOpen(current => !current)}>
                        保留要求（可选） <span aria-hidden="true">{preserveOpen ? "−" : "+"}</span>
                    </button>
                    <div id={`${panelId}-preserve`} hidden={!preserveOpen}>
                        <Input size="small" aria-label="额外保留要求" value={brief.preserve} disabled={disabled} maxLength={GARMENT_BRIEF_TEXT_LIMIT} placeholder="例如：保留领口、口袋位置和面料质感" onChange={event => changeBrief({ preserve: event.target.value })} />
                    </div>
                </div>
                {error ? <Typography.Text type="danger" className="block text-xs" role="alert">{error}</Typography.Text> : brief.target.trim() && compiled.validation ? <p role="status" className="text-xs text-[var(--muted-foreground)]">{compiled.validation}</p> : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Button size="small" disabled={disabled || !compiled.recipe} onClick={applyRecipe}>套用到提示词</Button>
                    <span className="text-xs text-[var(--muted-foreground)]">仅回填，不会出图</span>
                </div>
            </div>
        </section>
    );
}
