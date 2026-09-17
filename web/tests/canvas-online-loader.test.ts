import { expect, test } from "bun:test";
import { loadCanvasToolWhenOnline } from "../src/lib/canvas/canvas-online-loader";

test("offline optional tool suspends without requesting code and loads on reconnect", async () => {
    let online = false, calls = 0;
    const events = new EventTarget();
    const pending = loadCanvasToolWhenOnline(async () => ++calls, { isOnline: () => online, events });
    await Promise.resolve();
    expect(calls).toBe(0);
    online = true; events.dispatchEvent(new Event("online"));
    expect(await pending).toBe(1);
});

test("network lost during a tool download retries only after reconnect", async () => {
    let online = true, calls = 0;
    const events = new EventTarget();
    const pending = loadCanvasToolWhenOnline(async () => {
        if (++calls === 1) { online = false; throw new TypeError("offline"); }
        return "tool";
    }, { isOnline: () => online, events });
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
    online = true; events.dispatchEvent(new Event("online"));
    expect(await pending).toBe("tool"); expect(calls).toBe(2);
});

test("online code failures are not silently retried", async () => {
    const error = new Error("bad module");
    await expect(loadCanvasToolWhenOnline(async () => { throw error; }, { isOnline: () => true, events: new EventTarget() })).rejects.toBe(error);
});
