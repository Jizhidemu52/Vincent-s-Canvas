import { expect, test } from "bun:test";

import { createCanvasTextDraft } from "@/lib/canvas/canvas-text-draft";

function createTimers() {
    let nextId = 0;
    const callbacks = new Map<number, () => void>();
    return {
        scheduler: {
            set(callback: () => void) {
                const id = nextId++;
                callbacks.set(id, callback);
                return id;
            },
            clear(id: unknown) {
                callbacks.delete(id as number);
            },
        },
        run() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach((callback) => callback());
        },
    };
}

test("commits only the latest text draft after typing pauses", () => {
    const timers = createTimers();
    const committed: string[] = [];
    const draft = createCanvasTextDraft("first", (value) => committed.push(value), timers.scheduler);

    draft.change("first second");
    draft.change("first second third");
    timers.run();

    expect(committed).toEqual(["first second third"]);
});

test("flushes a pending text draft when editing finishes", () => {
    const timers = createTimers();
    const committed: string[] = [];
    const draft = createCanvasTextDraft("", (value) => committed.push(value), timers.scheduler);

    draft.change("prompt");
    draft.flush();

    expect(committed).toEqual(["prompt"]);
});

test("drops a stale pending draft when an external value replaces it", () => {
    const timers = createTimers();
    const committed: string[] = [];
    const draft = createCanvasTextDraft("first", (value) => committed.push(value), timers.scheduler);

    draft.change("local pending edit");
    draft.reset("external replacement");
    timers.run();

    expect(committed).toEqual([]);
});
