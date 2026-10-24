import { expect, test } from "bun:test";
import { CANVAS_AGENT_ATTACHMENT_LIMIT, readCanvasAgentAttachments } from "@/lib/canvas/canvas-agent-attachments";

const file = (name: string, size = 20, type = "image/png") => ({ name, size, type }) as File;
const data = "data:image/png;base64,QUJD";

test("one failed attachment preserves the other readable files and names each failure", async () => {
    const result = await readCanvasAgentAttachments([file("first.png"), file("broken.png"), file("last.png")], CANVAS_AGENT_ATTACHMENT_LIMIT,
        async file => { if (file.name === "broken.png") throw new Error("读取失败"); return data; });
    expect(result.images.map(image => image.name)).toEqual(["first.png", "last.png"]);
    expect(result.errors).toEqual(["broken.png：读取失败"]);
});

test("oversized, unsupported and total-budget overflow files are not decoded", async () => {
    const read: string[] = [];
    const result = await readCanvasAgentAttachments([file("huge.png", 21 * 1024 * 1024), file("notes.txt", 1, "text/plain"), file("full.png", 100)], 32,
        async file => { read.push(file.name); return data; });
    expect(read).toEqual([]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.join("\n")).toContain("20 MB");
    expect(result.errors.join("\n")).toContain("28 MB");
});

test("encoded length is checked exactly and cancellation discards a late read", async () => {
    const overflow = await readCanvasAgentAttachments([file("one.png", 1), file("two.png", 1)], data.length, async () => data);
    expect(overflow.images).toHaveLength(1);
    expect(overflow.errors[0]).toContain("two.png");
    let current = true, reads = 0;
    const cancelled = await readCanvasAgentAttachments([file("one.png"), file("two.png")], CANVAS_AGENT_ATTACHMENT_LIMIT,
        async () => { reads++; current = false; return data; }, () => current);
    expect(cancelled).toEqual({ images: [], errors: [] });
    expect(reads).toBe(1);
});
