import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { uiText, useUiLocale } from "@/lib/i18n";

export function MobileOptions({ label, children }: { label: string; children: ReactNode }) {
    useUiLocale();
    const [open, setOpen] = useState(false);
    const id = useId();
    return <div className="mobile-options">
        <button type="button" aria-controls={id} aria-expanded={open} onClick={() => setOpen(value => !value)}>
            {uiText(label)}<ChevronDown size={16} aria-hidden="true" />
        </button>
        <div id={id} data-open={open}>{children}</div>
    </div>;
}

