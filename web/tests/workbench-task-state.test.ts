import { expect, test } from "bun:test";
import { addWorkbenchTask, closeWorkbenchTask, initialWorkbenchTasks, matchesWorkbenchTask, readWorkbenchTasks, workbenchTaskScope } from "../src/lib/workbench-task-state";
import { createSubmissionGate } from "../src/lib/submission-gate";

test("ordinary drafts keep their keys and new tasks own independent namespaces", () => {
    expect(workbenchTaskScope("image-edit:settings")).toBe("image-edit:settings");
    expect(workbenchTaskScope("image-edit:settings", "b")).toBe("image-edit:settings:task:b");
    expect(matchesWorkbenchTask({})).toBe(true);
    expect(matchesWorkbenchTask({}, "b")).toBe(false);
    expect(matchesWorkbenchTask({ workspaceId: "b" }, "b")).toBe(true);
    expect(matchesWorkbenchTask({ workspaceId: "b" })).toBe(false);
});

test("task identity is durable; closing a finished tab never renumbers or reuses a request workspace", () => {
    const initial = initialWorkbenchTasks();
    const second = addWorkbenchTask(initial, "second", 10);
    const third = addWorkbenchTask(second, "third", 20);
    expect(initial.tasks).toHaveLength(1);
    expect(readWorkbenchTasks(JSON.parse(JSON.stringify(third)))).toEqual(third);
    const closed = closeWorkbenchTask(third, "third");
    expect(closed.activeId).toBe("second");
    expect(addWorkbenchTask(closed, "fourth", 30).tasks.at(-1)?.number).toBe(4);
    expect(closeWorkbenchTask(closed, "default")).toBe(closed);
    expect(closeWorkbenchTask(closed, "absent")).toBe(closed);
});

test.each([
    {}, { version: 9 }, { ...initialWorkbenchTasks(), tasks: [] },
    { ...initialWorkbenchTasks(), activeId: "absent" },
    { ...initialWorkbenchTasks(), nextNumber: 1 },
    { ...initialWorkbenchTasks(), tasks: [{ id: "../escape", number: 1, createdAt: 0 }] },
    { ...initialWorkbenchTasks(), tasks: [{ id: "default", number: 1, createdAt: -1 }] },
    { ...initialWorkbenchTasks(), tasks: [initialWorkbenchTasks().tasks[0], initialWorkbenchTasks().tasks[0]] },
])("corrupt registry fails closed without silently replacing unresolved work %#", value => {
    expect(() => readWorkbenchTasks(value)).toThrow("未被覆盖");
});

test("one hundred independent task leases do not serialize each other, while double submission remains guarded", () => {
    let registry = initialWorkbenchTasks();
    const gate = createSubmissionGate();
    const releases: Array<() => void> = [];
    for (let index = 0; index < 100; index++) {
        const id = `stress-${index}`;
        registry = addWorkbenchTask(registry, id, index);
        const key = workbenchTaskScope("image:owner:image-edit", id);
        const release = gate.acquire(key);
        expect(release).toBeFunction();
        releases.push(release!);
        expect(gate.acquire(key)).toBeNull();
    }
    expect(registry.tasks).toHaveLength(101);
    for (const release of releases.reverse()) { release(); release(); }
    expect(gate.acquire(workbenchTaskScope("image:owner:image-edit", "stress-0"))).toBeFunction();
});
