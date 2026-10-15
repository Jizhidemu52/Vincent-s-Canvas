import { expect, test } from "bun:test";
import { canvasPanelWidths, clampCanvasPanelWidth, clampCanvasPromptHeight } from "@/lib/canvas/canvas-panel-width";
import { keyboardCanvasPanelWidth } from "@/lib/canvas/canvas-panel-resize-keyboard";

test("creation and chat widths have independent defaults and safe bounds", () => {
    expect(canvasPanelWidths.create.default).toBe(480);
    expect(canvasPanelWidths.chat.default).toBe(480);
    expect(clampCanvasPanelWidth("create", 10)).toBe(320);
    expect(clampCanvasPanelWidth("chat", 10)).toBe(360);
    expect(clampCanvasPanelWidth("create", 900)).toBe(680);
    expect(clampCanvasPanelWidth("chat", NaN)).toBe(480);
    expect(clampCanvasPanelWidth("create", 401.6)).toBe(402);
});

test("keyboard resizing supports fine/coarse steps, reset, and limits", () => {
    expect(keyboardCanvasPanelWidth("create", 480, "ArrowRight")).toBe(490);
    expect(keyboardCanvasPanelWidth("chat", 380, "ArrowLeft", true)).toBe(360);
    expect(keyboardCanvasPanelWidth("chat", 680, "ArrowRight")).toBe(680);
    expect(keyboardCanvasPanelWidth("create", 400, "Home")).toBe(480);
    expect(keyboardCanvasPanelWidth("chat", 400, "Home")).toBe(480);
    expect(keyboardCanvasPanelWidth("create", 320, "End")).toBe(680);
    expect(keyboardCanvasPanelWidth("create", 480, "a")).toBeNull();
});

test("input height remains adjustable inside supported bounds", () => {
    expect(clampCanvasPromptHeight(10)).toBe(140);
    expect(clampCanvasPromptHeight(1000)).toBe(480);
    expect(clampCanvasPromptHeight(NaN)).toBe(240);
    expect(clampCanvasPromptHeight(320)).toBe(320);
});
