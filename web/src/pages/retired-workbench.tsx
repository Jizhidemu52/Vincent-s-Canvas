import { Link, useLocation } from "react-router-dom";
import { useUiText } from "@/lib/i18n";
import { retiredWorkbenchName } from "@/lib/retired-workbenches";

export default function RetiredWorkbenchPage() {
    const t = useUiText();
    const { pathname, search } = useLocation();
    const name = retiredWorkbenchName(pathname, search) || "该板块";
    return <main className="wb-page wb-empty h-full" aria-labelledby="retired-workbench-title">
        <h1 id="retired-workbench-title" className="wb-title">{t("{name}已下线", { name: t(name) })}</h1>
        <p>{t("此板块已移除。已有素材、任务和历史记录未删除，其他功能仍可正常使用。")}</p>
        <Link to="/" className="wb-primary-link">{t("返回工作台")}</Link>
    </main>;
}
