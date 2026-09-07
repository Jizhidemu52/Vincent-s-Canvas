import { expect, test } from "bun:test";
import { bindCanvasSpaceKey, shouldIgnoreCanvasShortcut } from "@/lib/canvas/canvas-keyboard";

const normal = { isComposing: false, keyCode: 0, defaultPrevented: false };
test("IME composition and already-handled events do not reach destructive canvas shortcuts", () => {
    expect(shouldIgnoreCanvasShortcut(normal, null)).toBe(false);
    expect(shouldIgnoreCanvasShortcut({ ...normal, isComposing: true }, null)).toBe(true);
    expect(shouldIgnoreCanvasShortcut({ ...normal, keyCode: 229 }, null)).toBe(true);
    expect(shouldIgnoreCanvasShortcut({ ...normal, defaultPrevented: true }, null)).toBe(true);
});

test("editable descendants and popup controls remain independent of the canvas", () => {
    let selector = "";
    const target = { closest: (value: string) => { selector = value; return {}; } } as Element;
    expect(shouldIgnoreCanvasShortcut(normal, target)).toBe(true);
    for (const surface of ["textarea", "select", "button", "contenteditable", "role='dialog'", ".ant-modal", "data-canvas-no-zoom"]) expect(selector).toContain(surface);
});

test("space hand mode resets on blur without a keyup, ignores repeats and disposes listeners", () => {
    const target = new EventTarget();
    const states: boolean[] = [];
    const dispose = bindCanvasSpaceKey(target, (value) => states.push(value));
    const space = (extras = {}) => Object.assign(new Event("keydown", { cancelable: true }), { code: "Space", isComposing: false, keyCode: 0, ...extras });
    const down = space();
    target.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    target.dispatchEvent(space({ repeat: true }));
    target.dispatchEvent(new Event("blur"));
    expect(states).toEqual([true, false]);
    target.dispatchEvent(space({ isComposing: true }));
    target.dispatchEvent(space({ ctrlKey: true }));
    expect(states).toEqual([true, false]);
    dispose();
    target.dispatchEvent(space());
    target.dispatchEvent(new Event("blur"));
    expect(states).toEqual([true, false]);
});
