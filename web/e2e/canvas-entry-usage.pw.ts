import { expect, newCanvas, test } from "./fixtures";
import type { UsageClientEvent } from "../../shared/usage-analytics";

test("opening the creation panel records one anonymous entry counter without submitting a task", async ({ page, context, api }, info) => {
    const seen: UsageClientEvent[] = [];
    await context.route("**/api/usage/events", async route => {
        const { events } = route.request().postDataJSON() as { events: UsageClientEvent[] };
        seen.push(...events);
        await route.fulfill({ json: { code: 0, data: { accepted: events.length, duplicates: 0 }, msg: "" } });
    });
    await context.route("**/api/usage/me*", route => route.fulfill({ json: { code: 0, data: { boards: [], controls: [], coverage: {} }, msg: "" } }));
    await context.route("**/api/generation-capabilities?**", route => route.fulfill({ json: { models: [] } }));
    await page.setViewportSize({ width: 1366, height: 768 });
    const project = await newCanvas(page);
    await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    const panel = page.getByTestId("canvas-quick-generate-panel");
    await expect(panel).toBeVisible();
    await panel.locator("textarea").first().fill("只改袖口，不记录这句话");
    await expect.poll(() => seen.filter(row => row.controlKey === "canvas_entry_open.quick-panel").length).toBe(1);
    const [event] = seen.filter(row => row.controlKey === "canvas_entry_open.quick-panel");
    expect(event).toMatchObject({ boardKey: "canvas", action: "open" });
    expect(Object.keys(event!).sort()).toEqual(["action", "boardKey", "controlKey", "eventId", "occurredAt"]);
    expect(JSON.stringify(seen)).not.toContain(project);
    expect(JSON.stringify(seen)).not.toContain("只改袖口");
    expect(api.submissions).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("canvas-entry.png") });
});
