import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import "./inchoice-brand.css";
import { useUiLocale } from "@/lib/i18n";

/** One AI-prepared silhouette keeps the brand identical in both color themes. */
export function InchoiceBrand({ className }: { className?: string }) {
    const theme = useThemeStore((state) => state.theme);
    const locale = useUiLocale();
    if (locale === "en-US") return <span className={cn("inchoice-brand-english", className)} style={{ color: canvasThemes[theme].node.text }}><span>Inchoice</span> TruCreate</span>;
    return <span role="img" aria-label="INCHOICE" className={cn("inchoice-brand", className)} style={{ color: canvasThemes[theme].node.text }} />;
}
