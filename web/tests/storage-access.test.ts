import { expect, test } from "bun:test";
import { createStorageAccess } from "@/lib/storage-access";

let id = 0;
const database = () => `isolated-initialization-test-${++id}`;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("cold stores sharing a database initialize serially, then normal operations remain parallel", async () => {
    const name = database();
    let initializing = 0, active = 0, peak = 0;
    const release = Promise.withResolvers<void>(), allStarted = Promise.withResolvers<void>();
    const store = () => createStorageAccess(name, async () => {
        expect(initializing).toBe(0); initializing++;
        await Promise.resolve(); initializing--;
    });
    const a = store(), b = store();
    const operations = [a, b, a, b].map(access => access.run(async () => {
        expect(initializing).toBe(0); active++; peak = Math.max(peak, active);
        if (active === 4) allStarted.resolve();
        await release.promise; active--;
    }));
    await allStarted.promise;
    expect(peak).toBe(4);
    release.resolve();
    await Promise.all(operations);
});

test("a late store upgrade drains active transactions and blocks new ones until ready", async () => {
    const name = database(), events: string[] = [];
    const running = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>(), releaseUpgrade = Promise.withResolvers<void>();
    const images = createStorageAccess(name, async () => {});
    const first = images.run(async () => { events.push("image:start"); running.resolve(); await releaseWrite.promise; events.push("image:end"); });
    await running.promise;
    const thumbnails = createStorageAccess(name, async () => { events.push("upgrade:start"); await releaseUpgrade.promise; events.push("upgrade:end"); });
    const thumbnail = thumbnails.run(async () => { events.push("thumbnail:write"); });
    const nextImage = images.run(async () => { events.push("image:next"); });
    await tick(); expect(events).toEqual(["image:start"]);
    releaseWrite.resolve(); await first; await tick();
    expect(events).toEqual(["image:start", "image:end", "upgrade:start"]);
    releaseUpgrade.resolve(); await Promise.all([thumbnail, nextImage]);
    expect(events.indexOf("image:next")).toBeGreaterThan(events.indexOf("upgrade:end"));
    expect(events.indexOf("thumbnail:write")).toBeGreaterThan(events.indexOf("upgrade:end"));
});

test("a failed active transaction cannot deadlock a later store initialization", async () => {
    const name = database(), release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const a = createStorageAccess(name, async () => {});
    const writing = a.run(async () => { started.resolve(); await release.promise; throw new Error("quota"); }).catch(error => error.message);
    await started.promise;
    const b = createStorageAccess(name, async () => {});
    const reading = b.run(async () => "available");
    release.resolve();
    expect(await writing).toBe("quota"); expect(await reading).toBe("available");
});

test("initialization failure never executes its operation or poisons a different store", async () => {
    const name = database();
    const failed = createStorageAccess(name, async () => { throw new Error("blocked upgrade"); });
    let wrote = false;
    await expect(failed.run(async () => { wrote = true; })).rejects.toThrow("blocked upgrade");
    expect(wrote).toBe(false);
    const good = createStorageAccess(name, async () => {});
    expect(await good.run(async () => 7)).toBe(7);
});

test("one employee database initialization does not block another partition", async () => {
    const release = Promise.withResolvers<void>();
    const a = createStorageAccess(database(), () => release.promise);
    const blocked = a.run(async () => "a");
    const b = createStorageAccess(database(), async () => {});
    expect(await b.run(async () => "b")).toBe("b");
    release.resolve(); expect(await blocked).toBe("a");
});
