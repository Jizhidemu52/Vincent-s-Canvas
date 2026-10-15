import { App, Input, Select, Switch, Tag } from "antd";
import { useEffect, useState } from "react";

import { moduleDefinitions, nonAiDefinitions, toolDefinitions, updateModuleFlag, type ModuleKey } from "@/services/api/modules";
import { useModuleStore } from "@/stores/use-module-store";

const groups = Array.from(new Set(moduleDefinitions.map((module) => module.group)));
const kindLabels = { ai: "AI · 需配置 API", local: "本地工具 · 无需 API", external: "模型本机配置", service: "无需模型 API", group: "总入口" };

export function ModuleSwitchPanel() {
    const { message } = App.useApp();
    const flags = useModuleStore((state) => state.flags);
    const refresh = useModuleStore((state) => state.refresh);
    const setFlag = useModuleStore((state) => state.setFlag);
    const [saving, setSaving] = useState<ModuleKey | null>(null);
    const [search, setSearch] = useState("");
    const [kind, setKind] = useState("all");

    useEffect(() => { void refresh().catch((error) => message.error(error instanceof Error ? error.message : "模块状态读取失败")); }, [message, refresh]);

    const toggle = async (moduleKey: ModuleKey, enabled: boolean) => {
        setSaving(moduleKey);
        try {
            const { module } = await updateModuleFlag(moduleKey, enabled);
            setFlag(module);
            message.success(`${moduleDefinitions.find((item) => item.moduleKey === moduleKey)?.label}已${enabled ? "开启" : "关闭"}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模块状态更新失败");
        } finally { setSaving(null); }
    };
    const filtered = moduleDefinitions.filter((module) => (kind === "all" || (kind === "ai" ? module.kind === "ai" : module.kind !== "ai"))
        && `${module.label} ${module.moduleKey} ${module.group} ${module.description}`.toLowerCase().includes(search.trim().toLowerCase()));

    return <div className="space-y-4">
        <div className="wb-surface px-4 py-3">
            <h2 className="text-base font-semibold">功能模块开关 · {moduleDefinitions.length} 项正式能力</h2>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{toolDefinitions.length} 项 AI + {nonAiDefinitions.length} 项非 AI。关闭后拦截入口与新操作，不删除历史、素材或后台配置。父级入口关闭时，子模块开关仍保留；重新开启父级即可恢复原设置。</p>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">AI 模块还受“板块 API 配置”中的独立开关约束；本地工具无需 API。本机 Agent 的模型在本机配置。尚未接通的画布 AI 超分不在正式清单中。</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
                <Input className="!w-full sm:!w-80" value={search} onChange={(event) => setSearch(event.target.value)} allowClear placeholder="搜索模块名称或功能" aria-label="搜索功能模块" />
                <Select className="!w-44" value={kind} onChange={setKind} aria-label="模块类型" options={[{ value: "all", label: "全部正式模块" }, { value: "ai", label: `AI 模块（${toolDefinitions.length}）` }, { value: "non-ai", label: `非 AI 模块（${nonAiDefinitions.length}）` }]} />
                <span className="text-xs text-[var(--muted-foreground)]">显示 {filtered.length} / {moduleDefinitions.length} 项</span>
            </div>
        </div>
        {groups.filter((group) => filtered.some((module) => module.group === group)).map((group) => <section key={group} className="wb-surface overflow-hidden">
            <h3 className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold">{group}</h3>
            <div className="divide-y divide-[var(--border)]">
                {filtered.filter((module) => module.group === group).map((module) => <div key={module.moduleKey} className="flex min-h-16 items-center justify-between gap-4 px-4 py-3" data-module-key={module.moduleKey}>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--foreground)]">{module.label}<Tag>{kindLabels[module.kind]}</Tag>{module.parent && !flags[module.parent] ? <Tag color="orange">所属总入口已关闭</Tag> : null}</div>
                        <div className="mt-1 text-xs text-[var(--muted-foreground)]">{module.description}</div>
                    </div>
                    <Switch checked={flags[module.moduleKey]} loading={saving === module.moduleKey} disabled={saving !== null && saving !== module.moduleKey} onChange={(enabled) => void toggle(module.moduleKey, enabled)} aria-label={`${module.label}开关`} />
                </div>)}
            </div>
        </section>)}
        {!filtered.length ? <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">没有匹配的正式模块</p> : null}
    </div>;
}
