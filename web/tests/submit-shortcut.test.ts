import { expect, test } from "bun:test";
import { handleSubmitShortcut } from "../src/lib/submit-shortcut";

test("only enabled Ctrl/Command Enter submits once and prevents a newline", () => {
    let submitted = 0;
    let prevented = 0;
    const event = { key: "Enter", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, nativeEvent: {}, preventDefault() { prevented += 1; } };
    const submit = () => { submitted += 1; };
    handleSubmitShortcut(event, true, submit);
    handleSubmitShortcut({ ...event, ctrlKey: false, metaKey: true }, true, submit);
    for (const override of [{ key: "x" }, { ctrlKey: false }, { altKey: true }, { shiftKey: true }, { repeat: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
        handleSubmitShortcut({ ...event, ...override }, true, submit);
    }
    handleSubmitShortcut(event, false, submit);
    expect(submitted).toBe(2);
    expect(prevented).toBe(2);
});
