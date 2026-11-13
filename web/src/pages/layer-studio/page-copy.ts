import { uiText } from "@/lib/i18n";

/** Translate display-only application messages without rewriting saved errors or requests. */
export function layerStudioUiMessage(source: string) {
    const referenceLimit = /^当前模式最多添加 (\d+) 张参考图，未上传本批文件。$/.exec(source);
    if (referenceLimit) return uiText("当前模式最多添加 {count} 张参考图，未上传本批文件。", { count: referenceLimit[1] });
    const readFailure = /^图层原件读取失败（(\d+)），当前编辑已保留$/.exec(source);
    if (readFailure) return uiText("图层原件读取失败（{status}），当前编辑已保留", { status: readFailure[1] });
    return uiText(source);
}
