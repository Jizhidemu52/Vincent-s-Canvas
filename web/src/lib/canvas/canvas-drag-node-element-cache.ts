import type { Position } from "@/types/canvas";

type CanvasDragNodeElement = {
    style: Pick<CSSStyleDeclaration, "transform">;
};

/**
 * Caches the DOM elements participating in one drag transaction. Drag previews
 * run once per animation frame, so resolving selectors again for every moved
 * node quickly becomes expensive for multi-selection drags.
 */
export function createCanvasDragNodeElementCache(findElement: (nodeId: string) => CanvasDragNodeElement | null) {
    const elements = new Map<string, CanvasDragNodeElement | null>();

    const get = (nodeId: string) => {
        if (!elements.has(nodeId)) elements.set(nodeId, findElement(nodeId));
        return elements.get(nodeId) ?? null;
    };

    return {
        warm(nodeIds: Iterable<string>) {
            for (const nodeId of nodeIds) get(nodeId);
        },
        apply(preview: ReadonlyMap<string, Position>) {
            preview.forEach((position, nodeId) => {
                const element = get(nodeId);
                if (element) element.style.transform = `translate(${position.x}px, ${position.y}px)`;
            });
        },
        clear() {
            elements.clear();
        },
    };
}
