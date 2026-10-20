import { useEffect, useMemo, useRef, useState } from "react";
import { App, Modal, Select } from "antd";
import { useNavigate } from "react-router-dom";
import { canvasLibrarySummaries } from "@/lib/canvas/canvas-project-summary";
import { insertPromptIntoCanvas, PromptCanvasPersistenceError } from "@/lib/canvas/prompt-canvas-insertion";
import { createPromptActionGuard } from "@/lib/prompt-template-reuse";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function PromptCanvasDialog({ templateId, title, identity, onClose }: { templateId: string; title: string; identity: string; onClose: () => void }) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const projects = useCanvasStore(state => state.projects);
    const unloaded = useCanvasStore(state => state.unloadedProjects);
    const hydrated = useCanvasStore(state => state.hydrated);
    const options = useMemo(() => canvasLibrarySummaries(projects, unloaded).map(project => ({ value: project.id, label: project.title })), [projects, unloaded]);
    const [target, setTarget] = useState("");
    const [pending, setPending] = useState(false);
    const lock = useRef(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const close = () => { alive.current = false; onClose(); };
    const insert = async () => {
        if (lock.current) return;
        lock.current = true; setPending(true);
        const guard = createPromptActionGuard(identity, () => alive.current);
        try {
            const result = await insertPromptIntoCanvas(templateId, target || undefined, guard.assert);
            if (!guard.current()) return;
            result.warnings.forEach(warning => message.warning(warning));
            message.success("已保存可编辑提示词节点，可双击修改或撤销；未触发生成");
            navigate(`/canvas/${encodeURIComponent(result.projectId)}`);
            close();
        } catch (error) {
            if (!guard.current()) return;
            message.error(error instanceof Error ? error.message : "插入失败，请重试", 8);
            if (error instanceof PromptCanvasPersistenceError) {
                navigate(`/canvas/${encodeURIComponent(error.projectId)}`);
                close();
            }
        } finally {
            guard.dispose(); lock.current = false;
            if (alive.current) setPending(false);
        }
    };
    // Modal's confirmLoading ignores onCancel; keep cancellation available while fetching.
    return <Modal open title="插入到画布" okText="插入并打开画布" cancelText="取消" okButtonProps={{ disabled: !hydrated, loading: pending }} onOk={() => void insert()} onCancel={close} maskClosable={!pending}>
        <p className="mb-2 font-medium">{title}</p>
        <p className="mb-4 text-sm text-muted-foreground">添加完整、可编辑的提示词文字节点，保留模板来源与参数。不覆盖已有内容，不自动生成；参考图仅保留可访问的资产编号，不复制图片。</p>
        <Select aria-label="目标画布" className="w-full" value={target} onChange={setTarget} disabled={!hydrated || pending} loading={!hydrated} showSearch optionFilterProp="label" options={[{ value: "", label: "新建提示词草稿画布" }, ...options]} />
    </Modal>;
}
