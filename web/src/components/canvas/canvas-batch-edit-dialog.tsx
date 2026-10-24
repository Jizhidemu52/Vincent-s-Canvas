import type { Dispatch, SetStateAction } from "react";
import { Button, Input, Modal, Tag, theme as antdTheme } from "antd";
import { Pause, Play, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { useToolConfig } from "@/hooks/use-tool-config";
import { canvasThemes } from "@/lib/canvas-theme";
import type { BatchEditFileItem } from "@/pages/canvas/canvas-batch-edit-runtime";
import type { QueuedBatchAction } from "@/services/api/generation-tasks";
import { useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasBatchEditDialogProps = {
    open: boolean;
    running: boolean;
    prompt: string;
    items: BatchEditFileItem[];
    imageSettings: Partial<AiConfig>;
    serverId: string | null;
    action: QueuedBatchAction | null;
    onClose: () => void;
    onPromptChange: (prompt: string) => void;
    onImageSettingsChange: Dispatch<SetStateAction<Partial<AiConfig>>>;
    onSelectFiles: () => void;
    onClearItems: () => void;
    onRun: () => Promise<void> | void;
    onControlBatch: (action: QueuedBatchAction) => Promise<void> | void;
};

/** The editor owns the batch lifecycle; this chunk contains only its dialog UI. */
export default function CanvasBatchEditDialog({
    open, running, prompt, items, imageSettings, serverId, action,
    onClose, onPromptChange, onImageSettingsChange, onSelectFiles, onClearItems, onRun, onControlBatch,
}: CanvasBatchEditDialogProps) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const { token } = antdTheme.useToken();
    const effectiveConfig = useEffectiveConfig();
    const config = useToolConfig({ ...effectiveConfig, ...imageSettings, model: imageSettings.model || effectiveConfig.imageModel || effectiveConfig.model, count: "1" }, "canvas-batch");
    return (
        <Modal
            title="批量一键改图"
            open={open}
            width={760}
            onCancel={() => { if (!running) onClose(); }}
            footer={
                <>
                    <Button disabled={running} onClick={onClose}>关闭</Button>
                    <Button type="primary" loading={running} onClick={() => void onRun()}>一键生图</Button>
                </>
            }
        >
            <div className="space-y-4">
                <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke, background: theme.node.fill, color: theme.node.text }}>可多选 1–100 张图片，每张独立生成 1 张结果，原图保留。</div>
                <fieldset disabled={running} className="space-y-2 border-0 p-0">
                    <ModelPicker toolKey="canvas-batch" config={config} value={config.model} capability="image" fullWidth disabled={running}
                        onChange={model => onImageSettingsChange(current => ({ ...current, model, imageModel: model }))} />
                    <ImageSettingsPanel config={config} referenceCount={items.length ? 1 : 0} theme={theme} maxCount={1} showTitle={false}
                        onConfigChange={(key, value) => onImageSettingsChange(current => ({ ...current, [key]: value }))} />
                </fieldset>
                <div className="flex flex-wrap gap-2">
                    <Button onClick={onSelectFiles} disabled={running}>选择图片（可多选）</Button>
                    <Button disabled={running || !items.length} onClick={onClearItems}>清空列表</Button>
                </div>
                {serverId && running ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                        <span className="mr-auto text-xs" style={{ color: theme.node.muted }}>服务端批次 {serverId.slice(0, 8)}</span>
                        <Button size="small" icon={<Pause className="size-4" />} loading={action === "pause"}
                            disabled={Boolean(action) || !items.some(item => item.status === "waiting")}
                            onClick={() => void onControlBatch("pause")}>暂停等待项</Button>
                        <Button size="small" icon={<Play className="size-4" />} loading={action === "resume"}
                            disabled={Boolean(action) || !items.some(item => item.status === "paused")}
                            onClick={() => void onControlBatch("resume")}>恢复</Button>
                        <Button size="small" danger icon={<X className="size-4" />} loading={action === "cancel"}
                            disabled={Boolean(action) || !items.some(item => item.status === "waiting" || item.status === "paused")}
                            onClick={() => void onControlBatch("cancel")}>取消未处理项</Button>
                    </div>
                ) : null}
                <Input.TextArea value={prompt} onChange={event => onPromptChange(event.target.value)} rows={4} placeholder="例如：白底图产品摄影，保留产品结构，提升质感和光影，适合电商详情页" />
                <div className="rounded-lg border" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                    <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                        <span>待处理图片 {items.length} 张</span><span>按文件名顺序处理</span>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {items.length ? items.map((item, index) => (
                            <div key={item.id} className="grid grid-cols-[32px_minmax(0,1fr)_90px] items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0" style={{ borderColor: theme.node.stroke }}>
                                <span className="text-xs" style={{ color: theme.node.muted }}>{index + 1}</span>
                                <span className="truncate">{item.relativePath}</span>
                                <Tag className="justify-self-end" color={item.status === "processing" ? "processing" : item.status === "paused" ? "warning" : item.status === "success" ? "success" : item.status === "failed" ? "error" : "default"}>{batchStatusLabel(item.status)}</Tag>
                                {item.failureReason ? <span className="col-span-3 text-xs" style={{ color: token.colorError }}>{item.failureReason}</span> : null}
                            </div>
                        )) : <div className="px-3 py-10 text-center text-sm" style={{ color: theme.node.muted }}>还没有选择图片</div>}
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function batchStatusLabel(status: BatchEditFileItem["status"]) {
    if (status === "processing") return "处理中";
    if (status === "paused") return "已暂停";
    if (status === "success") return "成功";
    if (status === "failed") return "失败";
    if (status === "cancelled") return "已取消";
    return "等待中";
}
