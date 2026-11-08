import { useEffect, useRef } from "react";
import { App } from "antd";
import { useLocation, useNavigate } from "react-router-dom";
import { useWorkbenchTask } from "@/components/workbench-tasks";
import { shouldConfirmPromptReuse } from "@/lib/generation-feedback";
import { uiText } from "@/lib/i18n";

/** Token/source-asset handoffs keep their separate ownership and restore contracts. */
export function isOrdinaryPromptUrl(params: URLSearchParams) {
    return Boolean(params.get("prompt") || params.get("model"))
        && !["designToken", "placementToken", "sourceAssetId", "reuseToken"].some(key => params.has(key));
}

/** Fill one navigation-time task after its durable draft has finished loading. */
export function usePromptUrlHandoff({ ready, prompt, applyPrompt, applyModel }: {
    ready: boolean;
    prompt: string;
    applyPrompt: (value: string) => void;
    applyModel: (value: string) => void;
}) {
    const { urlInputKey, active } = useWorkbenchTask();
    const location = useLocation();
    const navigate = useNavigate();
    const { modal } = App.useApp();
    const latest = useRef({ location, urlInputKey, applyPrompt, applyModel });
    latest.current = { location, urlInputKey, applyPrompt, applyModel };
    const consumed = useRef<string | null>(null);
    const confirmation = useRef<{ key: string; destroy: () => void } | null>(null);
    const params = new URLSearchParams(location.search);
    const presetPrompt = params.get("prompt");
    const presetModel = params.get("model");

    useEffect(() => () => {
        confirmation.current?.destroy();
        confirmation.current = null;
    }, [urlInputKey]);

    useEffect(() => {
        if (!urlInputKey || !ready || consumed.current === urlInputKey || confirmation.current?.key === urlInputKey) return;
        if (!isOrdinaryPromptUrl(new URLSearchParams(location.search))) return;
        const needsConfirmation = Boolean(presetPrompt && shouldConfirmPromptReuse(prompt, presetPrompt));
        // Never ask to replace a hidden draft while a different task is visible.
        if (needsConfirmation && !active) return;
        let stale = false;
        const finish = (apply: boolean) => {
            const current = latest.current;
            if (stale || current.urlInputKey !== urlInputKey || current.location.key !== urlInputKey || consumed.current === urlInputKey) return;
            consumed.current = urlInputKey;
            confirmation.current = null;
            if (apply) {
                if (presetPrompt) current.applyPrompt(presetPrompt);
                if (presetModel) current.applyModel(presetModel);
            }
            const remaining = new URLSearchParams(current.location.search);
            if (presetPrompt) remaining.delete("prompt");
            if (presetModel) remaining.delete("model");
            navigate({ pathname: current.location.pathname, search: remaining.toString(), hash: current.location.hash }, { replace: true, state: current.location.state });
        };
        if (!needsConfirmation) { finish(true); return; }
        const dialog = modal.confirm({
            title: uiText("替换当前草稿？"),
            content: uiText("当前提示词已有内容，复用将替换现有输入；浏览结果不会更改草稿。"),
            okText: uiText("确认替换"), cancelText: uiText("保留草稿"),
            onOk: () => finish(true), onCancel: () => finish(false),
        });
        confirmation.current = { key: urlInputKey, destroy: () => { stale = true; dialog.destroy(); } };
    }, [urlInputKey, ready, active, prompt, presetPrompt, presetModel, location.search, modal, navigate]);
}
