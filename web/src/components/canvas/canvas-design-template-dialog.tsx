import { Button, Modal } from "antd";
import { canvasDesignTemplates, type CanvasDesignTemplateId } from "@/lib/canvas/canvas-design-templates";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasDesignTemplateDialog({ hasReference, onApply, onClose }: { hasReference: boolean; onApply: (id: CanvasDesignTemplateId) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    return <Modal open title="整套服装画布模板" footer={null} onCancel={onClose} width={640}>
        <p className="mb-4 text-sm opacity-70">{hasReference ? "使用所选图片作为共同参考，保留原图。" : "先创建参考图片节点，上传服装图后开始。"}每个模板新增 3 个可编辑生成配置及连线，分别点击配置中的“生成”才会调用模型。</p>
        <div className="space-y-3">{canvasDesignTemplates.map(template => <section key={template.id} className="rounded-lg border p-4" style={{ borderColor: theme.toolbar.border, color: theme.node.text }}>
            <h3 className="font-medium">{template.title}</h3><p className="my-2 text-sm">得到：{template.output}</p>
            <Button onClick={() => onApply(template.id)}>添加这套流程</Button>
        </section>)}</div>
        <p className="mt-4 text-xs opacity-60">3 个产物分别参考原图，不自动串联生成；要延续某一步结果，可将该结果图连到下一配置并在提示词中选用。添加模板可撤销。</p>
    </Modal>;
}
