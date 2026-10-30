import { Alert, Button, Checkbox, Empty, Tag } from "antd";
import { ArrowDown, ArrowUp, RefreshCw, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
    getFeaturedModelConfiguration, saveFeaturedModelConfiguration,
    type FeaturedModelCandidate, type FeaturedModelConfiguration,
} from "@/services/api/model-configuration";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";

const modelName = (model: FeaturedModelCandidate) => model.publicName || model.name;
const isAvailable = (model: FeaturedModelCandidate) => model.enabled && model.providerEnabled;

export function HotModelOrderPanel({ isAdmin }: { isAdmin: boolean }) {
    const user = useUserStore(state => state.user);
    const allowed = isAdmin && user?.role === "super_admin";
    const refreshBusinessConfig = useBusinessConfigStore(state => state.refresh);
    const [configuration, setConfiguration] = useState<FeaturedModelConfiguration | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [notice, setNotice] = useState<{ type: "success" | "warning"; text: string } | null>(null);
    const operation = useRef<AbortController | null>(null);

    const load = useCallback(async () => {
        if (!allowed || operation.current) return;
        const controller = new AbortController();
        operation.current = controller;
        setLoading(true);
        setLoadError(null);
        setSaveError(null);
        setNotice(null);
        try {
            const next = await getFeaturedModelConfiguration(controller.signal);
            if (controller.signal.aborted) return;
            setConfiguration(next);
            setSelectedIds(next.featuredModelIds);
        } catch (error) {
            if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "热门模型加载失败，请重新加载。");
        } finally {
            if (operation.current === controller) { operation.current = null; setLoading(false); }
        }
    }, [allowed, user?.id]);

    useEffect(() => {
        setConfiguration(null);
        setSelectedIds([]);
        setLoading(false);
        setSaving(false);
        setLoadError(null);
        setSaveError(null);
        setNotice(null);
        void load();
        return () => { operation.current?.abort(); operation.current = null; };
    }, [load]);

    const models = configuration?.models || [];
    const maximum = configuration?.maxFeatured || 5;
    const dirty = Boolean(configuration && (selectedIds.length !== configuration.featuredModelIds.length
        || selectedIds.some((id, index) => id !== configuration.featuredModelIds[index])));
    useUnsavedGuard(dirty, "热门模型排序尚未保存，离开后将丢失本次修改。");
    const unavailableSelection = selectedIds.some(id => !models.some(model => model.id === id && isAvailable(model)));
    const locked = !allowed || loading || saving || !configuration || Boolean(loadError);

    const toggle = (id: string, checked: boolean) => {
        if (locked || operation.current) return;
        setSaveError(null);
        setNotice(null);
        setSelectedIds(current => checked
            ? current.includes(id) || current.length >= maximum || !models.some(model => model.id === id && isAvailable(model)) ? current : [...current, id]
            : current.filter(value => value !== id));
    };
    const move = (index: number, direction: -1 | 1) => {
        if (locked || operation.current) return;
        setSaveError(null);
        setNotice(null);
        setSelectedIds(current => {
            const target = index + direction;
            if (index < 0 || index >= current.length || target < 0 || target >= current.length) return current;
            const next = [...current];
            [next[index], next[target]] = [next[target]!, next[index]!];
            return next;
        });
    };
    const save = async () => {
        if (locked || operation.current || !dirty || unavailableSelection || selectedIds.length > maximum) return;
        const controller = new AbortController();
        operation.current = controller;
        setSaving(true);
        setSaveError(null);
        setNotice(null);
        try {
            const next = await saveFeaturedModelConfiguration([...selectedIds], controller.signal);
            if (controller.signal.aborted) return;
            setConfiguration(next);
            setSelectedIds(next.featuredModelIds);
            try {
                await refreshBusinessConfig();
                if (!controller.signal.aborted) setNotice({ type: "success", text: "热门模型与展示顺序已保存并同步到当前页面。" });
            } catch {
                if (!controller.signal.aborted) setNotice({ type: "warning", text: "热门模型已保存，但当前页面同步失败；重新加载画布即可获取新配置，无需重复保存。" });
            }
        } catch (error) {
            if (!controller.signal.aborted) setSaveError(error instanceof Error ? error.message : "保存失败，请检查后重试。");
        } finally {
            if (operation.current === controller) { operation.current = null; setSaving(false); }
        }
    };

    if (!allowed) return <Alert type="warning" showIcon title="仅超级管理员可配置热门模型" />;

    return <section className="space-y-4" aria-label="热门模型配置">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h3 className="flex items-center gap-2 text-base font-semibold"><Star className="size-4" />画布热门模型</h3>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">仅从 Mark（APIMart）图片接口中选择，最多 {maximum} 个。下方顺序就是画布热门区的展示顺序。</p>
            </div>
            <Button icon={<RefreshCw className="size-4" />} onClick={load} loading={loading} disabled={saving}>重新加载</Button>
        </div>
        <Alert type="info" showIcon title="只控制展示，不修改调用配置" description="其他接口的模型仍保留在“所有模型”中；此处不会变更模型价格、密钥、启用状态或板块绑定。取消全部选择并保存后，画布不再展示热门区。各入口只显示与当前功能兼容的已选模型。" />
        {loadError ? <Alert type="error" showIcon title="热门模型加载失败" description={loadError} /> : null}
        {saveError ? <Alert type="error" showIcon title="热门模型保存失败" description={saveError} /> : null}
        {notice ? <Alert type={notice.type} showIcon title={notice.text} /> : null}
        <div className="grid gap-4 lg:grid-cols-2">
            <div className="wb-surface min-w-0 p-4 sm:p-5">
                <h4 className="mb-3 text-sm font-semibold">可选 Mark 图片模型</h4>
                {loading && !configuration ? <p role="status" className="py-8 text-sm text-[var(--muted-foreground)]">正在加载模型…</p> : null}
                {!loading && !loadError && !models.length ? <Empty description="还没有 Mark 图片模型，请先在 APIMart 平台页完成配置。" /> : null}
                <div className="space-y-2">
                    {models.map(model => {
                        const selected = selectedIds.includes(model.id);
                        return <div key={model.id} className="rounded-lg border border-[var(--border)] p-3" data-featured-candidate={model.id}>
                            <Checkbox checked={selected} disabled={locked || (!selected && (!isAvailable(model) || selectedIds.length >= maximum))}
                                onChange={event => toggle(model.id, event.target.checked)} aria-label={`热门模型：${modelName(model)}`}>
                                <span className="break-words font-medium">{modelName(model)}</span>
                            </Checkbox>
                            <div className="ml-6 mt-1 flex flex-wrap items-center gap-1 text-xs text-[var(--muted-foreground)]">
                                {!model.providerEnabled ? <Tag color="warning">API 服务已停用</Tag> : !model.enabled ? <Tag>模型已停用</Tag> : <span>Mark 图片接口</span>}
                                {!model.hasCredentials ? <Tag color="warning">尚未配置密钥，不影响排序保存</Tag> : null}
                            </div>
                        </div>;
                    })}
                </div>
            </div>
            <div className="wb-surface min-w-0 p-4 sm:p-5">
                <div className="mb-3 flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">展示顺序 <span className="font-normal text-[var(--muted-foreground)]">{selectedIds.length} / {maximum}</span></h4>
                    {dirty ? <Tag color="warning">未保存</Tag> : null}
                </div>
                {!selectedIds.length ? <p className="rounded-lg border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">暂未选择热门模型。保存空列表后，仅保留“所有模型”。</p> : null}
                <ol className="space-y-2" aria-label="热门模型展示顺序">
                    {selectedIds.map((id, index) => {
                        const model = models.find(candidate => candidate.id === id);
                        const name = model ? modelName(model) : "已不可用的模型";
                        return <li key={id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2" data-featured-order={id}>
                            <span className="w-5 shrink-0 text-center text-sm tabular-nums text-[var(--muted-foreground)]">{index + 1}</span>
                            <span className="min-w-0 flex-1 break-words text-sm font-medium">{name}</span>
                            <div className="flex shrink-0 items-center gap-1">
                                <Button size="small" type="text" icon={<ArrowUp className="size-4" />} aria-label={`上移 ${name}`} title="上移" disabled={locked || index === 0} onClick={() => move(index, -1)} />
                                <Button size="small" type="text" icon={<ArrowDown className="size-4" />} aria-label={`下移 ${name}`} title="下移" disabled={locked || index === selectedIds.length - 1} onClick={() => move(index, 1)} />
                                <Button size="small" type="text" icon={<X className="size-4" />} aria-label={`移除 ${name}`} title="移除热门，不会删除模型" disabled={locked} onClick={() => toggle(id, false)} />
                            </div>
                        </li>;
                    })}
                </ol>
                {unavailableSelection ? <Alert className="mt-3" type="warning" showIcon title="请先移除不可用或已停用的模型，再保存。" /> : null}
                {selectedIds.length >= maximum ? <p className="mt-3 text-xs text-[var(--muted-foreground)]">已选满 {maximum} 个。若要更换，请先移除一个。</p> : null}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Button type="primary" loading={saving} disabled={locked || !dirty || unavailableSelection} onClick={save}>保存热门模型</Button>
                    {dirty ? <span className="text-xs text-[var(--muted-foreground)]">修改仅在保存后生效；重新加载会放弃未保存修改。</span> : null}
                </div>
            </div>
        </div>
    </section>;
}
