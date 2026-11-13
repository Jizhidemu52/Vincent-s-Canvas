import { staticUiText } from "@/lib/static-ui-copy";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import "./inchoice-brand.css";
import { useUiLocale } from "@/lib/i18n";

/** Shared product wordmark for navigation, sign-in and the canvas. */
export function InchoiceBrand({ className }: { className?: string }) {
    const theme = useThemeStore((state) => state.theme);
    const locale = useUiLocale();
    return <span className={cn("inchoice-brand", className)} style={{ color: canvasThemes[theme].node.text }}>
        <span className="inchoice-brand-name">TruCreate</span>
        <span className="inchoice-brand-caption">{locale === "en-US" ? "Ideas Come True." : staticUiText("AI 创意设计平台")}</span>
    </span>;
}
