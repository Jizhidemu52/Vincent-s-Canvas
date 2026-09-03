import { expect, test } from "bun:test";

import { canvasMediaPlaybackProps } from "@/lib/canvas/canvas-media-render-quality";

test("keeps media controls during normal canvas use", () => {
    expect(canvasMediaPlaybackProps("full")).toEqual({ controls: true, preload: "metadata" });
});

test("removes native media controls during canvas movement without changing preload", () => {
    expect(canvasMediaPlaybackProps("moving")).toEqual({ controls: false, preload: "metadata" });
});
