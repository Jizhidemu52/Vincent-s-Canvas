import { useUiText } from "@/lib/i18n";
import { useState } from "react";
import { Button, Input, Modal, Tag, Select } from "antd";
import { ArrowDown, Plus, Trash2 } from "lucide-react";
import { defaultImageSequenceSteps, imageSequencePrompt, imageSequenceStepTypes, type ImageSequenceStep, type WorkflowStepType } from "@/lib/canvas/canvas-image-sequence";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeGroup, Position } from "@/types/canvas";
import type { useCanvasImageSequence } from "@/pages/canvas/use-canvas-image-sequence";

type Props = {
    controller: ReturnType<typeof useCanvasImageSequence>;
    groups: CanvasNodeGroup[];
    nodes: CanvasNodeData[];
    model: string;
    onFocus: (position: Position, width: number, height: number) => void;
    onEditConfig: (id: string) => void;
    onPromptChange: (id: string, prompt: string) => void;
};
export function CanvasImageSequenceDialog({ controller, groups, nodes, model, onFocus, onEditConfig, onPromptChange }: Props) {
    const t = useUiText();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [drafts, setDrafts] = useState(() => defaultImageSequenceSteps.map(step => [...step] as ImageSequenceStep));
    const dialog = controller.dialog;
    const group = groups.find(item => item.id === (dialog && "groupId" in dialog ? dialog.groupId : undefined));
    const source = nodes.find(item => item.id === (dialog && "sourceId" in dialog ? dialog.sourceId : group?.imageSequence?.sourceNodeId));
    const running = Boolean(group && controller.activeGroupId === group.id);
    const onClose = () => controller.setDialog(null);
    const focus = (node?: CanvasNodeData) => { if (node) onFocus(node.position, node.width, node.height); };
    const onCreate = async (steps: ImageSequenceStep[]) => { if (source) focus(await controller.add(source.id, steps, model)); };
    const onRun = () => { if (group) void controller.run(group.id); };
    const sequence = group?.imageSequence;
    const completed = sequence?.steps.filter(step => step.status === "success").length || 0;
    const change = (index: number, field: 0 | 1, value: string) => setDrafts(items => items.map((item, i) => i === index ? [field === 0 ? value : item[0], field === 1 ? value : item[1], item[2]] : item));
    const cards = sequence ? sequence.steps.map(step => { const node = nodes.find(item => item.id === step.configNodeId); return { title: node?.title || "配置已移除", prompt: node ? imageSequencePrompt(node) : "", node, step }; }) : drafts.map(([title, prompt]) => ({ title, prompt, node: undefined, step: undefined }));
    return <Modal open title={sequence ? t("图片工作流 · 运行记录") : t("快速搭建图片工作流")} width={660} style={{ top: 24 }} styles={{ body: { display: "flex", flexDirection: "column", maxHeight: "calc(100dvh - 160px)" } }} onCancel={onClose} footer={null}>
        <p className="mb-3 shrink-0 text-sm opacity-70">{t("原图：")}{source?.title || t("原图已移除")}{t("。在画布上连接配置节点来决定执行顺序；每步自动使用其上游结果。此处只用于快捷搭建或查看记录，最终以画布连线为准。")}</p>
        <div role="note" className="mb-4 shrink-0 rounded-lg border p-3 text-xs leading-relaxed" style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }}><p className="mb-1 font-medium">{t("请保持此画布页面打开")}</p>{t("每一步会单独调用模型并计费。关闭弹窗不会停止；刷新、关闭或离开画布后不会继续提交后续步骤。停止不保证撤销已提交的服务端任务。")}</div>
        {sequence?.error ? <p role="alert" className="mb-3 max-h-24 shrink-0 overflow-y-auto rounded-lg border p-3 text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>{t("流程已暂停：")}{sequence.error}</p> : null}
        {sequence ? <p role="status" className="mb-3 shrink-0 text-sm">{running ? t("正在按顺序执行") : sequence.status === "success" ? t("全部完成") : sequence.status === "idle" ? t("尚未开始") : t("已暂停，可核查后继续")} {t(" · 已完成")}{completed}/{sequence.steps.length} {t(" 步")}</p> : null}
        <div className="min-h-0 max-h-[55vh] space-y-3 overflow-y-auto pr-1">{cards.map((card, index) => <section key={card.step?.configNodeId || index} className="rounded-lg border p-3" style={{ borderColor: theme.toolbar.border }}>
            <div className="mb-2 flex items-center gap-2">
                <span className="shrink-0 text-sm">{index + 1}</span>
                {sequence ? <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span> : <Input aria-label={t("步骤 {value1} 名称", { value1: index + 1 })} value={card.title} maxLength={80} onChange={event => change(index, 0, event.target.value)} />}
                {card.step ? <Tag>{card.step.status === "success" ? t("已完成") : card.step.status === "running" ? running ? t("执行中") : t("待核查") : card.step.status === "failed" ? t("失败") : t("待执行")}</Tag> : <Button type="text" aria-label={t("删除步骤 {value1}", { value1: index + 1 })} icon={<Trash2 size={15} />} disabled={drafts.length === 1} onClick={() => setDrafts(items => items.filter((_, i) => i !== index))} />}
            </div>
            {!sequence ? <Select aria-label={t("步骤 {value1} 类型", { value1: index + 1 })} className="mb-2 w-full" value={drafts[index]?.[2] || "custom"} options={imageSequenceStepTypes} onChange={(value: WorkflowStepType) => setDrafts(items => items.map((item, i) => i === index ? [item[0], item[1], value] : item))} /> : null}
            <Input.TextArea aria-label={t("步骤 {value1} 提示词", { value1: index + 1 })} autoSize={{ minRows: 2, maxRows: 5 }} maxLength={12000} value={card.prompt} readOnly={running || card.step?.status === "success" || card.step?.status === "running"} onChange={event => card.node ? onPromptChange(card.node.id, event.target.value) : change(index, 1, event.target.value)} />
            {card.node ? <div className="mt-2 flex items-center justify-between gap-2 text-xs opacity-75"><span>{t("沿用此步骤的生成配置")}</span><Button size="small" disabled={running || card.step?.status === "success" || card.step?.status === "running"} onClick={() => { onClose(); onEditConfig(card.node!.id); focus(card.node); }}>{t("模型与尺寸设置")}</Button></div> : null}
            {!sequence && index < cards.length - 1 ? <div className="mt-2 flex items-center gap-1 text-xs opacity-60"><ArrowDown size={12} /> {t(" 创建节点间的工作流连线")}</div> : null}
        </section>)}</div>
        <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-2">
            {!sequence ? <Button icon={<Plus size={14} />} disabled={drafts.length >= 10} onClick={() => setDrafts(items => [...items, ["新步骤", "", "custom"]])}>{t("添加步骤")}</Button> : <span className="text-xs opacity-60">{t("继续只执行未完成步骤；已完成图片不会重跑。")}</span>}
            {!sequence ? <Button type="primary" disabled={!source || drafts.some(([title, prompt]) => !title.trim() || !prompt.trim())} onClick={() => onCreate(drafts)}>{t("创建并连接节点")}</Button>
                : running ? <Button danger onClick={controller.stop}>{t("停止后续步骤")}</Button>
                    : <Button type="primary" disabled={!source || cards.some(card => !card.node || !card.prompt.trim())} onClick={onRun}>{sequence.status === "success" ? t("按连线重新运行") : sequence.status === "idle" ? t("按连线运行") : t("核查并继续")}</Button>}
        </div>
    </Modal>;
}
