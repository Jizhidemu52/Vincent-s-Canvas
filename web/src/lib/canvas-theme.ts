export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: "#f2f2f2",
            dot: "rgba(0,0,0,.16)",
            line: "rgba(37,37,35,.075)",
            selectionStroke: "#3bbaa5",
            selectionFill: "rgba(59,186,165,.10)",
        },
        node: {
            label: "#555555",
            fill: "#f6f6f6",
            panel: "#ffffff",
            stroke: "#e6e6e6",
            activeStroke: "#272724",
            placeholder: "#999999",
            text: "#171717",
            muted: "#777777",
            faint: "#999999",
        },
        toolbar: {
            panel: "rgba(255,255,255,.96)",
            border: "#e6e6e6",
            item: "#555555",
            itemHover: "#f3f3f3",
            activeBg: "#f3f3f3",
            activeText: "#171717",
            primary: "#ff5a1f",
            highResolution: "#805ad5",
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#ff6b35",
            selectionFill: "rgba(255,107,53,.14)",
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
            primary: "#ff6b35",
            highResolution: "#b794f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
