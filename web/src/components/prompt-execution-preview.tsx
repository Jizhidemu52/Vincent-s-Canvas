import { useEffect } from "react";
import { Modal } from "antd";
import { useLocation } from "react-router-dom";
import { uiText } from "@/lib/i18n";
import { useUserStore } from "@/stores/use-user-store";
import { cancelPromptExecutionPreview, invalidatePromptExecutionContext, usePromptExecutionPreview } from "@/stores/use-prompt-execution-preview";

export function PromptExecutionPreviewHost() {
    const pending = usePromptExecutionPreview(state => state.pending);
    const ownerId = useUserStore(state => state.user?.id);
    const status = useUserStore(state => state.status);
    const location = useLocation();
    useEffect(() => () => invalidatePromptExecutionContext(), [location.key]);
    useEffect(() => {
        if (pending && (ownerId !== pending.ownerId || status !== "authenticated")) cancelPromptExecutionPreview();
    }, [pending, ownerId, status]);
    return <Modal open={Boolean(pending)} title={uiText("生成前确认")} width={760} centered
        okText={uiText("确认这份内容并生成")} cancelText={uiText("取消，返回修改")} maskClosable={false}
        onOk={() => pending?.finish(true)} onCancel={cancelPromptExecutionPreview}>
        {pending ? <div className="max-h-[70vh] space-y-4 overflow-y-auto break-words">
            <p className="text-sm text-muted-foreground">{uiText("已完成提示词准备，尚未提交图片任务。确认将使用以下内容；取消不会生成图片。")}</p>
            <p><strong>{uiText("模型")}</strong>：{pending.modelName}{pending.batchCount ? ` · ${uiText("独立图片")} ${pending.batchCount}` : ""}</p>
            {pending.summaryZh ? <p>{pending.summaryZh}</p> : null}
            <section><strong>{uiText("实际发送文本")}</strong><pre aria-label={uiText("实际发送文本")} className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-sans text-sm">{pending.prompt}</pre></section>
            {pending.nativeNegativePrompt ? <section><strong>{uiText("模型原生排除参数")}</strong><p className="whitespace-pre-wrap">{pending.nativeNegativePrompt}</p></section> : null}
            {pending.references.length ? <section><strong>{uiText("实际图片顺序与用途")}</strong><ol className="mt-2 space-y-2">
                {pending.references.map((reference, index) => <li key={`${index}:${reference.url}`} className="flex items-center gap-3"><img src={reference.url} alt="" className="h-16 w-16 shrink-0 rounded object-contain bg-muted/30" /><span><span className="block font-medium">{reference.label}</span><span className="text-xs text-muted-foreground">{reference.name}</span></span></li>)}
            </ol></section> : null}
        </div> : null}
    </Modal>;
}
