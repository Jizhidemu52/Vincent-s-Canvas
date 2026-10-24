import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Skeleton, Tabs, Tag } from "antd";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { useUserStore } from "@/stores/use-user-store";
import { getAdminPromptRecipe, listAdminPromptRecipes, requirePromptAdmin, type PromptAdminModel, type PromptRecipeDetail } from "@/services/api/admin-prompt-recipes";
import type { AdminPromptRecipe } from "../../../../../shared/prompt-contracts";
import { RecipeEditor } from "./components/recipe-editor";
import { RecipeTestPanel } from "./components/recipe-test-panel";
import { CompilationHistory } from "./components/compilation-history";
import { messageOf } from "./model";

export default function AdminPromptRecipesPage() {
    const user = useUserStore((state) => state.user);
    const status = useUserStore((state) => state.status);
    if (status !== "authenticated" || user?.role !== "super_admin" || user.status !== "active") {
        return (
            <div className="wb-page p-6">
                <Alert type="error" showIcon title="仅超级管理员可管理提示词配方" description="此页面不会向当前账号请求配方正文或测试诊断数据。" />
                <Link to="/admin">
                    <Button className="mt-4">返回管理中心</Button>
                </Link>
            </div>
        );
    }
    return <RecipeWorkspace key={user.id} ownerId={user.id} />;
}

