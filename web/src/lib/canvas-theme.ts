export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: "#fbfbfa",
            dot: "rgba(71,85,105,.12)",
            line: "rgba(71,85,105,.07)",
            selectionStroke: "#50d5be",
            selectionFill: "rgba(80,213,190,.08)",
        },
        node: {
            label: "#475569",
            fill: "#f7f7f6",
            panel: "#ffffff",
            stroke: "#e2e8f0",
            activeStroke: "#334155",
            placeholder: "#94a3b8",
            text: "#1e293b",
            muted: "#64748b",
            faint: "#94a3b8",
        },
        toolbar: {
            panel: "rgba(255,255,255,.96)",
            border: "#e2e8f0",
            item: "#475569",
            itemHover: "#f1f5f9",
            activeBg: "#f1f5f9",
            activeText: "#1e293b",
            primary: "#f36a2d",
            highResolution: "#805ad5",
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#fafaf9",
            selectionFill: "rgba(250,250,249,.10)",
        },
        node: {
            label: "#d6d3d1",
            fill: "#292524",
            panel: "#1f1d1a",
            stroke: "#44403c",
            activeStroke: "#fafaf9",
            placeholder: "#a8a29e",
            text: "#f5f5f4",
            muted: "#d6d3d1",
            faint: "#78716c",
        },
        toolbar: {
            panel: "rgba(31,29,26,.96)",
            border: "#44403c",
            item: "#d6d3d1",
            itemHover: "#292524",
            activeBg: "#3a3631",
            activeText: "#f5f5f4",
            primary: "#f36a2d",
            highResolution: "#b794f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
