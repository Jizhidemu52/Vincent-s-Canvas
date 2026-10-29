import { useUiText } from "@/lib/i18n";
import { useState } from "react";
import { Input, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasGroupNameDialog({ initialName, onSave, onClose }: { initialName: string; onSave: (name: string) => void; onClose: () => void }) {
    const t = useUiText();
    const [name, setName] = useState(initialName);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const save = () => { if (name.trim()) onSave(name.trim()); };
    return <Modal title={t("款式组名称")} open onCancel={onClose} onOk={save} okText={t("保存名称")} cancelText={t("取消")} okButtonProps={{ disabled: !name.trim() }}>
        <Input aria-label={t("款式组名称")} autoFocus maxLength={80} value={name} placeholder={t("例如：秋季夹克 · A 款")} onChange={event => setName(event.target.value)} onPressEnter={save} />
        <p className="mt-3 text-xs" style={{ color: theme.node.muted }}>{t("拖动组标题可整体移动。折叠或取消分组不会删除图片、节点或连线。")}</p>
    </Modal>;
}
