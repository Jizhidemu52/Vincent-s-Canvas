import { test, expect } from "@playwright/test";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-connections-fixture.tsx"></script></body></html>`;

test("themed Canvas and SVG connections preserve direction and fixed arrow size at every zoom", async ({ context, page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/__connections") return route.fulfill({ contentType: "text/html", body: fixture });
        return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    await page.goto("/__connections");
    const arrow = page.locator('[data-connection-arrow="edge-2"]');
    await expect(arrow).toBeVisible();
    const reverse = page.locator('[data-connection-id="edge-5"]');
    expect((await reverse.getAttribute("d"))?.match(/ C /g)).toHaveLength(3);
    const styles = await page.locator("[data-connection-visual]").evaluateAll(elements => elements.map(element => ({ color: element.getAttribute("stroke"), dash: element.getAttribute("stroke-dasharray") })));
    expect(new Set(styles.slice(0, 5).map(style => JSON.stringify(style))).size).toBe(5);
    for (const scale of [0.25, 0.5, 1, 2]) {
        await page.getByRole("button", { name: `${scale * 100}%`, exact: true }).click();
        const dimensions = await arrow.evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; });
        expect(dimensions.width).toBeCloseTo(8, 1);
        expect(dimensions.height).toBeCloseTo(8, 1);
        if (scale === 0.25) await page.screenshot({ path: info.outputPath("connection-overview.png") });
    }
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.screenshot({ path: info.outputPath("connections-light.png") });
    // The path midpoint sits in the exterior corridor, not behind either card.
    const midpoint = await reverse.evaluate(element => { const path = element as SVGPathElement; const point = path.getPointAtLength(path.getTotalLength() / 2); const screen = point.matrixTransform(path.getScreenCTM()!); return { x: screen.x, y: screen.y }; });
    await page.mouse.click(midpoint.x, midpoint.y);
    await expect(page.getByTestId("selection")).toHaveText("edge-5");
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await expect(page.getByTestId("theme")).toHaveText("dark");
    await page.screenshot({ path: info.outputPath("connections-dark.png") });
    expect(errors).toEqual([]);
});
