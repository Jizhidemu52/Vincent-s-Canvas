import React, { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

export type CanvasSelectionOverlayState = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
};

export type CanvasSelectionOverlayHandle = {
    show: (selection: CanvasSelectionOverlayState) => void;
    hide: () => void;
};

export function canvasSelectionOverlayRect(selection: CanvasSelectionOverlayState) {
    return {
        left: Math.min(selection.startWorldX, selection.currentWorldX),
        top: Math.min(selection.startWorldY, selection.currentWorldY),
        width: Math.abs(selection.startWorldX - selection.currentWorldX),
        height: Math.abs(selection.startWorldY - selection.currentWorldY),
    };
}

export const CanvasSelectionOverlay = React.memo(forwardRef<CanvasSelectionOverlayHandle, { borderColor: string; background: string }>(function CanvasSelectionOverlay({ borderColor, background }, ref) {
    const elementRef = useRef<HTMLDivElement>(null);
    const show = useCallback((selection: CanvasSelectionOverlayState) => {
        const element = elementRef.current;
        if (!element) return;
        const rect = canvasSelectionOverlayRect(selection);
        element.style.display = "block";
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.top}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
    }, []);
    const hide = useCallback(() => {
        if (elementRef.current) elementRef.current.style.display = "none";
    }, []);

    useImperativeHandle(ref, () => ({ show, hide }), [hide, show]);

    return <div ref={elementRef} className="pointer-events-none absolute z-[100] border" style={{ display: "none", borderColor, background }} />;
}));
