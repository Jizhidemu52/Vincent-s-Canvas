import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

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