function RecipeWorkspace({ ownerId }: { ownerId: string }) {
    const { modal } = App.useApp();
    const [recipes, setRecipes] = useState<AdminPromptRecipe[]>([]);
    const [models, setModels] = useState<PromptAdminModel[]>([]);
    const [selectedKey, setSelectedKey] = useState("");
    const [search, setSearch] = useState("");
    const [detail, setDetail] = useState<PromptRecipeDetail | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [detailLoading, setDetailLoading] = useState(false);
    const [retry, setRetry] = useState(0);
    const [dirty, setDirty] = useState(false);
    const controller = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            controller.current?.abort();
        };
    }, []);
    useEffect(() => {
        const abort = new AbortController();
        setLoading(true);
        setError("");
        void listAdminPromptRecipes({ expectedOwnerId: ownerId, signal: abort.signal })
            .then((result) => {
                if (abort.signal.aborted) return;
                setRecipes(result.recipes);
                setModels(result.models.filter((model) => model.enabled !== false));
                setSelectedKey((key) => key || result.recipes[0]?.key || "");
            })
            .catch((reason) => {
                if (!abort.signal.aborted) setError(messageOf(reason));
            })
            .finally(() => {
                if (!abort.signal.aborted) setLoading(false);
            });
        return () => abort.abort();
    }, [ownerId, retry]);

    const refresh = useCallback(async () => {
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        try {
            const result = await getAdminPromptRecipe(selectedKey, { expectedOwnerId: ownerId, signal: abort.signal });
            abort.signal.throwIfAborted();
            requirePromptAdmin(ownerId);
            if (!mounted.current) throw new DOMException("页面已关闭", "AbortError");
            setDetail(result);
            setRecipes((items) => items.map((recipe) => (recipe.key === result.recipe.key ? result.recipe : recipe)));
            setError("");
            return result;
        } finally {
            if (!abort.signal.aborted && mounted.current) setDetailLoading(false);
        }
    }, [selectedKey, ownerId]);
    useEffect(() => {
        setDetail(null);
        setDirty(false);
        if (!selectedKey) return;
        setDetailLoading(true);
        void refresh().catch((reason) => {
            if (!controller.current?.signal.aborted && mounted.current && !(reason instanceof DOMException && reason.name === "AbortError")) setError(messageOf(reason));
        });
        return () => controller.current?.abort();
    }, [selectedKey, refresh]);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault();
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const chooseRecipe = (key: string) => {
        if (key === selectedKey) return;
        if (dirty) modal.confirm({ title: "放弃未保存的配方修改？", content: "切换配方会丢弃编辑内容；已提交的测试不会被取消。", okText: "放弃并切换", cancelText: "继续编辑", onOk: () => setSelectedKey(key) });
        else setSelectedKey(key);
    };
    const selected = detail?.recipe;
    return (
        <div className="wb-page h-full overflow-y-auto">
            <main className="mx-auto flex w-full max-w-[1480px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
                <header className="wb-header !mb-0">
                    <div>
                        <div className="wb-eyebrow">管理工作台 / 提示词中台</div>
                        <h1 className="wb-title">提示词配方</h1>
                        <p className="wb-description">独立绑定优化模型，先存草稿、再测试、再激活。创作端只使用已激活版本。</p>
                    </div>
                    <Link to="/admin">
                        <Button icon={<ArrowLeft className="size-4" />}>返回管理中心</Button>
                    </Link>
                </header>
                {error && (
                    <Alert
                        type="error"
                        showIcon
                        title={error}
                        action={
                            <Button size="small" onClick={() => (selectedKey ? void refresh().catch((reason) => setError(messageOf(reason))) : setRetry((value) => value + 1))}>
                                重试读取
                            </Button>
                        }
                    />
                )}
                {loading ? (
                    <Skeleton active />
                ) : recipes.length === 0 ? (
                    <Empty description="暂无提示词配方" />
                ) : (
                    <div className="grid min-w-0 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
                        <aside className="wb-surface self-start p-3">
                            <label className="mb-2 block text-xs text-muted-foreground" htmlFor="recipe-filter">
                                查找场景配方 · {recipes.length}
                            </label>
                            <Input id="recipe-filter" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称或场景标识" allowClear />
                            <div className="mt-3 flex max-h-[65vh] flex-col gap-1 overflow-y-auto" role="list" aria-label="配方列表">
                                {recipes
                                    .filter((recipe) => `${recipe.name} ${recipe.key}`.toLowerCase().includes(search.toLowerCase()))
                                    .map((recipe) => (
                                        <button
                                            key={recipe.key}
                                            type="button"
                                            aria-current={selectedKey === recipe.key ? "true" : undefined}
                                            onClick={() => chooseRecipe(recipe.key)}
                                            className={`rounded-lg border px-3 py-3 text-left transition-colors ${selectedKey === recipe.key ? "border-primary bg-accent" : "border-transparent hover:bg-accent/60"}`}
                                        >
                                            <div className="flex items-center justify-between gap-2 text-sm font-medium">
                                                <span>{recipe.name}</span>
                                                <span className={`size-1.5 shrink-0 rounded-full ${recipe.enabled ? "bg-primary" : "bg-muted-foreground/40"}`} />
                                            </div>
                                            <div className="mt-1 break-all text-xs text-muted-foreground">{recipe.key}</div>
                                        </button>
                                    ))}
                            </div>
                        </aside>
                        <section className="min-w-0">
                            {detailLoading || !detail ? (
                                <Skeleton active />
                            ) : (
                                <>
                                    <div className="wb-surface mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
                                        <div>
                                            <h2 className="text-lg font-semibold">{selected?.name}</h2>
                                            <div className="mt-1 flex flex-wrap gap-1">
                                                <Tag color={selected?.enabled ? "green" : "default"}>{selected?.enabled ? "已启用" : "已停用"}</Tag>
                                                <Tag>{detail.versions.find((version) => version.id === selected?.currentVersionId) ? `线上 v${detail.versions.find((version) => version.id === selected?.currentVersionId)!.version}` : "尚未激活"}</Tag>
                                                {dirty && <Tag color="orange">有未保存修改</Tag>}
                                            </div>
                                        </div>
                                        <Button icon={<RefreshCw className="size-4" />} disabled={dirty} onClick={() => void refresh().catch((reason) => setError(messageOf(reason)))}>
                                            刷新记录
                                        </Button>
                                    </div>
                                    <Tabs
                                        key={selectedKey}
                                        defaultActiveKey="edit"
                                        items={[
                                            { key: "edit", label: "配方与版本", children: <RecipeEditor detail={detail} models={models} refresh={refresh} onDirty={setDirty} /> },
                                            { key: "test", label: "测试与对比", children: <RecipeTestPanel detail={detail} models={models} refresh={refresh} editorDirty={dirty} /> },
                                            { key: "history", label: "统计与记录", children: <CompilationHistory detail={detail} /> },
                                        ]}
                                    />
                                </>
                            )}
                        </section>
                    </div>
                )}
            </main>
        </div>
    );
}
