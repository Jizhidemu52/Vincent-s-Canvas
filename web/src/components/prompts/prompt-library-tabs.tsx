import { NavLink } from "react-router-dom";
import { useUiText } from "@/lib/i18n";

export function PromptLibraryTabs() {
    const t = useUiText();
    return <nav aria-label={t("提示词分类")} className="mb-6 flex gap-6 border-b border-border">
        {[{ to: "/prompts", label: "共享提示词" }, { to: "/my-prompts", label: "我的提示词" }].map(item => <NavLink key={item.to} to={item.to}
            className={({ isActive }) => `border-b-2 px-1 py-3 text-sm ${isActive ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{t(item.label)}</NavLink>)}
    </nav>;
}
