import { displayNotice } from "@/hooks/use-display-text";
import { uiText } from "@/lib/i18n";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { modelOptionName } from "@/stores/use-config-store";
import { uploadImage } from "@/services/image-storage";
import type { CanvasSelectionReference } from "@/lib/canvas/canvas-selection-references";
import type { App } from "antd";
import { nanoid } from "nanoid";

type ReferenceInput = { model: string; references: CanvasSelectionReference[] };
type ReferenceUploadOptions = ReferenceInput & {
    current: () => boolean;
    latest: () => ReferenceInput;
    append: (update: (references: CanvasSelectionReference[]) => CanvasSelectionReference[]) => void;
    message: ReturnType<typeof App.useApp>["message"];
};

/** The caller owns the read lock and scope; only an explicit import loads this. */
export async function uploadCanvasQuickReferences(input: File[], options: ReferenceUploadOptions) {
    if (!options.current()) return;
    const maximum = validateImageReferences(modelOptionName(options.model), options.references).maximum;
    const remaining = Math.max(0, maximum - options.references.length);
    const files = input.filter(file => file.type.startsWith("image/")).slice(0, remaining);
    if (!files.length) {
        options.message.warning(displayNotice(remaining ? uiText("请选择图片文件") : maximum ? uiText("当前模型最多添加 {value1} 张参考图", { value1: maximum }) : uiText("当前模型不支持参考图")));
        return;
    }
    files.forEach(assertCanvasImageUploadSize);
    const uploaded = await Promise.all(files.map(async file => {
        const image = await uploadImage(file);
        return { id: nanoid(), name: file.name, originalFileName: file.name, type: image.mimeType, dataUrl: image.url, url: image.url, storageKey: image.storageKey };
    }));
    if (!options.current()) return;
    const latest = options.latest();
    const slots = Math.max(0, validateImageReferences(modelOptionName(latest.model), latest.references).maximum - latest.references.length);
    options.append(references => [...references, ...uploaded.slice(0, slots)]);
}
