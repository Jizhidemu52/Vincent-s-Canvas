import { memo, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, Ref } from "react";
import { Button, Image } from "antd";
import { FileText, Image as ImageIcon, Music2, Video, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { createCanvasTextDraft } from "@/lib/canvas/canvas-text-draft";
import { useThemeStore } from "@/stores/use-theme-store";
import type { NodeGenerationInput } from "./canvas-node-generation";
import { CanvasPersistedMediaPreview } from "./canvas-persisted-media-preview";
import { resolveImageUrl } from "@/services/image-storage";

type CanvasConfigComposerProps = {
    ref?: Ref<CanvasConfigComposerHandle>;
    value: string;
    inputs: NodeGenerationInput[];
    onChange: (value: string) => void;
    onClose?: () => void;
    compact?: boolean;
    disabled?: boolean;
    label?: string;
    referenceLabels?: Record<string, string>;
};

export type CanvasConfigComposerHandle = { read: () => string; replace: (value: string) => void };

type Token =
    | { type: "text"; value: string }
    | { type: "reference"; nodeId: string };

type MentionState = {
    query: string;
};

export const CONFIG_REFERENCE_PATTERN = /@\[node:([^\]]+)\]/g;

export function CanvasConfigComposer({ ref, value, inputs, onChange, onClose, compact = false, disabled = false, label = "提示词", referenceLabels }: CanvasConfigComposerProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const editorRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const [mention, setMention] = useState<MentionState | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [draftValue, setDraftValue] = useState(value);
    const deferredDraft = useDeferredValue(draftValue);
    const deferredQuery = useDeferredValue(mention?.query ?? "");
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const draftRef = useRef<ReturnType<typeof createCanvasTextDraft> | null>(null);
    if (!draftRef.current) draftRef.current = createCanvasTextDraft(value, (next) => onChangeRef.current(next));
    // A mode change must read pending typing and cancel its old debounce atomically.
    useImperativeHandle(ref, () => ({
        read: () => editorRef.current ? serializeEditor(editorRef.current) : draftValue,
        replace: (next) => { draftRef.current?.reset(next); setDraftValue(next); },
    }));
    const tokens = useMemo(() => parseComposerTokens(deferredDraft), [deferredDraft]);
    const referenceById = useMemo(() => new Map(inputs.map((input) => [input.nodeId, input])), [inputs]);
    const filterCandidates = useCallback((search: string) => {
        const query = search.trim().toLowerCase();
        if (!query) return inputs;
        return inputs.filter((input) => `${resourceLabel(input, inputs, referenceLabels)} ${input.title} ${input.text || ""}`.toLowerCase().includes(query));
    }, [inputs, referenceLabels]);
    const candidates = useMemo(() => filterCandidates(deferredQuery), [filterCandidates, deferredQuery]);

    useEffect(() => {
        if (document.activeElement === editorRef.current) return;
        const editor = editorRef.current;
        if (!editor) return;
        editor.textContent = "";
        tokens.forEach((token) => {
            if (token.type === "text") {
                editor.append(document.createTextNode(token.value));
                return;
            }
            const input = referenceById.get(token.nodeId);
            if (input) editor.append(createReferenceChip(input, inputs, theme, setImagePreview));
            else editor.append(document.createTextNode(`@[node:${token.nodeId}]`));
        });
    }, [inputs, referenceById, theme, tokens]);

    useEffect(() => {
        setDraftValue((current) => (current === value ? current : value));
        draftRef.current?.reset(value);
    }, [value]);

    useEffect(() => () => draftRef.current?.flush(), []);

    const syncFromEditor = () => {
        const editor = editorRef.current;
        if (!editor) return;
        const next = serializeEditor(editor);
        setDraftValue(next);
        draftRef.current?.change(next);
        syncMention();
    };

    const syncMention = () => {
        const text = textBeforeCaret();
        const match = /@([^\s@]*)$/.exec(text);
        if (!match || !inputs.length) {
            closeMention();
            return;
        }
        setMention({ query: match[1] || "" });
        setActiveIndex(0);
    };

    const closeMention = () => {
        setMention(null);
        setActiveIndex(0);
    };

    const insertReference = useCallback((input: NodeGenerationInput) => {
        const editor = editorRef.current;
        if (!editor) return;
        const query = /@([^\s@]*)$/.exec(textBeforeCaret())?.[1];
        if (query === undefined || !filterCandidates(query).some(item => item.nodeId === input.nodeId)) return;
        removeActiveMention();
        const chip = createReferenceChip(input, inputs, theme, setImagePreview);
        const space = document.createTextNode(" ");
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range) {
            range.insertNode(space);
            range.insertNode(chip);
            range.setStartAfter(space);
            range.collapse(true);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } else {
            editor.append(chip, space);
            placeCaretAtEnd(editor);
        }
        setMention(null);
        setActiveIndex(0);
        const next = serializeEditor(editor);
        setDraftValue(next);
        draftRef.current?.reset(next);
        onChange(next);
    }, [filterCandidates, inputs, onChange, theme]);

    const stopCanvasInteraction = (event: PointerEvent | MouseEvent) => event.stopPropagation();

    return (
        <div
            data-canvas-no-zoom
            className={compact ? "min-w-0 cursor-text" : "rounded-2xl border p-3 shadow-2xl backdrop-blur"}
            style={{ background: compact ? undefined : theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={stopCanvasInteraction}
            onPointerDown={stopCanvasInteraction}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <div className="shrink-0 text-xs font-semibold">{label}</div>
                    {inputs.length ? <div className="truncate text-[11px] opacity-55">@ 引用素材</div> : null}
                </div>
                {onClose ? <Button size="small" type="text" className="!h-7 !w-7 !min-w-7 !p-0" icon={<X className="size-3.5" />} onClick={onClose} /> : null}
            </div>
            <div className="relative rounded-xl border" style={{ background: theme.node.fill, borderColor: theme.node.stroke }}>
                {!draftValue.trim() ? <div className="pointer-events-none absolute left-3 top-2 text-sm leading-6" style={{ color: theme.node.placeholder }}>{label === "朗读文本" ? "输入需要转为语音的文字" : "描述希望生成或修改的内容"}</div> : null}
                <div
                    ref={editorRef}
                    contentEditable={!disabled}
                    role="textbox"
                    aria-label={label}
                    aria-multiline="true"
                    aria-disabled={disabled}
                    suppressContentEditableWarning
                    className={`thin-scrollbar ${compact ? "h-24" : "min-h-28 max-h-64"} w-full select-text overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 outline-none`}
                    style={{ color: theme.node.text }}
                    onInput={() => {
                        if (!composingRef.current) syncFromEditor();
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                        composingRef.current = false;
                        syncFromEditor();
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                        event.stopPropagation();
                        if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                        const currentQuery = mention && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key) ? /@([^\s@]*)$/.exec(textBeforeCaret())?.[1] : undefined;
                        const currentCandidates = currentQuery === undefined ? [] : filterCandidates(currentQuery);
                        if (mention && currentCandidates.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveIndex((index) => (index + 1) % currentCandidates.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveIndex((index) => (index - 1 + currentCandidates.length) % currentCandidates.length);
                                return;
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                insertReference(currentCandidates[Math.min(activeIndex, currentCandidates.length - 1)]);
                                return;
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                closeMention();
                                return;
                            }
                        }
                        if ((event.key === "Backspace" || event.key === "Delete") && deleteAdjacentReference(event.key)) {
                            event.preventDefault();
                            requestAnimationFrame(syncFromEditor);
                            return;
                        }
                        requestAnimationFrame(syncMention);
                    }}
                    onBlur={() => { draftRef.current?.flush(); window.setTimeout(closeMention, 120); }}
                />
                {mention && candidates.length ? <MentionMenu inputs={candidates} allInputs={inputs} referenceLabels={referenceLabels} activeIndex={Math.min(activeIndex, candidates.length - 1)} theme={theme} onSelect={insertReference} /> : null}
            </div>
            {imagePreview ? <Image src={imagePreview} alt="引用图片预览" style={{ display: "none" }} preview={{ visible: true, src: imagePreview, onVisibleChange: (visible) => !visible && setImagePreview(null) }} /> : null}
        </div>
    );

}

