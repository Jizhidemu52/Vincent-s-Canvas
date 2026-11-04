import { expect, test } from "bun:test";
import { createCanvasEditLease, nextCanvasEditLease, resumeCanvasEditLease, CANVAS_EDIT_LEASE_MS } from "@/lib/canvas/canvas-edit-lease";

test("lease policy excludes live foreign owners, rejects expired renewals and recovers expired owners", () => {
    const current = { tab: "one", expiresAt: 100 };
    expect(nextCanvasEditLease(current, "two", 99, false)).toBeNull();
    expect(nextCanvasEditLease(current, "two", 99, true)).toBeNull();
    expect(nextCanvasEditLease(current, "one", 100, true)).toBeNull();
    expect(nextCanvasEditLease(current, "two", 100, false)).toEqual({ tab: "two", expiresAt: 100 + CANVAS_EDIT_LEASE_MS });
    expect(nextCanvasEditLease(undefined, "one", 100, true)).toBeNull();
    expect(nextCanvasEditLease(undefined, "one", 100, false)?.tab).toBe("one");
});

test("resume retains an uninterrupted owner's draft but never steals or recreates a lost lease", () => {
    expect(resumeCanvasEditLease({ tab: "one", expiresAt: 100 }, "one", 20_000)).toEqual({ tab: "one", expiresAt: 20_000 + CANVAS_EDIT_LEASE_MS });
    expect(resumeCanvasEditLease({ tab: "two", expiresAt: 100 }, "one", 20_000)).toBeNull();
    expect(resumeCanvasEditLease(undefined, "one", 20_000)).toBeNull();
    expect(resumeCanvasEditLease({ tab: "one", expiresAt: 30_000 }, "one", 20_000)?.tab).toBe("one");
});

for (const failure of ["error", "blocked"] as const) {
    test(`failed IDB ${failure} opens are retryable and late successful connections are closed`, async () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
        const requests: IDBOpenDBRequest[] = [];
        let closed = 0;
        Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
            open: () => {
                const request = { error: new DOMException("fixture unavailable", "UnknownError"), result: { close: () => { closed++; } } } as unknown as IDBOpenDBRequest;
                requests.push(request);
                queueMicrotask(() => {
                    const handler = failure === "error" ? request.onerror : request.onblocked;
                    handler?.call(request, new Event(failure) as IDBVersionChangeEvent);
                });
                return request;
            },
        } });
        try {
            const client = createCanvasEditLease("open-retry-test");
            await expect(client.claim("project", "tab")).rejects.toThrow();
            await expect(client.claim("project", "tab")).rejects.toThrow();
            expect(requests).toHaveLength(2);
            requests[0].onsuccess?.call(requests[0], new Event("success"));
            expect(closed).toBe(1);
            client.close();
        } finally {
            if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
            else Reflect.deleteProperty(globalThis, "indexedDB");
        }
    });
}
