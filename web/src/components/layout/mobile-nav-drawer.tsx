import { uiText, useUiLocale } from "@/lib/i18n";
import { Drawer } from "antd";
import { useState } from "react";
import { Search } from "lucide-react";
import { NavigationMenu } from "@/components/layout/navigation-menu";
import { NavigationFooter } from "@/components/layout/navigation-footer";
import type { NavigationToolSlug } from "@/constant/navigation-tools";

export function MobileNavDrawer({ open, onClose }: { open: boolean; activeToolSlug?: NavigationToolSlug; onClose: () => void }) {
    useUiLocale();
    const [query, setQuery] = useState("");
    const close = () => { setQuery(""); onClose(); };
    return <Drawer title={uiText("功能模块")} placement="left" size="min(100vw, 420px)" open={open} onClose={close} className="md:hidden">
        <div className="wb-app mobile-tool-directory space-y-4">
            <label className="sticky top-0 z-10 flex min-h-11 items-center gap-2 rounded-lg border bg-card px-3"><Search size={17} /><input type="search" className="min-w-0 flex-1 bg-transparent py-2" aria-label={uiText("搜索工具")} placeholder={uiText("搜索工具")} value={query} onChange={event => setQuery(event.target.value)} /></label>
            <nav aria-label={uiText("主导航")}><NavigationMenu searchText={query} onNavigate={close} /></nav>
            {!query && <NavigationFooter onNavigate={close} />}
        </div>
    </Drawer>;
}
