import { expect, test } from "bun:test";

import { cacheObjectUrl, releaseObjectUrl, releaseUnusedObjectUrls } from "@/lib/object-url-cache";

test("releases a replaced object URL exactly once", () => {
    const released: string[] = [];
    const urls = new Map<string, string>();

    cacheObjectUrl(urls, "image:one", "blob:first", (url) => released.push(url));
    cacheObjectUrl(urls, "image:one", "blob:second", (url) => released.push(url));

    expect(urls.get("image:one")).toBe("blob:second");
    expect(released).toEqual(["blob:first"]);
});

test("releases a cached URL when its key is removed", () => {
    const released: string[] = [];
    const urls = new Map<string, string>();
    cacheObjectUrl(urls, "image:keep", "blob:keep", (url) => released.push(url));
    cacheObjectUrl(urls, "video:stale", "blob:stale", (url) => released.push(url));

    releaseObjectUrl(urls, "video:stale", (url) => released.push(url));

    expect(urls.get("video:stale")).toBeUndefined();
    expect(released).toEqual(["blob:stale"]);
});

test("releases only stale cached URLs while preserving reusable stored files", () => {
    const released: string[] = [];
    const urls = new Map<string, string>([
        ["image:current", "blob:current"],
        ["image:asset", "blob:asset"],
        ["image:previous-project", "blob:previous"],
    ]);

    releaseUnusedObjectUrls(urls, new Set(["image:current", "image:asset"]), (url) => released.push(url));

    expect(Array.from(urls.keys())).toEqual(["image:current", "image:asset"]);
    expect(released).toEqual(["blob:previous"]);
});
