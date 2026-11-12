import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";
import { canvasThemes, type CanvasColorTheme } from "./canvas-theme";

const motionEase = "cubic-bezier(.2, .7, .2, 1)";
const motionTokens = {
    motionEaseOutCirc: motionEase,
    motionEaseInOutCirc: motionEase,
    motionEaseOut: motionEase,
    motionEaseInOut: motionEase,
    motionEaseOutBack: motionEase,
    motionEaseInBack: motionEase,
    motionEaseInQuint: motionEase,
    motionEaseOutQuint: motionEase,
} satisfies NonNullable<ThemeConfig["token"]>;

/** Canvas controls also render in portals: scope their neutral theme in context. */
export function getCanvasAntThemeConfig(mode: CanvasColorTheme): ThemeConfig {
    const colors = canvasThemes[mode];
    return {
        inherit: false,
        algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: `canvas-workspace-${mode}` },
        token: {
            ...motionTokens,
            colorPrimary: colors.node.text,
            colorInfo: colors.node.text,
            colorBgLayout: colors.canvas.background,
            colorBgContainer: colors.node.panel,
            colorBgElevated: colors.node.panel,
            colorBorder: colors.node.stroke,
            colorBorderSecondary: colors.node.stroke,
            colorText: colors.node.text,
            colorTextSecondary: colors.node.muted,
            colorTextLightSolid: colors.node.panel,
            colorFillSecondary: colors.toolbar.itemHover,
            colorFillTertiary: colors.toolbar.activeBg,
            borderRadius: 8,
            borderRadiusLG: 12,
            controlHeight: 32,
            fontSize: 13,
            motionDurationFast: "0.12s",
            motionDurationMid: "0.18s",
            motionDurationSlow: "0.24s",
            fontFamily: '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
            boxShadowSecondary: "0 3px 16px rgba(0,0,0,.10)",
        },
        components: {
            Button: { primaryShadow: "none", defaultShadow: "none" },
            Dropdown: { paddingBlock: 4, controlPaddingHorizontal: 10 },
            Menu: { itemHeight: 32, itemMarginInline: 4, itemMarginBlock: 2, itemHoverBg: colors.toolbar.itemHover, itemSelectedBg: colors.toolbar.activeBg, itemSelectedColor: colors.node.text },
            Select: { optionActiveBg: colors.toolbar.itemHover, optionSelectedBg: colors.toolbar.activeBg, optionSelectedColor: colors.node.text },
        },
    };
}

const neutral = {
    light: {
        primary: "#272724",
        primaryHover: "#44443f",
        primaryText: "#ffffff",
        menuBg: "#f1f1ed",
        menuText: "#272724",
        selectActiveBg: "#f7f7f5",
        selectSelectedBg: "#f1f1ed",
        selectText: "#272724",
        tableSelectedBg: "rgba(39, 39, 36, 0.04)",
        tableSelectedHoverBg: "rgba(39, 39, 36, 0.08)",
    },
    dark: {
        primary: "#eeefeb",
        primaryHover: "#d3d5ce",
        primaryText: "#222320",
        menuBg: "#2b2d27",
        menuText: "#eeefeb",
        selectActiveBg: "#2b2d27",
        selectSelectedBg: "#34362f",
        selectText: "#eeefeb",
        tableSelectedBg: "rgba(238, 239, 235, 0.06)",
        tableSelectedHoverBg: "rgba(238, 239, 235, 0.10)",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "trucreate-dark" : "trucreate-light" },
        token: {
            ...motionTokens,
            colorBgLayout: dark ? "#181918" : "#f7f7f5",
            colorBgContainer: dark ? "#222320" : "#ffffff",
            colorBgElevated: dark ? "#222320" : "#ffffff",
            colorBorder: dark ? "#43463e" : "#e0e0da",
            colorText: dark ? "#eeefeb" : "#272724",
            colorTextSecondary: dark ? "#a9aca1" : "#70706a",
            borderRadius: 8,
            borderRadiusLG: 12,
            controlHeight: 36,
            controlHeightSM: 32,
            controlHeightLG: 44,
            fontSize: 14,
            fontSizeSM: 13,
            motionDurationFast: "0.12s",
            motionDurationMid: "0.18s",
            motionDurationSlow: "0.24s",
            boxShadow: "0 4px 20px rgba(0,0,0,.10)",
            boxShadowSecondary: "0 16px 48px rgba(0,0,0,.16)",
            fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
            colorPrimary: color.primary,
            colorInfo: color.primary,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            colorTextLightSolid: color.primaryText,
        },
        components: {
            Button: {
                primaryShadow: "none",
            },
            Menu: {
                itemActiveBg: color.menuBg,
                itemHoverBg: color.menuBg,
                itemSelectedBg: color.menuBg,
                itemSelectedColor: color.menuText,
                darkItemHoverBg: neutral.dark.menuBg,
                darkItemSelectedBg: neutral.dark.menuBg,
                darkItemSelectedColor: neutral.dark.menuText,
            },
            Select: {
                optionActiveBg: color.selectActiveBg,
                optionSelectedBg: color.selectSelectedBg,
                optionSelectedColor: color.selectText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}
