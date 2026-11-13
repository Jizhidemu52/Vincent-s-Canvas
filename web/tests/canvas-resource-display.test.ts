import { expect, test } from "bun:test";
import { setUiLocale } from "@/lib/i18n";
import { canvasResourceDisplayLabel } from "@/lib/canvas/canvas-resource-display";

test("numbered reference display localizes without changing source tokens or custom labels", async () => {
    const labels = ["图片1", "视频24", "音频3", "文本42", "自定义参考", "文本0", "图5"];
    const before = [...labels];
    try {
        await setUiLocale("en-US");
        expect(labels.map(canvasResourceDisplayLabel)).toEqual(["Image 1", "Video 24", "Audio 3", "Text 42", "自定义参考", "文本0", "Image 5"]);
        expect(labels).toEqual(before);
        await setUiLocale("zh-CN");
        expect(labels.map(canvasResourceDisplayLabel)).toEqual(before);
    } finally { await setUiLocale("zh-CN"); }
});
