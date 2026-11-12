import { test, expect } from "./fixtures";

const ease = "cubic-bezier(0.2, 0.7, 0.2, 1)";

test("creative pin describes and reaches Home recent shortcuts in both languages", async ({ page, api }, info) => {
    await page.context().route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0 } }));
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/creative");
    const pin = page.locator("main.creative-page").getByRole("button", { name: "固定图案定位", exact: true });
    await expect(pin).toHaveText("固定到首页最近使用");
    await pin.click();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "工作台", exact: true }).click();
    await expect(page.getByRole("region", { name: "最近使用", exact: true }).getByRole("link", { name: "已固定 图案定位", exact: true })).toHaveAttribute("href", "/creative/pattern-placement");
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("region", { name: "固定入口" })).toHaveCount(0);
    await page.goto("/creative");
    await expect(page.getByRole("button", { name: "取消固定图案定位", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("language-switch").click();
    await expect(page.locator("main.creative-page button[aria-pressed='false']").first()).toHaveText("Pin to Recently used on Home");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("creative-pin-mobile-en.png"), fullPage: true });
    expect(api.submissions).toEqual([]);
    expect(api.batchSubmissions).toEqual([]);
});

test("creative examples reserve their original ratio and fade only when loaded", async ({ page, api }, info) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/design-examples/knit-source.webp", async route => { await held; await route.continue(); });
    try {
        await page.goto("/creative", { waitUntil: "domcontentloaded" });
        const image = page.locator('.creative-cover > img[src="/design-examples/knit-source.webp"]');
        await image.scrollIntoViewIfNeeded();
        await expect(image).toHaveAttribute("data-loaded", "false");
        const loading = await image.evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth, background: getComputedStyle(element).backgroundColor,
            fit: getComputedStyle(element).objectFit, ratio: getComputedStyle(element.parentElement!).aspectRatio }));
        expect(loading.width).toBe(0);
        expect(loading.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(loading.fit).toBe("contain");
        expect(loading.ratio).toBe("1.5 / 1");
        release();
        await expect(image).toHaveAttribute("data-loaded", "true");
        await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        const loaded = await image.evaluate(element => ({ name: getComputedStyle(element).animationName, duration: getComputedStyle(element).animationDuration,
            easing: getComputedStyle(element).animationTimingFunction, src: element.getAttribute("src") }));
        expect(loaded).toEqual({ name: "wb-image-enter", duration: "0.16s", easing: ease, src: "/design-examples/knit-source.webp" });
        await page.screenshot({ path: info.outputPath("creative-loaded-1366.png") });
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await image.evaluate(element => Number.parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(.001);
    } finally { release(); }
    expect(api.submissions).toEqual([]);
});

test("navigation and creative cards share 120ms hover, 80ms press and the AntD curve", async ({ page, api }) => {
    await page.context().route("**/api/prompt-templates?*", route => route.fulfill({ json: { templates: [], total: 0 } }));
    await page.goto("/creative");
    for (const { target, properties, duration } of [
        { target: page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "自由画布", exact: true }), properties: "background-color, color, scale", duration: "0.12s, 0.12s, 0.08s" },
        { target: page.locator(".creative-card").first(), properties: "border-color, transform", duration: "0.12s, 0.12s" },
    ]) {
        await target.hover();
        const hovered = await target.evaluate(element => ({ properties: getComputedStyle(element).transitionProperty, duration: getComputedStyle(element).transitionDuration, easing: getComputedStyle(element).transitionTimingFunction }));
        expect(hovered).toEqual({ properties, duration, easing: properties.split(", ").map(() => ease).join(", ") });
        await page.mouse.down();
        try { expect((await target.evaluate(element => getComputedStyle(element).transitionDuration)).split(", ").every(value => value === "0.08s")).toBe(true); }
        finally { await page.mouse.move(1, 1); await page.mouse.up(); }
    }
    await page.goto("/assets");
    const button = page.getByRole("button", { name: "添加", exact: true });
    await expect(button).toBeVisible();
    for (const token of ["motion-ease-out-circ", "motion-ease-in-out-circ", "motion-ease-out", "motion-ease-in-out", "motion-ease-out-back", "motion-ease-in-back", "motion-ease-in-quint", "motion-ease-out-quint"]) {
        const value = await button.evaluate((element, key) => getComputedStyle(element).getPropertyValue(`--ant-${key}`).trim(), token);
        expect(value.replaceAll(" ", "")).toBe("cubic-bezier(.2,.7,.2,1)");
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await button.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(.001);
    expect(api.submissions).toEqual([]);
});
