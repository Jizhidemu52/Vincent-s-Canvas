import { expect, test } from "bun:test";
import { createTaskEventStream } from "../src/services/api/task-events";
import { observeTask } from "../src/services/api/task-observation";

function fixture() {
    const visibilityEvents = new EventTarget();
    const visibility = { hidden: false, addEventListener: visibilityEvents.addEventListener.bind(visibilityEvents), removeEventListener: visibilityEvents.removeEventListener.bind(visibilityEvents) };
    const connections: Array<{ url: string; closed: boolean; emit: (ids: string[]) => void; error: () => void }> = [];
    let owner = "employee-a";
    const stream = createTaskEventStream({ owner: () => owner, visibility, connect(url) {
        const events = new EventTarget();
        const connection = { url, closed: false, emit(ids: string[]) { events.dispatchEvent(new MessageEvent("tasks-changed", { data: JSON.stringify({ ids }) })); }, error() { events.dispatchEvent(new Event("error")); } };
        connections.push(connection);
        return { addEventListener: events.addEventListener.bind(events), close: () => { connection.closed = true; } };
    } });
    return { stream, connections, hidden(value: boolean) { visibility.hidden = value; visibilityEvents.dispatchEvent(new Event("visibilitychange")); }, owner(value: string) { owner = value; stream.identityChanged(); } };
}

test("concurrent task observers share one stream and only relevant changes wake them", async () => {
    const f = fixture();
    const first = f.stream.subscribe(["one"]), second = f.stream.subscribe(["two", "one"]);
    await Bun.sleep(45);
    expect(f.connections).toHaveLength(1);
    expect(new URL(f.connections[0]!.url, "http://canvas").searchParams.get("ids")).toBe("one,two");
    f.connections[0]!.emit(["two"]);
    expect(first.version).toBe(0);
    expect(second.version).toBe(1);
    f.connections[0]!.emit(["one"]);
    expect(first.version).toBe(1);
    first.close(); second.close();
    expect(f.connections[0]!.closed).toBe(true);
});

test("notifications arriving during GET are not lost before the next wait", async () => {
    const f = fixture();
    const watch = f.stream.subscribe(["one"]);
    await Bun.sleep(45);
    const beforeRead = watch.version;
    f.connections[0]!.emit(["one"]);
    await watch.next(beforeRead, 30_000);
    watch.close();
});

test("healthy stream waits for push, disconnect enables bounded read-only fallback", async () => {
    const f = fixture();
    const watch = f.stream.subscribe(["one"]);
    await Bun.sleep(45);
    f.connections[0]!.emit(["one"]);
    let settled = false;
    const waiting = watch.next(watch.version, 30_000).then(() => { settled = true; });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    f.connections[0]!.error();
    await waiting;
    await watch.next(watch.version, 100, undefined, 5);
    watch.close();
});

test("hidden tabs close the stream, avoid GETs and resnapshot when visible", async () => {
    const f = fixture();
    f.hidden(true);
    const watch = f.stream.subscribe(["one"]);
    let calls = 0, revision = watch.version;
    const result = observeTask({ ready: watch.ready, waitForChange: (ms, signal) => watch.next(revision, ms, signal), timeoutMs: 2000,
        read: async () => { revision = watch.version; return ++calls; }, done: value => value === 1 });
    await Bun.sleep(50);
    expect(calls).toBe(0);
    expect(f.connections).toHaveLength(0);
    f.hidden(false);
    expect(await result).toBe(1);
    watch.close();
});

test("an active generation keeps the single stream in background without waking passive views", async () => {
    const f = fixture();
    const active = f.stream.subscribe(["one"], { background: true });
    const passive = f.stream.subscribe(["two"]);
    await Bun.sleep(45);
    f.connections[0]!.emit(["one"]);
    f.hidden(true);
    expect(f.connections[0]!.closed).toBe(false);
    const revision = active.version;
    let completed = false;
    const waiting = active.next(revision, 1000, undefined, 5).then(() => { completed = true; });
    await Bun.sleep(50);
    expect(completed).toBe(false);
    f.connections[0]!.emit(["one"]);
    await waiting;
    expect(f.connections).toHaveLength(1);
    active.close();
    await Bun.sleep(45);
    expect(f.connections[0]!.closed).toBe(true);
    passive.close();
});

test("a hidden active observer uses its existing bounded fallback when SSE disconnects", async () => {
    const f = fixture();
    const watch = f.stream.subscribe(["one"], { background: true });
    await Bun.sleep(45);
    f.connections[0]!.emit(["one"]);
    f.hidden(true);
    f.connections[0]!.error();
    let calls = 0, revision = watch.version;
    const pending = observeTask({ ready: watch.ready, timeoutMs: 1000,
        read: async () => { revision = watch.version; return ++calls; }, done: value => value === 2,
        waitForChange: (remaining, signal) => watch.next(revision, remaining, signal, 40),
    });
    await Bun.sleep(10);
    expect(calls).toBe(1);
    expect(await pending).toBe(2);
    expect(f.connections).toHaveLength(1);
    watch.close();
});

test("employee change rejects stale observation and late old events cannot wake a new owner", async () => {
    const f = fixture();
    const watch = f.stream.subscribe(["one"]);
    await Bun.sleep(45);
    const pending = watch.next(watch.version, 30_000);
    f.owner("employee-b");
    await expect(pending).rejects.toThrow("员工会话已变化");
    expect(f.connections[0]!.closed).toBe(true);
    const second = f.stream.subscribe(["two"]);
    f.connections[0]!.emit(["two"]);
    expect(second.version).toBe(0);
    watch.close(); second.close();
});

test("aborting observation removes its wait without cancelling another observer", async () => {
    const f = fixture();
    const first = f.stream.subscribe(["one"]), second = f.stream.subscribe(["one"]);
    await Bun.sleep(45);
    const controller = new AbortController();
    const pending = first.next(first.version, 30_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    first.close();
    expect(f.connections[0]!.closed).toBe(false);
    f.connections[0]!.emit(["one"]);
    expect(second.version).toBe(1);
    second.close();
});
