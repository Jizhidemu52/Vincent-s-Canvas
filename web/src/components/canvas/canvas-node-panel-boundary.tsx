import { Component, type ReactNode } from "react";
import { uiText as t } from "@/lib/i18n";

type RecoveryProps = { onBackup: () => Promise<void>; onClose: () => void };

/** An optional editor must not take the mounted canvas and other drafts down with it. */
export class CanvasNodePanelBoundary extends Component<RecoveryProps & { children: ReactNode }> {
    state = { failed: false, busy: false, note: "" };
    static getDerivedStateFromError() { return { failed: true }; }
    backup = async () => {
        this.setState({ busy: true, note: "" });
        try { await this.props.onBackup(); }
        catch { this.setState({ note: t("备份失败") }); }
        finally { this.setState({ busy: false }); }
    };
    render() {
        if (!this.state.failed) return this.props.children;
        return <section role="alert" className="cw-surface p-3 text-xs"
            onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <strong>{t("节点编辑模块暂不可用")}</strong>
            <p>{this.state.note || t("不代表已保存或已同步；先复制表单。")}</p>
            <button type="button" className="cw-text-button" disabled={this.state.busy} onClick={this.backup}>{t("备份画布")}</button>
            <a className="cw-text-button" href={window.location.href} target="_blank" rel="noopener">{t("新标签页恢复")}</a>
            <button type="button" className="cw-text-button" onClick={this.props.onClose}>{t("关闭编辑区")}</button>
        </section>;
    }
}
