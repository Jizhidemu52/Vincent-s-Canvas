import { useUiText } from "@/lib/i18n";
import { Modal } from "antd";
import { canvasActions, canvasActionShortcut } from "@/lib/canvas/canvas-actions";

export function CanvasShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const t = useUiText();
    const gestures = [
        ["空格 + 拖动 / 手形工具", "平移视图"], ["滚轮 / 缩放滑杆", "缩放画布"],
        ["选择工具 + 空白处拖动", "框选多个节点"], ["Shift / Ctrl / Cmd + 点击", "追加选择节点"],
        ["Ctrl / Cmd + C / X / V", "复制 / 剪切 / 粘贴"], ["Ctrl / Cmd + Y", "重做"],
        ["Tab / Shift + Tab", "依次聚焦可见节点及工具"], ["方向键 / Shift + 方向键", "聚焦节点微移 1 / 10 像素"],
        ["Enter", "编辑聚焦节点"], ["Esc", "取消选择并关闭浮层"],
    ];
    return <Modal title={t("快捷键与画布操作")} open={open} onCancel={onClose} footer={null} centered>
        <div className="cw-shortcuts-list">{[...canvasActions.filter(action => "key" in action).map(action => [canvasActionShortcut(action.id), action.label]), ...gestures].map(([keys, label]) =>
            <div key={`${keys}-${label}`}><kbd>{t(keys)}</kbd><span>{t(label)}</span></div>)}</div>
    </Modal>;
}
