import { Alert, App, Button, Form, Input, InputNumber, Select, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { useUserStore } from "@/stores/use-user-store";
import { isLayerStudioPricingModel, LayerStudioPricingError, listLayerStudioPrices, saveLayerStudioPrice, validateLayerStudioPriceInput,
    type LayerStudioPrice, type LayerStudioPriceInput, type ServerModel, type ServerProvider } from "@/services/api/model-configuration";

/** The general per-model cost is not a substitute for these three explicit rates. */
export function LayerStudioPricingPanel({ models, providers, loading: modelsLoading }: { models: ServerModel[]; providers: ServerProvider[]; loading: boolean }) {
    const { message } = App.useApp();
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const allowed = user?.role === "super_admin" && status === "authenticated";
    const [form] = Form.useForm<Partial<LayerStudioPriceInput>>();
    const [prices, setPrices] = useState<LayerStudioPrice[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedRef = useRef(selectedId);
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [uncertain, setUncertain] = useState(false);
    const [error, setError] = useState("");
    const operation = useRef<AbortController | null>(null);
    const switching = useRef(false);
    const { confirmDiscard } = useUnsavedGuard(dirty, "图层专用费率尚未保存，离开或切换模型将丢失本次修改。");
    const eligible = models.filter(model => isLayerStudioPricingModel(model, providers));
    const selected = eligible.find(model => model.id === selectedId);
    const price = prices.find(item => item.modelConfigId === selectedId);
    const locked = !allowed || modelsLoading || loading || saving || !loaded || !selected;

    const setDraft = (id: string, records: LayerStudioPrice[]) => {
        selectedRef.current = id; setSelectedId(id);
        const current = records.find(item => item.modelConfigId === id);
        form.resetFields();
        // Missing input price is deliberately undefined, not a zero/free default.
        form.setFieldsValue({ inputRmb: current?.inputRmb, lowOutputRmb: current?.lowOutputRmb, highOutputRmb: current?.highOutputRmb, sourceNote: current?.sourceNote });
        setDirty(false); setUncertain(false); setError("");
    };
    const load = async (preserveDraft = false) => {
        if (!allowed || operation.current) return;
        const controller = new AbortController(); operation.current = controller;
        setLoading(true); setError("");
        try {
            const result = await listLayerStudioPrices(controller.signal);
            if (controller.signal.aborted) return;
            setPrices(result.prices); setLoaded(true); setUncertain(false);
            const id = selectedRef.current;
            if (id && !preserveDraft) setDraft(id, result.prices);
            else if (id && preserveDraft) {
                const current = result.prices.find(item => item.modelConfigId === id);
                try {
                    const draft = validateLayerStudioPriceInput(form.getFieldsValue());
                    if (current && JSON.stringify(draft) === JSON.stringify(validateLayerStudioPriceInput(current))) { setDirty(false); message.success("服务端已保存这些费率，无需重复提交。"); }
                    else message.info("已读取服务端当前费率版本；未保存的编辑内容仍保留，请核对后决定是否保存。");
                } catch { /* Incomplete typed values remain intact after a read. */ }
            }
        } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "费率读取失败。"); }
        finally { if (operation.current === controller) { operation.current = null; setLoading(false); } }
    };
    useEffect(() => {
        setSelectedId(null); selectedRef.current = null; setPrices([]); setLoaded(false); setLoading(false); setSaving(false); setDirty(false); setUncertain(false); setError("");
        form.resetFields(); void load();
        return () => { operation.current?.abort(); operation.current = null; };
    }, [allowed, user?.id]);
    useEffect(() => {
        if (loaded && !selectedRef.current && !modelsLoading && eligible[0]) setDraft(eligible[0].id, prices);
    }, [loaded, modelsLoading, eligible[0]?.id]);
    const changeModel = async (id: string) => {
        if (operation.current || switching.current || id === selectedRef.current || !eligible.some(model => model.id === id)) return;
        switching.current = true;
        try { if (await confirmDiscard() && useUserStore.getState().user?.id === user?.id && useUserStore.getState().status === "authenticated") setDraft(id, prices); }
        finally { switching.current = false; }
    };
    const save = async (values: Partial<LayerStudioPriceInput>) => {
        if (locked || operation.current || uncertain || !dirty || !selectedId) return;
        let input: LayerStudioPriceInput;
        try { input = validateLayerStudioPriceInput(values); }
        catch (caught) { setError(caught instanceof Error ? caught.message : "费率输入无效。"); return; }
        const id = selectedId;
        const controller = new AbortController(); operation.current = controller;
        setSaving(true); setError("");
        try {
            const { price: saved } = await saveLayerStudioPrice(id, input, controller.signal);
            if (controller.signal.aborted || selectedRef.current !== id) return;
            const next = [...prices.filter(item => item.modelConfigId !== id), saved];
            setPrices(next); setDraft(id, next);
            message.success("专用费率已保存，将用于新任务预扣估算；不是供应商实收证明。");
        } catch (caught) {
            if (!controller.signal.aborted) { setError(caught instanceof Error ? caught.message : "保存失败，编辑内容已保留。"); setUncertain(caught instanceof LayerStudioPricingError && caught.uncertain); }
        } finally { if (operation.current === controller) { operation.current = null; setSaving(false); } }
    };

    if (!allowed) return null;
    return <section className="wb-surface space-y-4 p-5" aria-label="图层专用费用配置">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">图层拆分与图片生成 · 专用费率</h3><Button loading={loading} disabled={saving} onClick={() => void load(dirty || uncertain)}>读取服务端配置</Button></div>
        <Alert type="info" showIcon title="分别配置输入与两档输出费用（人民币 / 张，最多 6 位小数）" description="只适用于 APIMart seedream-5-5 且未绑定工作流的模型。每张输入图计费；拆层按数量上限预扣，按实际输出图片及像素分档结算。上方通用成本字段不用于此专用预扣。这些配置用于上游成本估算，不是实际扣款或到账凭证，也不替代站内积分配置。" />
        {error && <Alert type="error" showIcon title={error} />}
        {!eligible.length && !modelsLoading ? <p className="text-sm text-muted-foreground">暂无符合条件的模型，请先在上方新增正确协议与模型 ID 的模型配置；此处不猜测或自动填写费率。</p> : <>
            <label className="block text-sm">费用配置模型<Select className="mt-2 w-full" aria-label="费用配置模型" value={selectedId} disabled={modelsLoading || loading || saving} onChange={id => void changeModel(id)} options={eligible.map(model => ({ value: model.id, label: `${model.name} · ${model.providerName} · ${model.modelId}` }))} /></label>
            <div className="flex flex-wrap items-center gap-2 text-xs"><Tag color={price ? "green" : "orange"}>{loaded ? price ? `已配置 · 版本 ${price.version}` : "未配置" : "读取中"}</Tag>{price && <span className="text-muted-foreground">服务端当前费率：输入 ¥{price.inputRmb} / 低档 ¥{price.lowOutputRmb} / 高档 ¥{price.highOutputRmb}</span>}{dirty && <Tag>有未保存修改</Tag>}</div>
            {selectedId && !selected && <Alert type="warning" title="当前模型条件已变化，暂停保存；编辑内容仍保留。" />}
            <Form name="layer-studio-price" form={form} layout="vertical" disabled={locked} onValuesChange={() => setDirty(true)} onFinish={save}>
                <div className="grid gap-3 md:grid-cols-3">
                    <Form.Item name="inputRmb" label="输入图单价（元 / 张）" extra="必须明确填写；确认免费时可填 0。" rules={[{ required: true, message: "请明确填写输入图单价，不默认免费。" }, { type: "number", min: 0, max: 1000, message: "范围为 0–1000 元。" }]}><InputNumber className="w-full" placeholder="待确认" min={0} max={1000} controls={false} /></Form.Item>
                    <Form.Item name="lowOutputRmb" label="低档输出单价（元 / 张）" extra="实际像素 ≤ 2,610,000。" rules={[{ required: true, message: "请填写低档输出单价。" }, { validator: (_, value) => typeof value === "number" && value > 0 && value <= 1000 ? Promise.resolve() : Promise.reject(new Error("输出单价必须大于 0 且不超过 1000 元。")) }]}><InputNumber className="w-full" placeholder="待确认" min={0} max={1000} controls={false} /></Form.Item>
                    <Form.Item name="highOutputRmb" label="高档输出单价（元 / 张）" extra="实际像素 > 2,610,000。" dependencies={["lowOutputRmb"]} rules={[{ required: true, message: "请填写高档输出单价。" }, { validator: (_, value) => typeof value === "number" && value > 0 && value <= 1000 && value >= (form.getFieldValue("lowOutputRmb") ?? 0) ? Promise.resolve() : Promise.reject(new Error("高档必须大于 0，且不能低于低档（上限 1000 元）。")) }]}><InputNumber className="w-full" placeholder="待确认" min={0} max={1000} controls={false} /></Form.Item>
                </div>
                <Form.Item name="sourceNote" label="费率确认依据" extra="填写渠道、确认日期或凭据说明；不要填 API Key。" rules={[{ required: true, whitespace: true, message: "请填写费率确认依据。" }, { max: 500, message: "依据不能超过 500 字。" }]}><Input.TextArea rows={2} maxLength={500} placeholder="说明费率的已确认来源，不要填推测价格" /></Form.Item>
                <Button type="primary" htmlType="submit" loading={saving} disabled={locked || !dirty || uncertain}>保存专用费率</Button>
                {uncertain && <p className="mt-2 text-xs text-muted-foreground">上次保存状态待核对。请先点击“读取服务端配置”；本页不会自动重复 PUT。</p>}
            </Form>
        </>}
    </section>;
}
