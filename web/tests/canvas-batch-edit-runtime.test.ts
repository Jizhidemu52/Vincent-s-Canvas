import { expect, test } from "bun:test";
import { prepareCanvasBatchFiles } from "@/pages/canvas/canvas-batch-edit-runtime";

test("multi-file selection keeps all supported images in natural filename order", () => {
    const files = ["10.png", "2.png", "1.png"].map(name => new File(["image"], name, { type: "image/png" }));
    const items = prepareCanvasBatchFiles([...files, new File(["note"], "readme.txt", { type: "text/plain" })]);
    expect(items.map(item => item.relativePath)).toEqual(["1.png", "2.png", "10.png"]);
    expect(items.map(item => item.file)).toEqual([files[2], files[1], files[0]]);
    expect(items.every(item => item.status === "waiting")).toBe(true);
    expect(new Set(items.map(item => item.id)).size).toBe(3);
});

test("100 input tasks are accepted but oversized selections are not silently truncated", () => {
    const file = new File(["image"], "a.png", { type: "image/png" });
    expect(prepareCanvasBatchFiles(Array(100).fill(file))).toHaveLength(100);
    expect(() => prepareCanvasBatchFiles(Array(101).fill(file))).toThrow("最多处理 100");
});
