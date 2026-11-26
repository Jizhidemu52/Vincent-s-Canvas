import { uiText, useUiLocale } from "@/lib/i18n";

export type WorkbenchPane = "form" | "results";

export function MobileWorkbenchSwitch({ pane, onChange }: { pane: WorkbenchPane; onChange: (pane: WorkbenchPane) => void }) {
    useUiLocale();
    return <nav aria-label={uiText("工作区视图")} className="mobile-workbench-switch">
        {(["form", "results"] as const).map(value => <button type="button" key={value} aria-pressed={pane === value} onClick={() => onChange(value)}>
            {uiText(value === "form" ? "创作" : "查看结果")}
        </button>)}
    </nav>;
}
