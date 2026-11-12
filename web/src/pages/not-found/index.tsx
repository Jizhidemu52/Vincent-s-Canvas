import { uiText, useUiLocale } from "@/lib/i18n";
import { Home } from "lucide-react";
import { Link } from "react-router-dom";
import { InchoiceBrand } from "@/components/layout/inchoice-brand";
import { LanguageSwitch } from "@/components/layout/language-switch";

export default function NotFound() {
    useUiLocale();
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <header className="flex shrink-0 justify-end px-6 py-4"><LanguageSwitch /></header>
            <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground">
                <section className="w-full max-w-md text-center">
                    <div className="mb-8 flex justify-center"><InchoiceBrand className="!w-[220px]" /></div>
                    <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-xl border border-border bg-card text-2xl font-semibold">404</div>
                    <h1 className="text-3xl font-semibold tracking-normal">{uiText("页面不存在")}</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">{uiText("这个地址没有对应的页面，可能已经移动或被合并到其他入口。")}</p>
                    <div className="mt-8 flex flex-wrap justify-center gap-3">
                        <Link to="/" className="wb-primary-link">
                            <Home className="size-4" />
                            {uiText("返回首页")}</Link>
                    </div>
                </section>
            </main>
        </div>
    );
}
