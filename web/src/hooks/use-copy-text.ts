import { uiText, useUiLocale } from "@/lib/i18n";
import { App } from "antd";
import copy from "copy-to-clipboard";

export function useCopyText({ notifySuccess = true }: { notifySuccess?: boolean } = {}) {
    useUiLocale();
    const { message } = App.useApp();

    return async (value: string, successText = uiText("已复制")) => {
        try {
            const copied = await copy(value);
            if (copied && notifySuccess) message.success(successText);
            if (!copied) message.error(uiText("复制失败，请检查浏览器剪贴板权限后重试"));
            return copied;
        } catch {
            message.error(uiText("复制失败，请检查浏览器剪贴板权限后重试"));
            return false;
        }
    };
}
