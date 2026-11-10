import { uiText, useUiLocale } from "@/lib/i18n";
import type { CSSProperties } from "react";
import { Eye, Keyboard, Settings2 } from "lucide-react";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { deploymentFeatures } from "@/lib/deployment-features";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts }: UserStatusActionsProps) {
    useUiLocale();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const promptPreview = useConfigStore(state => state.config.promptPreview === true);
    const updateConfig = useConfigStore(state => state.updateConfig);
    const canManageConfig = useCanManageConfig();
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = variant === "canvas" ? "cw-icon [&_svg]:size-4" : "inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground transition hover:text-foreground [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => updateConfig("promptPreview", !promptPreview)} aria-pressed={promptPreview}
                aria-label={uiText(promptPreview ? "生成前确认：已开启" : "生成前确认：已关闭")} title={uiText(promptPreview ? "生成前确认已开启：固定板块编译后先核对再出图" : "开启生成前确认：固定板块编译后先核对再出图")}>
                <Eye className={promptPreview ? "size-4 text-primary" : "size-4"} />
            </button>
            {showConfig && canManageConfig && deploymentFeatures.rolePortalsEnabled ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={uiText("配置")} title={uiText("配置")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? uiText("切换到浅色主题") : uiText("切换到深色主题")} title={theme === "dark" ? uiText("切换到浅色主题") : uiText("切换到深色主题")} />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={uiText("快捷键")} title={uiText("快捷键")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}
