import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ImageIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasModelGroups, commonCanvasModels, type CanvasModelOption } from "@/lib/canvas/canvas-model-picker-options";
import { useThemeStore } from "@/stores/use-theme-store";
import { cn } from "@/lib/utils";
import "./canvas-model-picker.css";

type CanvasModelPickerProps = {
    options: CanvasModelOption[];
    value: string;
    label: string;
    emptyLabel: string;
    open: boolean;
    disabled: boolean;
    bound: boolean;
    categoryLabel: string;
    className?: string;
    onOpenChange: (open: boolean) => void;
    onValueChange: (value: string) => void;
};

export function CanvasModelPicker({ options, value, label, emptyLabel, open, disabled, bound, categoryLabel, className, onOpenChange, onValueChange }: CanvasModelPickerProps) {
    const themeName = useThemeStore(state => state.theme);
    const theme = canvasThemes[themeName];
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const menuRef = useRef<HTMLDivElement>(null);
    const openingFocusFrame = useRef<number | null>(null);
    const listId = useId();
    const current = options.find(option => option.value === value);
    const featured = commonCanvasModels(options);
    useEffect(() => () => {
        if (openingFocusFrame.current !== null) cancelAnimationFrame(openingFocusFrame.current);
    }, []);
    const focusOnOpen = (event: Event) => {
        event.preventDefault();
        const menu = menuRef.current;
        if (!menu || disabled) return;
        if (current && !featured.some(option => option.value === current.value)) {
            setExpanded(previous => previous.has(current.family) ? previous : new Set([...previous, current.family]));
        }
        if (openingFocusFrame.current !== null) cancelAnimationFrame(openingFocusFrame.current);
        // Wait for the newly expanded family to render. Only the opening event
        // moves focus; later list updates and manual collapses leave it alone.
        openingFocusFrame.current = requestAnimationFrame(() => {
            openingFocusFrame.current = null;
            if (menuRef.current !== menu || !menu.isConnected) return;
            const selected = menu.querySelector<HTMLButtonElement>('button[data-model-choice][aria-selected="true"]:not(:disabled)');
            const target = selected || menu.querySelector<HTMLButtonElement>('button[aria-label="关闭模型选择"]:not(:disabled)');
            target?.focus({ preventScroll: true });
            selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
    };
    const palette = {
        "--cmp-panel": theme.node.panel, "--cmp-text": theme.node.text, "--cmp-muted": theme.node.muted,
        "--cmp-border": theme.node.stroke, "--cmp-hover": theme.toolbar.itemHover, "--cmp-selected": theme.toolbar.activeBg,
    } as CSSProperties;
    const select = (model: string) => {
        if (disabled || !options.some(option => option.value === model)) return;
        onValueChange(model);
        onOpenChange(false);
    };
    const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
    };
    const row = (option: CanvasModelOption) => <CanvasModelRow key={option.value} option={option} selected={option.value === value} onSelect={select} />;

    return <Popover.Root open={open && !disabled} onOpenChange={next => { if (!disabled) onOpenChange(next); }}>
        <Popover.Trigger asChild>
            <button type="button" role="combobox" aria-label="选择模型" aria-haspopup="dialog" aria-controls={open ? listId : undefined} aria-expanded={open && !disabled}
                disabled={disabled} data-usage-control="model" data-theme={themeName} style={palette}
                className={cn("canvas-composer-model-picker canvas-model-trigger", className)} title={`${label}${bound ? " · 后台指定" : ""}`}
                onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>
                <ModelLogo option={current} compact />
                <span className="canvas-model-trigger-name">{label}</span>
                <ChevronDown className={cn("canvas-model-trigger-chevron", open && !disabled && "is-open")} size={15} aria-hidden="true" />
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content ref={menuRef} id={listId} data-testid="canvas-model-picker-menu" data-canvas-no-zoom data-theme={themeName}
                aria-label="选择画布模型" className="canvas-model-menu" style={palette} side="right" align="start" sideOffset={12} collisionPadding={12}
                onOpenAutoFocus={focusOnOpen}
                onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
                onKeyDown={moveFocus}>
                <div className="canvas-model-menu-header">
                    <button type="button" aria-label="关闭模型选择" onClick={() => onOpenChange(false)}><ArrowLeft size={14} aria-hidden="true" /><span>返回</span></button>
                    <span>选择模型</span>
                </div>
                <div className="canvas-model-menu-scroll">
                    {!options.length ? <p className="canvas-model-empty" role="status">{emptyLabel}</p>
                        : <>
                            {featured.length ? <><p className="canvas-model-section-label">热门模型</p>
                                <div role="listbox" aria-label="热门模型">{featured.map(row)}</div></> : null}
                            <p className={cn("canvas-model-section-label", featured.length > 0 && "canvas-model-section-all")}>所有{categoryLabel}</p>
                            {canvasModelGroups(options).map(group => <section className="canvas-model-family" key={group.name}>
                                <button type="button" className="canvas-model-family-toggle" aria-expanded={expanded.has(group.name)} onClick={() => setExpanded(previous => {
                                    const next = new Set(previous); if (next.has(group.name)) next.delete(group.name); else next.add(group.name); return next;
                                })}>
                                    <ModelLogo option={group.models[0]} />
                                    <span>{group.name}</span><span className="canvas-model-family-count">{group.models.length} 个模型</span>
                                    <ChevronRight size={14} aria-hidden="true" className={expanded.has(group.name) ? "canvas-model-family-expanded" : undefined} />
                                </button>
                                {expanded.has(group.name) ? <div role="listbox" aria-label={`${group.name} 模型`}>{group.models.map(row)}</div> : null}
                            </section>)}
                        </>}
                </div>
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>;
}

export function CanvasModelRow({ option, selected, onSelect }: { option: CanvasModelOption; selected: boolean; onSelect: (value: string) => void }) {
    return <button type="button" role="option" aria-selected={selected} aria-label={option.name} data-model-choice data-usage-control="model" data-usage-value={option.usageModelId}
        className="canvas-model-option" onClick={() => onSelect(option.value)}>
        <ModelLogo option={option} />
        <span className="canvas-model-option-copy">
            <span className="canvas-model-option-heading"><span className="canvas-model-option-name">{option.name}</span>{option.channel ? <span className="canvas-model-channel">{option.channel}</span> : null}</span>
            {option.description ? <span className="canvas-model-option-description">{option.description}</span> : null}
            {option.details.length ? <span className="canvas-model-option-details">{option.details.join(" · ")}</span> : null}
        </span>
        {selected ? <Check className="canvas-model-option-check" size={15} aria-label="已选择" /> : null}
    </button>;
}

function ModelLogo({ option, compact = false }: { option?: CanvasModelOption; compact?: boolean }) {
    return <span className={cn("canvas-model-logo", compact && "canvas-model-logo-compact")} aria-hidden="true">
        {option?.icon ? <img src={option.icon} alt="" draggable={false} /> : <ImageIcon size={compact ? 19 : 23} />}
    </span>;
}
