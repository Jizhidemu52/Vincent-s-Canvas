import { Link, useLocation } from "react-router-dom";
import { useUiText } from "@/lib/i18n";
import { retiredWorkbenchName } from "@/lib/retired-workbenches";
import { GenerationAccountHistory } from "@/components/generation-account-history";

export default function RetiredWorkbenchPage() {
    const t = useUiText();
    const { pathname, search } = useLocation();
    const name = retiredWorkbenchName(pathname, search) || "该板块";
    const recipe = pathname === "/creative/series-recipe" || pathname === "/series-recipe";
    return <main className={recipe ? "wb-page h-full overflow-y-auto p-6 text-center" : "wb-page wb-empty h-full"} aria-labelledby="retired-workbench-title">
        <h1 id="retired-workbench-title" className="wb-title">{t("{name}已下线", { name: t(name) })}</h1>
        <p>{t("此板块已移除。已有素材、任务和历史记录未删除，其他功能仍可正常使用。")}</p>
        <Link to="/" className="wb-primary-link">{t("返回工作台")}</Link>
        {recipe && <div className="mx-auto mt-8 w-full max-w-3xl text-left">
            <p className="mb-4 text-sm text-muted-foreground">{t("系列配方已下线；这里只读查看此前提交的任务与原成果，不恢复编辑或生成。")}</p>
            <GenerationAccountHistory board="series-recipe" />
        </div>}
    </main>;
}
