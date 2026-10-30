import { LanguageSwitch } from "@/components/layout/language-switch";
import { PersonalSessionActions } from "@/components/layout/personal-session-actions";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { uiText, useUiLocale } from "@/lib/i18n";

export function NavigationFooter({ onNavigate }: { onNavigate?: () => void }) {
    useUiLocale();
    const theme = useThemeStore(state => state.theme), setTheme = useThemeStore(state => state.setTheme);
    const cloudStatus = useCanvasStore(state => state.cloudStatus);
    const buttonClass = "wb-nav-link flex h-10 w-full items-center gap-2 rounded-lg px-3";
    const sync = cloudStatus === "synced" ? "画布已同步" : cloudStatus === "local" ? "画布保存在本机" : cloudStatus === "error" ? "画布同步异常，请返回画布查看" : "画布同步中";
    return <div className="space-y-1 border-t border-border pt-3">
        <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={buttonClass} aria-label={uiText(theme === "dark" ? "切换到浅色主题" : "切换到深色主题")}><span>{uiText(theme === "dark" ? "黑夜模式" : "白天模式")}</span></AnimatedThemeToggler>
        <LanguageSwitch className={buttonClass} />
        <p role="status" className="px-3 text-xs text-muted-foreground">{uiText(sync)}</p>
        <PersonalSessionActions onSignedOut={onNavigate} />
    </div>;
}
