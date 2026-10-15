import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";
import { canvasThemes, type CanvasColorTheme } from "./canvas-theme";

/** Canvas controls also render in portals: scope their neutral theme in context. */
export function getCanvasAntThemeConfig(mode: CanvasColorTheme): ThemeConfig {
    const colors = canvasThemes[mode];
    return {
        inherit: false,
        algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: `canvas-workspace-${mode}` },
        token: {
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
            borderRadius: 6,
            borderRadiusLG: 10,
            controlHeight: 32,
            fontSize: 12,
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

const orange = {
    light: {
        primary: "#ea580c",
        primaryHover: "#c2410c",
        primaryText: "#ffffff",
        menuBg: "#ffedd5",
        menuText: "#7c2d12",
        selectActiveBg: "#fff7ed",
        selectSelectedBg: "#ffedd5",
        selectText: "#7c2d12",
        tableSelectedBg: "rgba(234, 88, 12, 0.08)",
        tableSelectedHoverBg: "rgba(234, 88, 12, 0.14)",
    },
    dark: {
        primary: "#fb923c",
        primaryHover: "#fdba74",
        primaryText: "#1c1208",
        menuBg: "#431407",
        menuText: "#ffedd5",
        selectActiveBg: "#431407",
        selectSelectedBg: "#5f1d08",
        selectText: "#ffedd5",
        tableSelectedBg: "rgba(251, 146, 60, 0.14)",
        tableSelectedHoverBg: "rgba(251, 146, 60, 0.2)",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? orange.dark : orange.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "orange-canvas-dark" : "orange-canvas-light" },
        token: {
            colorBgLayout: dark ? "#181918" : "#f7f7f5",
            colorBgContainer: dark ? "#222320" : "#ffffff",
            colorBgElevated: dark ? "#222320" : "#ffffff",
            colorBorder: dark ? "#43463e" : "#e0e0da",
            colorText: dark ? "#eeefeb" : "#272724",
            colorTextSecondary: dark ? "#a9aca1" : "#70706a",
            borderRadius: 10,
            controlHeight: 36,
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
                darkItemHoverBg: orange.dark.menuBg,
                darkItemSelectedBg: orange.dark.menuBg,
                darkItemSelectedColor: orange.dark.menuText,
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
