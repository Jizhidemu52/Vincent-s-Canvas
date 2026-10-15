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
            background: "#1c1c1c",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#3bbaa5",
            selectionFill: "rgba(59,186,165,.14)",
        },
        node: {
            label: "#c7c7c7",
            fill: "#303030",
            panel: "#242424",
            stroke: "#3c3c3c",
            activeStroke: "#f2f2f2",
            placeholder: "#a3a3a3",
            text: "#f2f2f2",
            muted: "#a3a3a3",
            faint: "#808080",
        },
        toolbar: {
            panel: "rgba(36,36,36,.98)",
            border: "#3c3c3c",
            item: "#c7c7c7",
            itemHover: "#303030",
            activeBg: "#353535",
            activeText: "#f2f2f2",
            primary: "#ff6b35",
            highResolution: "#b794f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