const MentionMenu = memo(function MentionMenu({ inputs, allInputs, referenceLabels, activeIndex, theme, onSelect }: { inputs: NodeGenerationInput[]; allInputs: NodeGenerationInput[]; referenceLabels?: Record<string, string>; activeIndex: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onSelect: (input: NodeGenerationInput) => void }) {
    const selectedRef = useRef(false);
    const activeItemRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, inputs]);

    const selectInput = (input: NodeGenerationInput) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(input);
    };

    return (
        <div className="absolute left-2 top-[calc(100%+6px)] z-[90] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}>
            {inputs.map((input, index) => (
                <button
                    key={input.nodeId}
                    ref={index === activeIndex ? activeItemRef : undefined}
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectInput(input);
                    }}
                >
                    <ResourcePreview input={input} />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium">{resourceLabel(input, allInputs, referenceLabels)}</span>
                        <span className="block truncate opacity-65">{input.text || input.title}</span>
                    </span>
                </button>
            ))}
        </div>
    );
});

function ResourcePreview({ input }: { input: NodeGenerationInput }) {
    if (input.type === "image" && input.image) return <CanvasPersistedMediaPreview kind="image" url={input.image.dataUrl} storageKey={input.image.storageKey} alt="" className="size-9 rounded-md object-cover" />;
    if (input.type === "video" && input.video) return <video src={input.video.url} className="size-9 rounded-md bg-black object-cover" muted preload="metadata" />;
    const Icon = input.type === "audio" ? Music2 : input.type === "video" ? Video : input.type === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
            <Icon className="size-4" />
        </span>
    );
}

