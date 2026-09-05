import { expect, test } from "bun:test";

import { createDedupedAsyncResolver } from "@/lib/deduped-async-resolver";

test("shares an in-flight lookup for the same storage key", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const resolve = createDedupedAsyncResolver(async (key: string) => {
        calls += 1;
        await gate;
        return `${key}-url`;
    });

    const first = resolve("image:shared");
    const second = resolve("image:shared");
    const other = resolve("image:other");

    expect(first).toBe(second);
    expect(calls).toBe(2);
    release();
    await expect(Promise.all([first, second, other])).resolves.toEqual(["image:shared-url", "image:shared-url", "image:other-url"]);
});

test("releases a failed lookup so a later request can retry", async () => {
    let attempts = 0;
    const resolve = createDedupedAsyncResolver(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
        return "recovered";
    });

    await expect(resolve("image:retry")).rejects.toThrow("temporary failure");
    await expect(resolve("image:retry")).resolves.toBe("recovered");
    expect(attempts).toBe(2);
});
