import { expect, test } from "bun:test";
import { hydrateImageLogMedia } from "@/pages/image/image-log-media";

test("initial image history restores only the displayed outputs, not every stored reference", async () => {
    const calls: string[] = [];
    const log = { id: "selected", images: [{ storageKey: "output", dataUrl: "" }], references: [{ storageKey: "reference", dataUrl: "" }] };
    const restored = await hydrateImageLogMedia(log, async key => { calls.push(key!); return `blob:${key}`; }, false);
    expect(calls).toEqual(["output"]);
    expect(restored.images[0]!.dataUrl).toBe("blob:output");
    expect(restored.references).toBe(log.references);
    expect(log.images[0]!.dataUrl).toBe("");
});
test("explicit history restoration hydrates its references as well", async () => {
    const restored = await hydrateImageLogMedia({ images: [], references: [{ storageKey: "source", dataUrl: "fallback" }] }, async (_, fallback) => fallback!);
    expect(restored.references[0]!.dataUrl).toBe("fallback");
});
