import { expect, test } from "bun:test";
import { filterMentionImages, imageMentionAt, insertImageMention } from "@/lib/conversation-image-mention";

test("image mentions follow the caret, support Chinese, and ignore a completed token", () => {
    expect(imageMentionAt("参考@图2再调整", 5)).toEqual({ start: 2, end: 5, query: "图2" });
    expect(imageMentionAt("请看 @", 4)).toEqual({ start: 3, end: 4, query: "" });
    expect(imageMentionAt("@图1 后续", 4)).toBeNull();
    expect(imageMentionAt("@图1", -1)).toBeNull();
    expect(imageMentionAt("@图1", 10)).toBeNull();
});

test("selecting a mention replaces only its active token and preserves surrounding instructions", () => {
    expect(insertImageMention("保持@图红色不变", { start: 2, end: 4, query: "图" }, "图12"))
        .toEqual({ value: "保持@图12 红色不变", caret: 7 });
    expect(insertImageMention("先@ 原样继续", { start: 1, end: 2, query: "" }, "图2"))
        .toEqual({ value: "先@图2 原样继续", caret: 4 });
});

test("filtering finds stable image numbers and original names without renumbering or hiding unavailable history", () => {
    const images = [
        { id: "old", label: "图1", name: "原始围巾.png", unavailableReason: "原图暂时无法读取" },
        { id: "new", label: "图12", name: "BLUE.png", dataUrl: "data:image/png;base64,AA" },
    ];
    expect(filterMentionImages(images, "围巾")).toEqual([images[0]]);
    expect(filterMentionImages(images, "图12")).toEqual([images[1]]);
    expect(filterMentionImages(images, "blue")).toEqual([images[1]]);
    expect(filterMentionImages(images, "")).toEqual(images);
    expect(images.map(image => image.label)).toEqual(["图1", "图12"]);
});
