import { LanguageSwitch } from "@/components/layout/language-switch";
import { PersonalSessionActions } from "@/components/layout/personal-session-actions";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { uiText, useUiLocale } from "@/lib/i18n";
import { ReleaseNotesNavigation } from "@/components/release-notes";
import { Eye } from "lucide-react";
import { useConfigStore } from "@/stores/use-config-store";

export function NavigationFooter({ onNavigate }: { onNavigate?: () => void }) {
    useUiLocale();
    const theme = useThemeStore(state => state.theme), setTheme = useThemeStore(state => state.setTheme);
    const cloudStatus = useCanvasStore(state => state.cloudStatus);
    const promptPreview = useConfigStore(state => state.config.promptPreview === true);
    const updateConfig = useConfigStore(state => state.updateConfig);
    const buttonClass = "wb-nav-link flex h-10 w-full items-center gap-2 rounded-lg px-3";
    const sync = cloudStatus === "synced" ? "画布已同步" : cloudStatus === "local" ? "画布保存在本机" : cloudStatus === "error" ? "画布同步异常，请返回画布查看" : "画布同步中";
    return <div className="space-y-1 border-t border-border pt-3">
        <ReleaseNotesNavigation className={buttonClass} onNavigate={onNavigate} />
        <button type="button" className={buttonClass} onClick={() => updateConfig("promptPreview", !promptPreview)} aria-pressed={promptPreview}
            aria-label={uiText(promptPreview ? "生成前确认：已开启" : "生成前确认：已关闭")} title={uiText(promptPreview ? "生成前确认已开启：固定板块编译后先核对再出图" : "开启生成前确认：固定板块编译后先核对再出图")}>
            <Eye className={promptPreview ? "size-4 shrink-0 text-primary" : "size-4 shrink-0"} aria-hidden="true" />
            <span>{uiText(promptPreview ? "生成前确认：已开启" : "生成前确认：已关闭")}</span>
        </button>
        <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={buttonClass} aria-label={uiText(theme === "dark" ? "切换到浅色主题" : "切换到深色主题")}><span>{uiText(theme === "dark" ? "黑夜模式" : "白天模式")}</span></AnimatedThemeToggler>
        <LanguageSwitch className={buttonClass} />
        <p role="status" className="px-3 text-xs text-muted-foreground">{uiText(sync)}</p>
        <PersonalSessionActions onSignedOut={onNavigate} />
    </div>;
}
