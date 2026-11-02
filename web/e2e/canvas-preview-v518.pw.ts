import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-preview-v518.fixture.tsx"></script></body></html>`;
const bytes = readFileSync(resolve(import.meta.dirname, "media/reference.png"));
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function routes(page: Page, thumb: (route: Route, count: number) => unknown) {
    let thumbnails = 0, originals = 0;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname === "/__preview") return route.fulfill({ contentType: "text/html", body: fixture });
        if (url.pathname.endsWith("/thumb")) { expect(url.searchParams.get("pending")).toBe("1"); return thumb(route, ++thumbnails); }
        if (url.pathname.endsWith("/content")) { originals++; return route.fulfill({ contentType: "image/png", body: bytes }); }
        return route.continue();
    });
    return { thumbnails: () => thumbnails, originals: () => originals, errors };
}

test("all three real preview consumers wait, then display derivatives without reading original; explicit edge 0 retains original bytes", async ({ page }) => {
    const counts = await routes(page, (route, count) => count <= 3 ? route.fulfill({ status: 202, headers: { "Retry-After": "1" } }) : route.fulfill({ contentType: "image/png", body: bytes }));
    await page.goto("/__preview");
    await expect.poll(counts.thumbnails).toBe(3);
    expect(counts.originals()).toBe(0);
    for (const alt of ["node", "simple", "persisted"]) await expect(page.getByAltText(alt, { exact: true })).toHaveAttribute("src", /^blob:/);
    expect(counts.thumbnails()).toBe(6); expect(counts.originals()).toBe(0);
    await page.getByRole("button", { name: "original", exact: true }).click();
    await expect(page.getByAltText("node", { exact: true })).toHaveAttribute("src", /\/content$/);
    await expect.poll(counts.originals).toBe(1);
    const downloaded = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("/api/assets/11111111-1111-4111-8111-111111111111/content")).arrayBuffer())));
    expect(hash(new Uint8Array(downloaded))).toBe(hash(bytes));
    expect(counts.errors).toEqual([]);
});

test("terminal 422 shows node failure and never falls back to original for any consumer", async ({ page }) => {
    const counts = await routes(page, route => route.fulfill({ status: 422 }));
    await page.goto("/__preview");
    await expect(page.getByTestId("node")).toHaveAttribute("data-failed", "true");
    expect(counts.thumbnails()).toBe(3); expect(counts.originals()).toBe(0);
    await expect(page.locator("img")).toHaveCount(0);
    expect(counts.errors).toEqual([]);
});

test("corrupt cloud derivative does not trigger original fallback", async ({ page }) => {
    const counts = await routes(page, route => route.fulfill({ contentType: "image/webp", body: "invalid-image" }));
    await page.goto("/__preview");
    await expect(page.getByTestId("node")).toHaveAttribute("data-failed", "true");
    expect(counts.thumbnails()).toBe(3); expect(counts.originals()).toBe(0); expect(counts.errors).toEqual([]);
    // An explicit original request remains usable even when its initial small
    // placeholder cannot decode; that is not a lightweight-preview fallback.
    await page.getByRole("button", { name: "original", exact: true }).click();
    await expect(page.getByAltText("node", { exact: true })).toHaveAttribute("src", /\/content$/);
    await expect.poll(counts.originals).toBe(1);
});

test("pending previews stop at the total deadline without original fallback", async ({ page }) => {
    await page.clock.install();
    const counts = await routes(page, route => route.fulfill({ status: 202, headers: { "Retry-After": "10" } }));
    await page.goto("/__preview"); await expect.poll(counts.thumbnails).toBe(3);
    await page.clock.fastForward(31_000);
    await expect(page.getByTestId("node")).toHaveAttribute("data-failed", "true");
    expect(counts.originals()).toBe(0); expect(counts.thumbnails()).toBeLessThanOrEqual(6); expect(counts.errors).toEqual([]);
});

test("unmount cancels pending backoff and makes no further requests", async ({ page }) => {
    await page.clock.install();
    const counts = await routes(page, route => route.fulfill({ status: 202, headers: { "Retry-After": "10" } }));
    await page.goto("/__preview"); await expect.poll(counts.thumbnails).toBe(3);
    await page.getByRole("button", { name: "toggle", exact: true }).click();
    await page.clock.fastForward(31_000);
    expect(counts.thumbnails()).toBe(3); expect(counts.originals()).toBe(0); expect(counts.errors).toEqual([]);
});

test("account switch clears ready employee previews and refuses the new account's denied reads", async ({ page }) => {
    let denied = false;
    const counts = await routes(page, route => denied ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: "image/png", body: bytes }));
    await page.goto("/__preview");
    for (const alt of ["node", "simple", "persisted"]) await expect(page.getByAltText(alt, { exact: true })).toHaveAttribute("src", /^blob:/);
    const oldUrl = await page.getByAltText("node", { exact: true }).getAttribute("src");
    denied = true;
    await page.getByRole("button", { name: "other account", exact: true }).click();
    await expect(page.locator("img")).toHaveCount(0);
    await expect(page.getByTestId("node")).toHaveAttribute("data-failed", "true");
    expect(await page.evaluate(url => fetch(url!).then(() => true, () => false), oldUrl)).toBe(false);
    expect(counts.thumbnails()).toBe(6); expect(counts.originals()).toBe(0); expect(counts.errors).toEqual([]);
});
