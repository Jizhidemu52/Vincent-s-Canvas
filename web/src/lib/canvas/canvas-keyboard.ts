import { CANVAS_WHEEL_PASSTHROUGH_SELECTOR } from "./canvas-wheel-target";

const interactiveSelector = `input,textarea,select,button,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='dialog'],[role='menu'],${CANVAS_WHEEL_PASSTHROUGH_SELECTOR}`;

export function shouldIgnoreCanvasShortcut(event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "defaultPrevented">, target: EventTarget | null) {
    return event.defaultPrevented || event.isComposing || event.keyCode === 229 || Boolean((target as Element | null)?.closest?.(interactiveSelector));
}

/** A lost keyup (Alt-Tab/window switch) must not leave temporary hand mode latched. */
export function bindCanvasSpaceKey(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, onPressed: (pressed: boolean) => void) {
    const key: EventListener = (value) => {
        const event = value as KeyboardEvent;
        if (event.type !== "blur" && event.code !== "Space") return;
        const pressed = event.type === "keydown";
        if (pressed) {
            if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || shouldIgnoreCanvasShortcut(event, event.target)) return;
            event.preventDefault();
        }
        onPressed(pressed);
    };
    const events = ["keydown", "keyup", "blur"];
    for (const name of events) target.addEventListener(name, key);
    return () => {
        for (const name of events) target.removeEventListener(name, key);
    };
}
