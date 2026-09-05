import { expect, test } from "bun:test";
import { collectProjectChanges, createProjectChangeBuffer, mergeProjectChanges } from "@/lib/canvas/canvas-persistence-merge";

test("an old tab saving A does not remove B created by another tab", () => {
    const a = { id: "a", title: "original" };
    const b = { id: "b", title: "new canvas" };
    const edited = { ...a, title: "edited" };
    const changes = collectProjectChanges([a], [edited]);
    expect(mergeProjectChanges([b, a], changes)).toEqual([b, edited]);
});

test("stale unchanged projects do not resurrect another tab's deletion", () => {
    const a = { id: "a", title: "A" }, b = { id: "b", title: "B" };
    const edited = { ...b, title: "edited" };
    expect(mergeProjectChanges([b], collectProjectChanges([a, b], [a, edited]))).toEqual([edited]);
});

test("coalesced edits retain creation and intentional deletion", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const pending = collectProjectChanges([a], [b, a]);
    collectProjectChanges([b, a], [b], pending);
    expect(mergeProjectChanges([c, a], pending)).toEqual([b, c]);
});

test("failed writes retain edits and deletions until a later write succeeds", async () => {
    const buffer = createProjectChangeBuffer<{ id: string; title: string }>();
    const oldA = { id: "a", title: "first edit" };
    await expect(buffer.write(new Map([["a", oldA], ["deleted", null]]), async () => {
        throw new Error("temporary storage failure");
    })).rejects.toThrow("temporary storage failure");
    const newA = { id: "a", title: "latest edit" }, b = { id: "b", title: "B" };
    let saved = new Map();
    await buffer.write(new Map([["a", newA], ["b", b]]), async changes => { saved = new Map(changes); });
    expect(saved).toEqual(new Map([["a", newA], ["deleted", null], ["b", b]]));
    await buffer.write(new Map([["b", b]]), async changes => {
        expect([...changes.keys()]).toEqual(["b"]);
    });
});

test("explicit storage removal clears failed changes", async () => {
    const buffer = createProjectChangeBuffer<{ id: string }>();
    await expect(buffer.write(new Map([["a", { id: "a" }]]), async () => { throw new Error("failed"); })).rejects.toThrow();
    buffer.clear();
    await buffer.write(new Map(), async changes => { expect(changes.size).toBe(0); });
});
