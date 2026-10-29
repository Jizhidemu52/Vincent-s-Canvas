import { App } from "antd";
import copy from "copy-to-clipboard";

export function useCopyText() {
    const { message } = App.useApp();

    return async (value: string, successText = "已复制") => {
        try {
            const copied = await copy(value);
            if (copied) message.success(successText);
            else message.error("复制失败，请检查浏览器剪贴板权限后重试");
            return copied;
        } catch {
            message.error("复制失败，请检查浏览器剪贴板权限后重试");
            return false;
        }
    };
}
