import { uiText, useUiLocale } from "@/lib/i18n";
import { Drawer } from "antd";
import { Link } from "react-router-dom";
import { UsageCollectionNotice } from "@/components/layout/frequent-navigation";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { NavigationMenu } from "@/components/layout/navigation-menu";
import { NavigationFooter } from "@/components/layout/navigation-footer";
import type { NavigationToolSlug } from "@/constant/navigation-tools";

export function MobileNavDrawer({ open, onClose }: { open: boolean; activeToolSlug?: NavigationToolSlug; onClose: () => void }) {
    useUiLocale();
    return <Drawer title={uiText("功能模块")} placement="left" size={300} open={open} onClose={onClose} className="md:hidden">
        <div className="wb-app space-y-6">
            <Link to="/" onClick={onClose} className="block text-foreground" aria-label={uiText("INCHOICE · 无限画布首页")}><InchoiceBrand /></Link>
            <nav aria-label={uiText("主导航")}><NavigationMenu onNavigate={onClose} /></nav>
            <NavigationFooter onNavigate={onClose} />
            <UsageCollectionNotice />
        </div>
    </Drawer>;
}