function createReferenceChip(input: NodeGenerationInput, inputs: NodeGenerationInput[], theme: (typeof canvasThemes)[keyof typeof canvasThemes], onImagePreview: (url: string) => void) {
    const wrapper = document.createElement("span");
    wrapper.contentEditable = "false";
    wrapper.dataset.referenceNodeId = input.nodeId;
    wrapper.className = "mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle";
    Object.assign(wrapper.style, chipStyle(theme));
    if (input.type === "image" && input.image) {
        const image = document.createElement("img");
        if (!input.image.storageKey) image.src = input.image.dataUrl;
        else void resolveImageUrl(input.image.storageKey, input.image.dataUrl).then(url => { if (url) image.src = url; }).catch(() => { image.alt = "参考图暂不可用"; });
        image.alt = input.title;
        image.className = "size-6 rounded object-cover";
        wrapper.className = "mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle";
        wrapper.appendChild(image);
        wrapper.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (image.getAttribute("src")) onImagePreview(image.src);
        });
    } else {
        wrapper.title = input.text || input.title;
        const text = document.createElement("span");
        text.className = "block truncate";
        text.textContent = input.type === "text" ? input.text || input.title : input.title;
        wrapper.appendChild(text);
    }
    return wrapper;
}

function serializeEditor(editor: HTMLElement) {
    return serializeNodes(editor.childNodes).replace(/\uFEFF/g, "");
}

function serializeNodes(nodes: NodeListOf<ChildNode>) {
    let result = "";
    nodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) result += node.textContent || "";
        if (!(node instanceof HTMLElement)) return;
        const nodeId = node.dataset.referenceNodeId;
        if (nodeId) result += `@[node:${nodeId}]`;
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes);
    });
    return result;
}

function removeActiveMention() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const text = textBeforeCaret();
    const match = /@([^\s@]*)$/.exec(text);
    if (!match) return;
    range.setStart(range.startContainer, Math.max(0, range.startOffset - (match[1] || "").length - 1));
    range.deleteContents();
}

function deleteAdjacentReference(key: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const target = adjacentReferenceNode(range, key);
    if (!target) return false;
    const nextCaretNode = document.createTextNode("");
    target.replaceWith(nextCaretNode);
    range.setStart(nextCaretNode, 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function adjacentReferenceNode(range: Range, key: string) {
    const container = range.startContainer;
    const offset = range.startOffset;
    const previous = key === "Backspace";
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
        return findReferenceSibling(container, previous);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset.referenceNodeId ? current : null;
}

function textBeforeCaret() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const range = selection.getRangeAt(0).cloneRange();
    const editor = closestEditor(range.startContainer);
    if (!editor) return "";
    range.setStart(editor, 0);
    return range.toString();
}

function closestEditor(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[contenteditable='true']") || null;
}

function placeCaretAtEnd(element: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function parseComposerTokens(value: string): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(CONFIG_REFERENCE_PATTERN)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", nodeId: match[1] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}

function resourceLabel(input: NodeGenerationInput, inputs: NodeGenerationInput[], labels?: Record<string, string>) {
    if (labels?.[input.nodeId]) return labels[input.nodeId];
    const sameTypeInputs = inputs.filter((item) => item.type === input.type);
    const index = Math.max(0, sameTypeInputs.findIndex((item) => item.nodeId === input.nodeId));
    if (input.type === "image") return `图片${index + 1}`;
    if (input.type === "video") return `视频${index + 1}`;
    if (input.type === "audio") return `音频${index + 1}`;
    return `文本${index + 1}`;
}

function chipStyle(theme: (typeof canvasThemes)[keyof typeof canvasThemes]): CSSProperties {
    return { background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text };
}
