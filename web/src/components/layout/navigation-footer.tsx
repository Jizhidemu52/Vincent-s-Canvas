import { LanguageSwitch } from "@/components/layout/language-switch";
import { PersonalSessionActions } from "@/components/layout/personal-session-actions";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { uiText, useUiLocale } from "@/lib/i18n";
import { ReleaseNotesNavigation } from "@/components/release-notes";
import { Eye, Info, Moon, Sun } from "lucide-react";
import { Popover, Tooltip } from "antd";
import { useConfigStore } from "@/stores/use-config-store";
import { UsageCollectionNotice } from "./frequent-navigation";

export function NavigationFooter({ onNavigate }: { onNavigate?: () => void }) {
    useUiLocale();
    const theme = useThemeStore(state => state.theme), setTheme = useThemeStore(state => state.setTheme);
    const cloudStatus = useCanvasStore(state => state.cloudStatus);
    const promptPreview = useConfigStore(state => state.config.promptPreview === true);
    const updateConfig = useConfigStore(state => state.updateConfig);
    const buttonClass = "wb-nav-link flex h-10 w-full items-center gap-2 rounded-lg px-3";
    const sync = cloudStatus === "synced" ? "画布已同步" : cloudStatus === "local" ? "画布保存在本机" : cloudStatus === "error" ? "画布同步异常，请返回画布查看" : "画布同步中";
    const information = <div className="wb-app max-w-[min(18rem,calc(100vw-48px))] space-y-3 p-2">
        <ReleaseNotesNavigation className={buttonClass} onNavigate={onNavigate} />
        <Tooltip title={uiText(promptPreview ? "生成前确认已开启：固定板块编译后先核对再出图" : "开启生成前确认：固定板块编译后先核对再出图")}><button type="button" className={buttonClass} onClick={() => updateConfig("promptPreview", !promptPreview)} aria-pressed={promptPreview}
            aria-label={uiText(promptPreview ? "生成前确认：已开启" : "生成前确认：已关闭")}>
            <Eye className={promptPreview ? "size-4 shrink-0 text-primary" : "size-4 shrink-0"} aria-hidden="true" />
            <span>{uiText(promptPreview ? "生成前确认：已开启" : "生成前确认：已关闭")}</span>
        </button></Tooltip>
        <p role="status" className="px-2 text-sm text-muted-foreground">{uiText(sync)}</p>
        <UsageCollectionNotice compact />
    </div>;
    return <div className="flex shrink-0 items-center justify-between gap-1 border-t border-border pt-3">
        <Tooltip title={uiText(theme === "dark" ? "切换到浅色主题" : "切换到深色主题")}><span className="inline-flex"><AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="wb-nav-link inline-flex size-9 items-center justify-center rounded-lg" aria-label={uiText(theme === "dark" ? "切换到浅色主题" : "切换到深色主题")}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</AnimatedThemeToggler></span></Tooltip>
        <LanguageSwitch compact className="wb-nav-link h-9 rounded-lg" />
        <Popover content={information} trigger="click" placement="top"><button type="button" className="wb-nav-link inline-flex size-9 items-center justify-center rounded-lg" aria-label={uiText("帮助与使用说明")}><Info size={18} /></button></Popover>
        <PersonalSessionActions compact onSignedOut={onNavigate} />
    </div>;
}
