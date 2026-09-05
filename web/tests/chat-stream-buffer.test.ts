import { expect, test } from "bun:test";
import { createChatStreamBuffer } from "../src/pages/chat/chat-stream-buffer";

function fixture() {
    const callbacks = new Map<number, () => void>();
    const rendered: string[] = [];
    let id = 0;
    const buffer = createChatStreamBuffer((text) => rendered.push(text), {
        request: (callback) => { callbacks.set(++id, callback); return id; },
        cancel: (handle) => { callbacks.delete(handle); },
    });
    return { buffer, callbacks, rendered };
}

test("a burst of 100 accumulated chat chunks renders only the newest content in one frame", () => {
    const { buffer, callbacks, rendered } = fixture();
    for (let index = 1; index <= 100; index += 1) buffer.push("字".repeat(index));
    expect(callbacks.size).toBe(1);
    expect(rendered).toEqual([]);
    callbacks.values().next().value?.();
    expect(rendered).toEqual(["字".repeat(100)]);
    expect(callbacks.size).toBe(0);
});

test("completion cancellation prevents a delayed frame replacing the final response", () => {
    const { buffer, callbacks, rendered } = fixture();
    buffer.push("partial");
    const delayed = callbacks.values().next().value;
    buffer.cancel();
    delayed?.();
    expect(rendered).toEqual([]);
    expect(callbacks.size).toBe(0);
});

test("explicit flush preserves the last pending partial response and does not duplicate it", () => {
    const { buffer, callbacks, rendered } = fixture();
    buffer.push("partial response");
    buffer.flush();
    buffer.flush();
    expect(rendered).toEqual(["partial response"]);
    expect(callbacks.size).toBe(0);
});

test("leaving the page disposes the stream so later network chunks do not schedule renders", () => {
    const { buffer, callbacks, rendered } = fixture();
    buffer.push("last visible text");
    buffer.flush();
    buffer.dispose();
    buffer.push("arrived after navigation");
    expect(callbacks.size).toBe(0);
    expect(rendered).toEqual(["last visible text"]);
});
