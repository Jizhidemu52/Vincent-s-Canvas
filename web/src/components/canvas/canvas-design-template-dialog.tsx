import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Segmented } from "antd";
import localforage from "localforage";
import { canvasDesignTemplates, type CanvasDesignTemplateId, type CanvasDesignTemplateSteps } from "@/lib/canvas/canvas-design-templates";
import { createCanvasTemplateLibrary, validateTemplateContent, type PersonalCanvasTemplate } from "@/lib/canvas/canvas-template-library";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type TemplateCard = { id: string; baseTemplateId: CanvasDesignTemplateId; title: string; steps: CanvasDesignTemplateSteps; personal: boolean };
type Draft = Pick<TemplateCard, "title" | "steps">;

export function CanvasDesignTemplateDialog({ hasReference, onApply, onClose }: { hasReference: boolean; onApply: (id: CanvasDesignTemplateId, steps: CanvasDesignTemplateSteps, title?: string) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [ownerId] = useState(() => useUserStore.getState().user?.id);
    const [library] = useState(() => createCanvasTemplateLibrary(createWorkspaceStorage("canvas_design_templates", { driver: localforage.INDEXEDDB }), ownerId, () => useUserStore.getState().user?.id));
    const [tab, setTab] = useState("builtin");
    const [personal, setPersonal] = useState<PersonalCanvasTemplate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>({});
    const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
    const [saving, setSaving] = useState(false);
    const busy = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        const unsubscribe = useUserStore.subscribe(state => {
            if (state.user?.id !== ownerId) { setPersonal([]); setDrafts({}); onClose(); }
        });
        return () => { mounted.current = false; unsubscribe(); };
    }, [ownerId, onClose]);
    useEffect(() => {
        let active = true;
        setLoaded(false); setLoadError("");
        void library.list().then(value => { if (active) { setPersonal(value); setLoaded(true); } }).catch(error => {
            if (active) setLoadError(error instanceof Error ? error.message : "读取个人模板失败");
        });
        return () => { active = false; };
    }, [library, loadAttempt]);

    const cards: TemplateCard[] = tab === "mine" ? personal.map(item => ({ ...item, personal: true })) : canvasDesignTemplates.map(item => ({ ...item, baseTemplateId: item.id, personal: false }));
    const draftFor = (template: TemplateCard): Draft => drafts[template.id] ?? { title: template.personal ? template.title : `${template.title} · 自定义`, steps: template.steps };
    const change = (template: TemplateCard, patch: Partial<Draft>) => setDrafts(current => ({ ...current, [template.id]: { ...(current[template.id] ?? draftFor(template)), ...patch } }));
    const updateStep = (template: TemplateCard, index: number, field: 0 | 1, value: string) => {
        change(template, { steps: draftFor(template).steps.map((step, i) => i === index ? [field === 0 ? value : step[0], field === 1 ? value : step[1]] as const : step) });
    };
    const save = async (template: TemplateCard, copy = false) => {
        if (busy.current || !loaded) return;
        busy.current = true; setSaving(true); setNotice(null);
        try {
            const saved = await library.save({ ...draftFor(template), baseTemplateId: template.baseTemplateId, id: template.personal && !copy ? template.id : undefined });
            if (!mounted.current || useUserStore.getState().user?.id !== ownerId) return;
            setPersonal(current => [saved, ...current.filter(item => item.id !== saved.id)]);
            setDrafts(current => ({ ...current, [saved.id]: { title: saved.title, steps: saved.steps } }));
            setTab("mine"); setExpanded(saved.id);
            setNotice({ error: false, text: "已保存到我的模板，下次打开可以直接复用；当前没有生成图片。" });
        } catch (error) {
            if (mounted.current) setNotice({ error: true, text: `保存未成功，编辑内容已保留：${error instanceof Error ? error.message : "请检查浏览器存储后重试"}` });
        } finally { busy.current = false; if (mounted.current) setSaving(false); }
    };
    return <Modal open title="整套服装画布模板" footer={null} onCancel={onClose} width={640}>
        <p className="mb-3 text-sm opacity-70">{hasReference ? "使用所选图片作为共同参考，保留原图。" : "先创建参考图片节点，上传服装图后开始。"}每个模板新增 3 个可编辑生成配置及连线，分别点击配置中的“生成”才会调用模型。</p>
        <Segmented className="mb-3" value={tab} onChange={value => setTab(value)} options={[{ label: "内置模板", value: "builtin" }, { label: `我的模板${personal.length ? `（${personal.length}）` : ""}`, value: "mine" }]} />
        <p className="mb-4 text-xs opacity-60">我的模板按当前员工保存在本浏览器，刷新或重开后可复用；暂不跨设备同步。仅保存名称和提示词，不绑定这次的参考图片。</p>
        {notice ? <Alert className="!mb-3" type={notice.error ? "error" : "success"} title={notice.text} /> : null}
        {loadError ? <Alert className="!mb-3" type="error" title={`个人模板读取失败：${loadError}`} action={<Button size="small" onClick={() => setLoadAttempt(value => value + 1)}>重试读取</Button>} /> : null}
        {tab === "mine" && !personal.length ? <Empty description={loadError ? "读取失败，已有模板未修改" : loaded ? "还没有个人模板。先编辑一个内置流程，再保存为我的模板。" : "正在读取个人模板…"} /> : null}
        <div className="space-y-3">{cards.map(template => {
            const draft = draftFor(template);
            const steps = draft.steps;
            let validation = "";
            try { validateTemplateContent({ ...draft, baseTemplateId: template.baseTemplateId }); } catch (error) { validation = error instanceof Error ? error.message : "请填写完整内容"; }
            const invalid = Boolean(validation);
            const isExpanded = expanded === template.id;
            return <section key={template.id} data-template-id={template.id} className="rounded-lg border p-4" style={{ borderColor: theme.toolbar.border, color: theme.node.text }}>
                <h3 className="break-words font-medium">{template.title}</h3><p className="my-2 break-words text-sm">得到：参考款 → {steps.map(([title]) => title || "未命名步骤").join(" / ")}</p>
                <div className="flex flex-wrap gap-2">
                    <Button aria-expanded={isExpanded} aria-controls={`template-editor-${template.id}`} onClick={() => setExpanded(isExpanded ? null : template.id)}>{isExpanded ? "收起提示词" : "编辑流程提示词"}</Button>
                    <Button type="primary" disabled={invalid || saving} onClick={() => onApply(template.baseTemplateId, steps, template.personal ? draft.title : template.title)}>添加这套流程</Button>
                </div>
                {isExpanded ? <div id={`template-editor-${template.id}`} className="mt-4 space-y-4">
                    <div className="space-y-2"><label className="block text-sm" htmlFor={`${template.id}-name`}>模板名称</label><Input id={`${template.id}-name`} maxLength={80} value={draft.title} disabled={saving} onChange={event => change(template, { title: event.target.value })} /></div>
                    {steps.map(([title, prompt], index) => <div key={index} className="space-y-2">
                        <label className="block text-sm" htmlFor={`${template.id}-title-${index}`}>步骤 {index + 1} · 名称</label>
                        <Input id={`${template.id}-title-${index}`} maxLength={80} value={title} disabled={saving} status={!title.trim() ? "error" : undefined} onChange={event => updateStep(template, index, 0, event.target.value)} />
                        <label className="block text-sm" htmlFor={`${template.id}-prompt-${index}`}>步骤 {index + 1} · 提示词</label>
                        <Input.TextArea id={`${template.id}-prompt-${index}`} maxLength={12000} value={prompt} disabled={saving} autoSize={{ minRows: 3, maxRows: 8 }} status={!prompt.trim() ? "error" : undefined} onChange={event => updateStep(template, index, 1, event.target.value)} />
                    </div>)}
                    {invalid ? <p role="alert" className="text-sm">{validation}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="primary" loading={saving} disabled={invalid || !loaded || saving} onClick={() => void save(template)}>{template.personal ? "保存修改" : "保存为我的模板"}</Button>
                        {template.personal ? <Button disabled={invalid || !loaded || saving} onClick={() => void save(template, true)}>另存为新模板</Button> : null}
                        <Button disabled={saving} onClick={() => setDrafts(current => ({ ...current, [template.id]: undefined }))}>{template.personal ? "撤销未保存修改" : "恢复此模板默认内容"}</Button>
                        <Button disabled={invalid || saving} onClick={() => onApply(template.baseTemplateId, steps, draft.title)}>按当前内容添加</Button>
                    </div>
                    <p className="text-xs opacity-60">保存不会添加节点或调用模型；添加不会自动保存模板。更新模板不改变已经添加到画布的流程，关闭窗口会放弃未保存的修改。</p>
                </div> : null}
            </section>;
        })}</div>
        <p className="mt-4 text-xs opacity-60">3 个产物分别参考原图，不自动串联生成；要延续某一步结果，可将该结果图连到下一配置并在提示词中选用。添加模板可撤销。</p>
    </Modal>;
}
