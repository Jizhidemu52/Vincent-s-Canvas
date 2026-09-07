import { expect, test } from "bun:test";
import { mergePromptEditorParameters } from "@/lib/prompt-editor-parameters";

test("editing common fields preserves video and provider parameters without mutating the template", () => {
    const original = { videoMode: "first-last", videoSeconds: 6, resolution: "1080p", size: "16:9", count: 2, nested: { seed: 42 } };
    const result = mergePromptEditorParameters(original, { size: " 1:1 ", quality: "high", quantity: 3 });
    expect(result).toEqual({ ...original, size: "1:1", quality: "high", quantity: 3, count: 3 });
    expect(original.size).toBe("16:9");
    expect(original.count).toBe(2);
});

test("clearing a field removes only that field; new templates start with clean parameters", () => {
    expect(mergePromptEditorParameters({ size: "16:9", quality: "high", videoSeconds: 4 }, {})).toEqual({ videoSeconds: 4, quantity: 1 });
    expect(mergePromptEditorParameters(undefined, {})).toEqual({ quantity: 1 });
});
