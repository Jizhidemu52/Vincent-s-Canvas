import { expect, test } from "bun:test";
import { createCanvasOnboardingPreference, canvasOnboardingCardPosition, canvasOnboardingAvailableArea, canvasOnboardingShouldYield } from "@/lib/canvas/canvas-onboarding-state";
import { createCanvasExampleGraph } from "@/lib/canvas/canvas-example-graph";

test("first visit is distinct from completed, skipped and deferred onboarding", async () => {
    let saved: unknown = null;
    const preferences = createCanvasOnboardingPreference({
        getItem: async <T>() => saved as T,
        setItem: async <T>(_key: string, value: T) => { saved = value; return value; },
    });
    expect(await preferences.read()).toBeNull();
    for (const outcome of ["completed", "skipped", "later"] as const) {
        await preferences.save(outcome, 2);
        expect(await preferences.read()).toEqual({ version: 1, outcome, step: 2 });
    }
    saved = { version: 0, outcome: "completed", step: 2 };
    expect(await preferences.read()).toBeNull();
});

test("onboarding never treats failed storage as a completed guide", async () => {
    const preferences = createCanvasOnboardingPreference({
        getItem: async () => { throw new Error("员工会话已变化"); },
        setItem: async () => { throw new Error("保存失败"); },
    });
    await expect(preferences.read()).rejects.toThrow("员工会话已变化");
    await expect(preferences.save("later", 0)).rejects.toThrow("保存失败");
});

test("only the automatic tour yields when the user starts working with nodes", () => {
    expect(canvasOnboardingShouldYield({ open: true, empty: true, manuallyOpened: false })).toBe(false);
    expect(canvasOnboardingShouldYield({ open: true, empty: false, manuallyOpened: false })).toBe(true);
    expect(canvasOnboardingShouldYield({ open: true, empty: false, manuallyOpened: true })).toBe(false);
    expect(canvasOnboardingShouldYield({ open: false, empty: false, manuallyOpened: false })).toBe(false);
});

test("tour card stays within a short viewport and beside the actual highlighted panel", () => {
    expect(canvasOnboardingCardPosition({ left: 12, top: 80, width: 480, height: 500 }, { width: 1366, height: 768 }, { width: 360, height: 280 })).toEqual({ left: 508, top: 80 });
    const bottom = canvasOnboardingCardPosition({ left: 500, top: 710, width: 32, height: 40 }, { width: 1280, height: 768 }, { width: 360, height: 280 });
    expect(bottom.top + 280).toBeLessThanOrEqual(756);
    expect(bottom.left + 360).toBeLessThanOrEqual(1268);
});

test("tour card reserves the full toolbar strip at laptop and desktop sizes", () => {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1800, height: 1200 }]) {
        const dockTop = viewport.height - 48;
        const usable = { top: 80, bottom: dockTop - 16 };
        const card = { width: 360, height: 280 };
        const position = canvasOnboardingCardPosition({ left: viewport.width / 2 - 150, top: dockTop + 4, width: 32, height: 32 }, viewport, card, usable);
        expect(position.top).toBeGreaterThanOrEqual(usable.top);
        expect(position.top + card.height).toBeLessThanOrEqual(usable.bottom);
    }
});

test("tour card respects the top controls and fits the scrollable height in a short viewport", () => {
    const usable = { top: 80, bottom: 224 };
    const position = canvasOnboardingCardPosition({ left: 12, top: 12, width: 32, height: 32 }, { width: 390, height: 300 }, { width: 360, height: 280 }, usable);
    expect(position.top).toBe(80);
    expect(position.top + Math.min(280, usable.bottom - usable.top)).toBe(usable.bottom);
});

test("empty entries reserve the actual open panel width, not the whole viewport center", () => {
    const container = { left: 0, top: 0, width: 1366, height: 768 };
    expect(canvasOnboardingAvailableArea(container, [])).toEqual({ left: 0, width: 1366 });
    expect(canvasOnboardingAvailableArea(container, [{ left: 12, top: 80, width: 480, height: 616 }])).toEqual({ left: 508, width: 858 });
    expect(canvasOnboardingAvailableArea(container, [{ left: 12, top: 80, width: 659, height: 616 }])).toEqual({ left: 687, width: 679 });
});

test("empty layout is relative to its canvas container and handles a centered wide panel", () => {
    expect(canvasOnboardingAvailableArea({ left: 200, top: 40, width: 1366, height: 768 }, [{ left: 212, top: 120, width: 480, height: 616 }])).toEqual({ left: 508, width: 858 });
    expect(canvasOnboardingAvailableArea({ left: 0, top: 0, width: 1800, height: 1000 }, [{ left: 420, top: 80, width: 960, height: 848 }])).toEqual({ left: 1396, width: 404 });
});

test("example graph is editable, source-preserving and idle without dispatching any generation", () => {
    let id = 0;
    const result = createCanvasExampleGraph(() => `example-${++id}`);
    expect(result.nodes).toHaveLength(4);
    const image = result.nodes.find(node => node.type === "image")!;
    const config = result.nodes.find(node => node.type === "config")!;
    expect(image.metadata?.content).toBe("/design-workbench/assets/garment.png");
    expect(config.metadata?.status).toBe("idle");
    expect(config.metadata?.composerContent).toContain(`@[node:${image.id}]`);
    expect(result.connections.some(edge => edge.fromNodeId === image.id && edge.toNodeId === config.id)).toBe(true);
    expect(result.nodes.every(node => !node.metadata?.sourceTaskId && node.metadata?.status !== "loading")).toBe(true);
    expect(result.nodes.find(node => node.title.includes("说明"))?.metadata?.content).toContain("未调用模型");
});
