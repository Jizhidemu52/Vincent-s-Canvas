import { expect, test } from "bun:test";

import { canvasMediaPlaybackProps } from "@/lib/canvas/canvas-media-render-quality";

test("keeps media controls during normal canvas use", () => {
    expect(canvasMediaPlaybackProps("full")).toEqual({ controls: true, preload: "metadata" });
});

test("removes native media controls and metadata preloads during canvas movement", () => {
    expect(canvasMediaPlaybackProps("moving")).toEqual({ controls: false, preload: "none" });
});

test("does not start metadata preloads for far-canvas media nodes", () => {
    expect(canvasMediaPlaybackProps("overview")).toEqual({ controls: false, preload: "none" });
});
