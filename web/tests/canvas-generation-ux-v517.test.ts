import { expect, test } from "bun:test";
import { mergeCanvasPromptHistory } from "@/lib/canvas/canvas-prompt-history";
import { audioFormatOptions, audioVoiceOptions, audioVoiceLabel, audioVoiceSampleUrl, normalizeAudioFormatValue } from "@/lib/audio-generation";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("prompt history is trimmed, deduplicated, most-recent-first and bounded to fifty entries", () => {
    const before = Array.from({ length: 60 }, (_, index) => `prompt-${index}`);
    const after = mergeCanvasPromptHistory(before, "  prompt-20  ");
    expect(after).toHaveLength(50); expect(after[0]).toBe("prompt-20");
    expect(after.filter(value => value === "prompt-20")).toHaveLength(1);
    expect(mergeCanvasPromptHistory(after, " \n ")).toEqual(after);
    expect(before).toHaveLength(60);
});

test("audio choices use readable Chinese aliases and unsupported legacy PCM settings normalize to playable MP3", () => {
    expect(audioVoiceOptions).toHaveLength(13);
    expect(audioVoiceOptions.every(item => /[\u4e00-\u9fff]/.test(item.chineseLabel) && audioVoiceLabel(item.value).includes(item.label))).toBe(true);
    expect(audioFormatOptions.some(item => item.value === "pcm")).toBe(false);
    expect(normalizeAudioFormatValue("pcm")).toBe("mp3");
    expect(normalizeAudioFormatValue("wav")).toBe("wav");
    expect(audioVoiceOptions.filter(item => audioVoiceSampleUrl(item.value))).toHaveLength(9);
    for (const voice of ["ballad", "verse", "marin", "cedar", "not-a-voice"]) expect(audioVoiceSampleUrl(voice)).toBeUndefined();
});

test("output placement anchors to a source image instead of its remote configuration and avoids occupied cells", () => {
    const image: CanvasNodeData = { id: "image", title: "source", type: CanvasNodeType.Image, width: 200, height: 300, position: { x: 100, y: 100 } };
    const config: CanvasNodeData = { ...image, id: "config", type: CanvasNodeType.Config, position: { x: 5000, y: 2000 } };
    const size = { width: 320, height: 320 };
    const first = placeCanvasImageOutputs([image, config], [config, image], size, { x: 0, y: 0 });
    expect(first).toEqual({ x: 336, y: 100 });
    const existing = { ...image, id: "old-result", ...size, position: first };
    const next = placeCanvasImageOutputs([image, config, existing], [config, image], size, { x: 0, y: 0 });
    expect(next).not.toEqual(first);
    expect(Math.abs(next.x - image.position.x)).toBeLessThan(1000);
    expect(next.x + size.width <= existing.position.x || next.x >= existing.position.x + existing.width || next.y + size.height <= existing.position.y || next.y >= existing.position.y + existing.height).toBe(true);
});
